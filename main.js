const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow;
let audioServer;
let sessionFiles = []; // [{filePath, dataOffset, dataSize, bytesPerSample, channels, sampleRate}]
let totalDataBytes = 0;    // Total bytes in the *output* (16-bit) stream
let sessionBitsPerSample = 16;  // Source bits per sample
let sessionFormat = 1;          // 1=PCM, 3=IEEE float
let sessionChannels = 2;
let sessionSampleRate = 48000;
let outputSampleRate = 48000;   // Rate sent to browser (may differ from source)
let decimationFactor = 1;       // Source samples per output sample

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Field Recording Explorer',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
}

// ── Local HTTP server for streaming audio across multiple files ──────────
// Presents all session files as one continuous WAV file.
// Supports Range requests for seeking.

function startAudioServer() {
  return new Promise((resolve) => {
    if (audioServer) {
      audioServer.close();
    }

    audioServer = http.createServer(async (req, res) => {
      if (sessionFiles.length === 0) {
        res.writeHead(404);
        res.end();
        return;
      }

      const ref = sessionFiles[0];
      const wavHeaderSize = 44;
      const totalSize = wavHeaderSize + totalDataBytes;

      // Always output 16-bit PCM at the output sample rate for browser compatibility
      const wavHeader = buildWavHeader(
        totalDataBytes,
        ref.channels,
        outputSampleRate,
        16  // Output is always 16-bit
      );

      // Parse Range header
      const rangeHeader = req.headers.range;
      let start = 0;
      // For non-range requests on huge files, only serve the header + first chunk
      // to avoid trying to stream 43GB in one response
      let end = rangeHeader ? totalSize - 1 : Math.min(totalSize - 1, 1024 * 1024);

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          start = parseInt(match[1], 10);
          end = match[2] ? parseInt(match[2], 10) : Math.min(start + 2 * 1024 * 1024, totalSize - 1);
          end = Math.min(end, totalSize - 1);
        }
      }

      const chunkSize = end - start + 1;

      // Always respond with 206 Partial Content for range-capable seeking
      if (rangeHeader) {
        res.writeHead(206, {
          'Content-Type': 'audio/wav',
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
      } else {
        // Initial request - report full size but only send a chunk
        // This tells the browser the total size for seeking
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Access-Control-Allow-Origin': '*'
        });
      }

      // Serve bytes from virtual file (header + stitched data)
      try {
        await serveBytes(res, wavHeader, start, end);
      } catch (err) {
        if (err.code !== 'ERR_STREAM_DESTROYED') {
          console.error('Stream error:', err.message);
        }
      }
      res.end();
    });

    audioServer.listen(0, '127.0.0.1', () => {
      const port = audioServer.address().port;
      console.log(`Audio server on port ${port}`);
      resolve(port);
    });
  });
}

async function serveBytes(res, wavHeader, start, end) {
  const headerLen = wavHeader.byteLength;
  let pos = start;

  // Serve from WAV header if needed
  if (pos < headerLen) {
    const headerEnd = Math.min(end, headerLen - 1);
    const slice = Buffer.from(new Uint8Array(wavHeader).slice(pos, headerEnd + 1));
    res.write(slice);
    pos = headerEnd + 1;
  }

  if (pos > end) return;

  // Output is 16-bit PCM, possibly decimated.
  // With decimation, each output sample corresponds to `decimationFactor` source samples.
  const srcBytesPerSample = sessionBitsPerSample / 8;
  const srcBlockAlign = sessionChannels * srcBytesPerSample;
  const outBlockAlign = sessionChannels * 2; // 16-bit output
  const D = decimationFactor;

  // dataPos/dataEnd are in OUTPUT (16-bit, decimated) byte space
  let dataPos = pos - headerLen;
  const dataEnd = end - headerLen;

  // Calculate cumulative output bytes per file
  let cumOutBytes = 0;
  for (const file of sessionFiles) {
    if (dataPos > dataEnd) break;

    const fileSrcSamples = Math.floor(file.dataSize / srcBlockAlign);
    const fileOutSamples = Math.floor(fileSrcSamples / D);
    const fileOutBytes = fileOutSamples * outBlockAlign;
    const fileOutEnd = cumOutBytes + fileOutBytes;

    // Skip files before our range
    if (fileOutEnd <= dataPos) {
      cumOutBytes = fileOutEnd;
      continue;
    }

    // Calculate what output bytes to produce from this file
    const outOffsetInFile = Math.max(0, dataPos - cumOutBytes);
    const outNeeded = Math.min(dataEnd - dataPos + 1, fileOutEnd - dataPos);

    if (outNeeded <= 0) {
      cumOutBytes = fileOutEnd;
      continue;
    }

    // Convert output sample offset to source sample offset (accounting for decimation)
    const startOutSample = Math.floor(outOffsetInFile / outBlockAlign);
    const endOutSample = Math.ceil((outOffsetInFile + outNeeded) / outBlockAlign);
    const outSamplesToMake = endOutSample - startOutSample;

    // Source samples: each output sample comes from every D-th source sample
    const startSrcSample = startOutSample * D;
    const srcSamplesToRead = outSamplesToMake * D;
    const srcByteOffset = startSrcSample * srcBlockAlign;
    const srcByteLen = srcSamplesToRead * srcBlockAlign;

    // Read in chunks (max 2MB source)
    const MAX_SRC_READ = 2 * 1024 * 1024;
    let srcRead = 0;
    let outProduced = 0;

    const fd = await fs.promises.open(file.filePath, 'r');
    try {
      while (srcRead < srcByteLen) {
        const chunkSrcLen = Math.min(MAX_SRC_READ, srcByteLen - srcRead);
        const srcBuf = Buffer.alloc(chunkSrcLen);
        const { bytesRead } = await fd.read(srcBuf, 0, chunkSrcLen, file.dataOffset + srcByteOffset + srcRead);
        if (bytesRead === 0) break;
        if (!res.writable) break;

        // Convert to 16-bit with decimation
        const srcSamplesInChunk = Math.floor(bytesRead / srcBlockAlign);
        const outBuf = convert16bit(srcBuf, srcSamplesInChunk, sessionChannels, sessionBitsPerSample, sessionFormat, D);

        // Handle partial start/end within output
        let outStart = 0;
        let outEnd = outBuf.length;

        if (outProduced === 0 && outOffsetInFile % outBlockAlign !== 0) {
          outStart = outOffsetInFile % outBlockAlign;
        }
        if (outProduced + outBuf.length - outStart > outNeeded) {
          outEnd = outStart + (outNeeded - outProduced);
        }

        res.write(outStart > 0 || outEnd < outBuf.length
          ? outBuf.slice(outStart, outEnd) : outBuf);

        outProduced += outEnd - outStart;
        srcRead += bytesRead;
        dataPos += outEnd - outStart;
      }
    } finally {
      await fd.close();
    }

    cumOutBytes = fileOutEnd;
  }
}

/**
 * Convert source PCM buffer to 16-bit PCM with optional decimation.
 * Handles 16-bit, 24-bit, 32-bit integer, and 32-bit float sources.
 * When decFactor > 1, takes every decFactor-th sample (simple decimation).
 */
function convert16bit(srcBuf, numSamples, channels, srcBits, srcFormat, decFactor = 1) {
  const outSamples = Math.floor(numSamples / decFactor);
  const outBuf = Buffer.alloc(outSamples * channels * 2);
  const srcBytesPerSample = srcBits / 8;
  const isFloat = (srcFormat === 3);

  for (let o = 0; o < outSamples; o++) {
    const i = o * decFactor; // source sample index
    for (let ch = 0; ch < channels; ch++) {
      const srcOff = (i * channels + ch) * srcBytesPerSample;
      const outOff = (o * channels + ch) * 2;

      if (srcOff + srcBytesPerSample > srcBuf.length) break;

      let sample16;
      if (srcBits === 16) {
        sample16 = srcBuf.readInt16LE(srcOff);
      } else if (srcBits === 24) {
        // 24-bit signed: take the top 16 bits
        const b1 = srcBuf[srcOff + 1];
        const b2 = srcBuf[srcOff + 2]; // MSB (signed)
        sample16 = (b2 << 8) | b1;
      } else if (srcBits === 32 && isFloat) {
        // 32-bit IEEE float (-1.0 to +1.0)
        const f = srcBuf.readFloatLE(srcOff);
        sample16 = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
      } else if (srcBits === 32) {
        // 32-bit integer: take top 16 bits
        sample16 = srcBuf.readInt32LE(srcOff) >> 16;
      } else {
        sample16 = 0;
      }

      outBuf.writeInt16LE(sample16, outOff);
    }
  }

  return outBuf;
}

function buildWavHeader(dataSize, channels, sampleRate, bitsPerSample) {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  // Use a safe size for the RIFF header (cap at 4GB - 36 for the header)
  const riffSize = Math.min(dataSize + 36, 0xFFFFFFFF);
  const dataChunkSize = Math.min(dataSize, 0xFFFFFFFF);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, riffSize, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataChunkSize, true);

  return header;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (audioServer) audioServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Open folder dialog
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder containing WAV files'
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Open file(s) dialog - supports single or multiple selection
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'WAV Audio', extensions: ['wav', 'wave', 'bwf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
});

// Save file dialog
ipcMain.handle('save-file-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: options.title || 'Save File',
    defaultPath: options.defaultPath || '',
    filters: options.filters || [{ name: 'All Files', extensions: ['*'] }]
  });
  if (result.canceled) return null;
  return result.filePath;
});

// Write a text file
ipcMain.handle('write-file', async (event, filePath, content) => {
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return true;
});

// Read a text file
ipcMain.handle('read-text-file', async (event, filePath) => {
  return await fs.promises.readFile(filePath, 'utf-8');
});

// Export a WAV segment: read raw PCM from source file(s) and write a new WAV
ipcMain.handle('export-wav-segment', async (event, segments, outputPath) => {
  // segments: [{filePath, dataOffset, startByte, endByte}]
  // All segments must have the same format (sample rate, channels, bits)
  const ref = segments[0];

  // Calculate total output data bytes
  let totalDataBytes = 0;
  for (const seg of segments) {
    totalDataBytes += seg.endByte - seg.startByte;
  }

  // Build WAV header (keep original format - no conversion)
  const bitsPerSample = ref.bitsPerSample;
  const channels = ref.channels;
  const sampleRate = ref.sampleRate;
  const format = ref.format || 1;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  // Use standard WAV header (44 bytes) for PCM, or extended for float
  const isFloat = (format === 3);
  const headerSize = isFloat ? 58 : 44;

  const header = Buffer.alloc(headerSize);
  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(Math.min(totalDataBytes + headerSize - 8, 0xFFFFFFFF), 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  if (isFloat) {
    header.writeUInt32LE(18, 16); // chunk size for float
    header.writeUInt16LE(3, 20);  // IEEE float
  } else {
    header.writeUInt32LE(16, 16); // chunk size for PCM
    header.writeUInt16LE(1, 20);  // PCM
  }
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  if (isFloat) {
    header.writeUInt16LE(0, 36); // cbSize
    // fact chunk could go here but most players don't need it
    header.write('data', 38);
    header.writeUInt32LE(Math.min(totalDataBytes, 0xFFFFFFFF), 42);
    // Pad remaining header bytes to 58
    header.write('data', headerSize - 8);
    header.writeUInt32LE(Math.min(totalDataBytes, 0xFFFFFFFF), headerSize - 4);
  } else {
    header.write('data', 36);
    header.writeUInt32LE(Math.min(totalDataBytes, 0xFFFFFFFF), 40);
  }

  // Write the file
  const outFd = await fs.promises.open(outputPath, 'w');
  try {
    // Write header
    await outFd.write(isFloat ? header.slice(0, 46) : header.slice(0, 44), 0, isFloat ? 46 : 44, 0);

    // Actually, let's keep it simple: always write standard PCM/float header
    const simpleHeader = Buffer.alloc(44);
    simpleHeader.write('RIFF', 0);
    simpleHeader.writeUInt32LE(Math.min(totalDataBytes + 36, 0xFFFFFFFF), 4);
    simpleHeader.write('WAVE', 8);
    simpleHeader.write('fmt ', 12);
    simpleHeader.writeUInt32LE(16, 16);
    simpleHeader.writeUInt16LE(isFloat ? 3 : 1, 20);
    simpleHeader.writeUInt16LE(channels, 22);
    simpleHeader.writeUInt32LE(sampleRate, 24);
    simpleHeader.writeUInt32LE(byteRate, 28);
    simpleHeader.writeUInt16LE(blockAlign, 32);
    simpleHeader.writeUInt16LE(bitsPerSample, 34);
    simpleHeader.write('data', 36);
    simpleHeader.writeUInt32LE(Math.min(totalDataBytes, 0xFFFFFFFF), 40);

    let writePos = 0;
    await outFd.write(simpleHeader, 0, 44, writePos);
    writePos += 44;

    // Copy raw PCM data from each segment
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB read chunks
    for (const seg of segments) {
      const srcFd = await fs.promises.open(seg.filePath, 'r');
      try {
        let remaining = seg.endByte - seg.startByte;
        let srcPos = seg.dataOffset + seg.startByte;

        while (remaining > 0) {
          const toRead = Math.min(CHUNK_SIZE, remaining);
          const buf = Buffer.alloc(toRead);
          const { bytesRead } = await srcFd.read(buf, 0, toRead, srcPos);
          if (bytesRead === 0) break;
          await outFd.write(buf, 0, bytesRead, writePos);
          writePos += bytesRead;
          srcPos += bytesRead;
          remaining -= bytesRead;
        }
      } finally {
        await srcFd.close();
      }
    }
  } finally {
    await outFd.close();
  }

  return { success: true, outputPath, totalDataBytes };
});

// Scan folder for WAV files and return their headers
ipcMain.handle('scan-folder', async (event, folderPath) => {
  const entries = await fs.promises.readdir(folderPath);
  const wavFiles = entries
    .filter(f => /\.(wav|wave|bwf)$/i.test(f))
    .sort()
    .map(f => path.join(folderPath, f));

  const results = [];
  for (const filePath of wavFiles) {
    try {
      const header = await readWavHeader(filePath);
      results.push({ filePath, ...header });
    } catch (err) {
      console.warn(`Skipping ${filePath}: ${err.message}`);
    }
  }
  return results;
});

// Scan specific file paths and return their headers
ipcMain.handle('scan-files', async (event, filePaths) => {
  const results = [];
  for (const filePath of filePaths) {
    try {
      const header = await readWavHeader(filePath);
      results.push({ filePath, ...header });
    } catch (err) {
      console.warn(`Skipping ${filePath}: ${err.message}`);
    }
  }
  return results;
});

// Read WAV file header (first 64KB for BWF metadata)
ipcMain.handle('read-file-header', async (event, filePath) => {
  const fd = await fs.promises.open(filePath, 'r');
  const headerBuf = Buffer.alloc(65536);
  await fd.read(headerBuf, 0, 65536, 0);
  const stat = await fd.stat();
  await fd.close();
  return {
    header: headerBuf.buffer.slice(headerBuf.byteOffset, headerBuf.byteOffset + headerBuf.byteLength),
    fileSize: stat.size
  };
});

// Read a chunk of raw PCM data from a specific file (for spectrogram computation)
ipcMain.handle('read-pcm-chunk', async (event, filePath, dataOffset, byteOffset, byteLength) => {
  const fd = await fs.promises.open(filePath, 'r');
  const buf = Buffer.alloc(byteLength);
  const { bytesRead } = await fd.read(buf, 0, byteLength, dataOffset + byteOffset);
  await fd.close();
  // Return only bytes actually read
  const result = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  return result;
});

// Set up the audio server for a session and return the URL
ipcMain.handle('setup-audio-server', async (event, files, requestedOutputRate) => {
  sessionFiles = files;
  const ref = files[0];
  sessionBitsPerSample = ref.bitsPerSample;
  sessionFormat = ref.format || 1;
  sessionChannels = ref.channels;
  sessionSampleRate = ref.sampleRate;

  // Determine output sample rate and decimation factor
  const MAX_OUTPUT_RATE = 48000;
  const targetRate = requestedOutputRate || Math.min(ref.sampleRate, MAX_OUTPUT_RATE);
  decimationFactor = Math.max(1, Math.round(ref.sampleRate / targetRate));
  outputSampleRate = Math.round(ref.sampleRate / decimationFactor);

  // Calculate total output samples across all files
  const srcBlockAlign = ref.channels * (ref.bitsPerSample / 8);
  const totalSrcBytes = files.reduce((sum, f) => sum + f.dataSize, 0);
  const totalSrcSamples = Math.floor(totalSrcBytes / srcBlockAlign);
  const totalOutSamples = Math.floor(totalSrcSamples / decimationFactor);

  // Output is always 16-bit for browser compatibility
  const outBlockAlign = ref.channels * 2; // 16-bit
  totalDataBytes = totalOutSamples * outBlockAlign;

  console.log(`Audio server: ${files.length} files, ${ref.sampleRate}Hz, ${ref.bitsPerSample}-bit ${ref.format === 3 ? 'float' : 'PCM'}, ${ref.channels}ch`);
  console.log(`Decimation: ${decimationFactor}x, output: ${outputSampleRate}Hz, ${totalOutSamples} samples, ${(totalDataBytes / 1e6).toFixed(1)} MB (16-bit)`);

  const port = await startAudioServer();
  return { url: `http://127.0.0.1:${port}/audio`, outputSampleRate, decimationFactor };
});

// ── WAV header parser (Node.js side) ─────────────────────────────────────

async function readWavHeader(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  const buf = Buffer.alloc(65536);
  await fd.read(buf, 0, 65536, 0);
  const stat = await fd.stat();
  await fd.close();

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (readStr(view, 0, 4) !== 'RIFF' || readStr(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  const result = {
    format: 0, sampleRate: 0, channels: 0, bitsPerSample: 0,
    dataOffset: 0, dataSize: 0, fileSize: stat.size,
    bext: null, originationTime: null, originationDate: null,
    timecodeReference: 0, startTimeOfDay: null
  };

  let offset = 12;
  while (offset + 8 <= buf.byteLength) {
    const chunkId = readStr(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;

    if (chunkId === 'fmt ') {
      result.format = view.getUint16(chunkData, true);
      result.channels = view.getUint16(chunkData + 2, true);
      result.sampleRate = view.getUint32(chunkData + 4, true);
      result.bitsPerSample = view.getUint16(chunkData + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: real format is in SubFormat GUID
      // Keep bitsPerSample as the container size for correct byte alignment.
      // wValidBitsPerSample tells us precision but doesn't change byte layout.
      if (result.format === 0xFFFE && chunkSize >= 40) {
        const validBits = view.getUint16(chunkData + 18, true);
        const subFormat = view.getUint16(chunkData + 24, true);
        result.format = subFormat; // 1=PCM, 3=IEEE float
        console.log(`WAVE_FORMAT_EXTENSIBLE: subformat=${subFormat}, container=${result.bitsPerSample}-bit, validBits=${validBits}`);
      }
    } else if (chunkId === 'data') {
      result.dataOffset = chunkData;
      result.dataSize = chunkSize;
      // For files >4GB the data chunk size may be wrong, estimate from file size
      if (result.dataSize === 0 || result.dataSize > stat.size) {
        result.dataSize = stat.size - chunkData;
      }
    } else if (chunkId === 'bext') {
      result.originationDate = readStr(view, chunkData + 320, 10).trim();
      result.originationTime = readStr(view, chunkData + 330, 8).trim();
      const timeLow = view.getUint32(chunkData + 338, true);
      const timeHigh = view.getUint32(chunkData + 342, true);
      result.timecodeReference = timeHigh * 0x100000000 + timeLow;
      result.bext = {
        description: readStr(view, chunkData, 256).trim(),
        originator: readStr(view, chunkData + 256, 32).trim(),
        originatorReference: readStr(view, chunkData + 288, 32).trim(),
        originationDate: result.originationDate,
        originationTime: result.originationTime,
        timeReference: result.timecodeReference
      };
    }

    offset = chunkData + chunkSize;
    if (offset % 2 !== 0) offset++;
  }

  // Compute start time of day
  if (result.timecodeReference > 0 && result.sampleRate > 0) {
    result.startTimeOfDay = result.timecodeReference / result.sampleRate;
  } else if (result.originationTime) {
    const parts = result.originationTime.split(':');
    if (parts.length >= 2) {
      result.startTimeOfDay = (parseInt(parts[0]) || 0) * 3600 +
        (parseInt(parts[1]) || 0) * 60 + (parseInt(parts[2]) || 0);
    }
  }

  return result;
}

function readStr(view, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    if (offset + i >= view.byteLength) break;
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
