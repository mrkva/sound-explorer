const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow;
let audioServer;
let sessionFiles = []; // [{filePath, dataOffset, dataSize, bytesPerSample, channels, sampleRate}]

// ── File descriptor cache (avoids open/close per PCM chunk read) ──────────
const fdCache = new Map(); // filePath → { fd: fs.promises.FileHandle, timer }
const FD_CACHE_TTL = 10000; // Close idle FDs after 10 seconds

async function getCachedFd(filePath) {
  let entry = fdCache.get(filePath);
  if (entry) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => closeCachedFd(filePath), FD_CACHE_TTL);
    return entry.fd;
  }
  const fd = await fs.promises.open(filePath, 'r');
  const timer = setTimeout(() => closeCachedFd(filePath), FD_CACHE_TTL);
  fdCache.set(filePath, { fd, timer });
  return fd;
}

function closeCachedFd(filePath) {
  const entry = fdCache.get(filePath);
  if (entry) {
    clearTimeout(entry.timer);
    entry.fd.close().catch(() => {});
    fdCache.delete(filePath);
  }
}

function closeAllCachedFds() {
  for (const [filePath] of fdCache) {
    closeCachedFd(filePath);
  }
}
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
    title: 'Sound Explorer v0.3.0',
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

    // Read in chunks (max ~2MB source, aligned to source block size)
    const MAX_SRC_READ = Math.floor((2 * 1024 * 1024) / srcBlockAlign) * srcBlockAlign;
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
 * Read one source sample as a normalized float (-1.0 to +1.0).
 */
function readSampleFloat(srcBuf, offset, srcBits, isFloat) {
  if (srcBits === 16) {
    return srcBuf.readInt16LE(offset) / 32768;
  } else if (srcBits === 24) {
    const b0 = srcBuf[offset];
    const b1 = srcBuf[offset + 1];
    const b2 = srcBuf[offset + 2];
    let val24 = (b2 << 16) | (b1 << 8) | b0;
    if (val24 >= 0x800000) val24 -= 0x1000000;
    return val24 / 8388608;
  } else if (srcBits === 32 && isFloat) {
    return srcBuf.readFloatLE(offset);
  } else if (srcBits === 32) {
    return srcBuf.readInt32LE(offset) / 2147483648;
  }
  return 0;
}

/**
 * Convert source PCM buffer to 16-bit PCM with optional decimation.
 * Handles 16-bit, 24-bit, 32-bit integer, and 32-bit float sources.
 * When decFactor > 1, applies a moving-average (boxcar) anti-alias filter
 * over D consecutive samples before decimating, preventing ultrasonic
 * frequencies from folding into the audible range.
 */
function convert16bit(srcBuf, numSamples, channels, srcBits, srcFormat, decFactor = 1) {
  const outSamples = Math.floor(numSamples / decFactor);
  const outBuf = Buffer.alloc(outSamples * channels * 2);
  const srcBytesPerSample = srcBits / 8;
  const srcBlockAlign = channels * srcBytesPerSample;
  const isFloat = (srcFormat === 3);

  if (decFactor <= 1) {
    // No decimation — direct conversion, no filter needed
    for (let o = 0; o < outSamples; o++) {
      for (let ch = 0; ch < channels; ch++) {
        const srcOff = (o * channels + ch) * srcBytesPerSample;
        if (srcOff + srcBytesPerSample > srcBuf.length) break;
        const sample16 = Math.max(-32768, Math.min(32767,
          Math.round(readSampleFloat(srcBuf, srcOff, srcBits, isFloat) * 32767)));
        outBuf.writeInt16LE(sample16, (o * channels + ch) * 2);
      }
    }
  } else {
    // Decimation with anti-alias filter: average D consecutive samples per channel
    const D = decFactor;
    const invD = 1 / D;
    for (let o = 0; o < outSamples; o++) {
      const baseIdx = o * D;
      for (let ch = 0; ch < channels; ch++) {
        let sum = 0;
        const lastSample = Math.min(baseIdx + D, numSamples);
        for (let k = baseIdx; k < lastSample; k++) {
          const srcOff = (k * channels + ch) * srcBytesPerSample;
          if (srcOff + srcBytesPerSample > srcBuf.length) break;
          sum += readSampleFloat(srcBuf, srcOff, srcBits, isFloat);
        }
        const avg = sum * invD;
        const sample16 = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
        outBuf.writeInt16LE(sample16, (o * channels + ch) * 2);
      }
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

// Track files to open (from CLI args or OS file association)
let pendingFilePaths = [];

// Collect file paths from command-line arguments (for file associations)
const cliFiles = process.argv.slice(1).filter(arg => !arg.startsWith('-') && arg.toLowerCase().endsWith('.wav'));
if (cliFiles.length > 0) {
  pendingFilePaths = cliFiles.map(f => path.resolve(f));
}

// macOS: open-file event fires before and after app is ready
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('open-files', [filePath]);
  } else {
    pendingFilePaths.push(filePath);
  }
});

app.whenReady().then(async () => {
  createWindow();

  // Send any pending files after window loads
  if (pendingFilePaths.length > 0) {
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('open-files', pendingFilePaths);
      pendingFilePaths = [];
    });
  }
});

app.on('window-all-closed', () => {
  closeAllCachedFds();
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

// Check if a file exists
ipcMain.handle('file-exists', async (event, filePath) => {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch { return false; }
});

// Write a text file
ipcMain.handle('write-file', async (event, filePath, content) => {
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return true;
});

// Write binary data to a file
ipcMain.handle('write-binary-file', async (event, filePath, data) => {
  await fs.promises.writeFile(filePath, Buffer.from(data));
  return true;
});

// Read a text file
ipcMain.handle('read-text-file', async (event, filePath) => {
  return await fs.promises.readFile(filePath, 'utf-8');
});

// Export a WAV segment: read raw PCM from source file(s) and write a new WAV
/**
 * Write a WAV file from PCM segments with optional bext metadata.
 * Shared by both native and resampled export handlers.
 * @param {Array} segments - [{filePath, dataOffset, startByte, endByte, bitsPerSample, channels, format}]
 * @param {string} outputPath
 * @param {number} sampleRate - sample rate to write in the WAV header
 * @param {object|null} bextMeta - optional BWF metadata
 */
async function writeWavFromSegments(segments, outputPath, sampleRate, bextMeta) {
  const ref = segments[0];

  let totalDataBytes = 0;
  for (const seg of segments) {
    totalDataBytes += seg.endByte - seg.startByte;
  }

  const bitsPerSample = ref.bitsPerSample;
  const channels = ref.channels;
  const format = ref.format || 1;
  const isFloat = (format === 3);
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  // Build bext chunk if timecode metadata is available
  let bextChunk = null;
  if (bextMeta) {
    const BEXT_SIZE = 602; // Fixed bext chunk size (v0, no coding history)
    bextChunk = Buffer.alloc(BEXT_SIZE + 8); // +8 for chunk ID + size
    bextChunk.write('bext', 0);
    bextChunk.writeUInt32LE(BEXT_SIZE, 4);
    bextChunk.write((bextMeta.description || '').slice(0, 256).padEnd(256, '\0'), 8, 'ascii');
    bextChunk.write((bextMeta.originator || '').slice(0, 32).padEnd(32, '\0'), 264, 'ascii');
    bextChunk.write((bextMeta.originatorReference || '').slice(0, 32).padEnd(32, '\0'), 296, 'ascii');
    bextChunk.write((bextMeta.originationDate || '').slice(0, 10).padEnd(10, '\0'), 328, 'ascii');
    bextChunk.write((bextMeta.originationTime || '').slice(0, 8).padEnd(8, '\0'), 338, 'ascii');
    const timeRef = Math.max(0, bextMeta.timeReference || 0);
    const timeLow = timeRef % 0x100000000;
    const timeHigh = Math.floor(timeRef / 0x100000000);
    bextChunk.writeUInt32LE(timeLow >>> 0, 346);
    bextChunk.writeUInt32LE(timeHigh >>> 0, 350);
    bextChunk.writeUInt16LE(0, 354);
  }

  const bextSize = bextChunk ? bextChunk.length : 0;
  const fmtSize = 16;
  const headerSize = 12 + (8 + fmtSize) + bextSize + 8;

  const header = Buffer.alloc(headerSize);
  let pos = 0;

  header.write('RIFF', pos); pos += 4;
  header.writeUInt32LE(Math.min(headerSize - 8 + totalDataBytes, 0xFFFFFFFF), pos); pos += 4;
  header.write('WAVE', pos); pos += 4;

  header.write('fmt ', pos); pos += 4;
  header.writeUInt32LE(fmtSize, pos); pos += 4;
  header.writeUInt16LE(isFloat ? 3 : 1, pos); pos += 2;
  header.writeUInt16LE(channels, pos); pos += 2;
  header.writeUInt32LE(sampleRate, pos); pos += 4;
  header.writeUInt32LE(byteRate, pos); pos += 4;
  header.writeUInt16LE(blockAlign, pos); pos += 2;
  header.writeUInt16LE(bitsPerSample, pos); pos += 2;

  if (bextChunk) {
    bextChunk.copy(header, pos);
    pos += bextChunk.length;
  }

  header.write('data', pos); pos += 4;
  header.writeUInt32LE(Math.min(totalDataBytes, 0xFFFFFFFF), pos); pos += 4;

  const outFd = await fs.promises.open(outputPath, 'w');
  try {
    let writePos = 0;
    await outFd.write(header, 0, header.length, writePos);
    writePos += header.length;

    const CHUNK_SIZE = 4 * 1024 * 1024;
    const readBuf = Buffer.allocUnsafe(CHUNK_SIZE);
    for (const seg of segments) {
      const srcFd = await fs.promises.open(seg.filePath, 'r');
      try {
        let remaining = seg.endByte - seg.startByte;
        let srcPos = seg.dataOffset + seg.startByte;
        while (remaining > 0) {
          const toRead = Math.min(CHUNK_SIZE, remaining);
          const { bytesRead } = await srcFd.read(readBuf, 0, toRead, srcPos);
          if (bytesRead === 0) break;
          await outFd.write(readBuf, 0, bytesRead, writePos);
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
}

ipcMain.handle('export-wav-segment', async (event, segments, outputPath, bextMeta) => {
  const sampleRate = segments[0].sampleRate;
  return writeWavFromSegments(segments, outputPath, sampleRate, bextMeta);
});

// Export WAV with modified sample rate (for speed-shifted export).
// Same raw PCM data but header declares a different sample rate,
// so playback in any DAW/player reproduces at that speed.
ipcMain.handle('export-wav-resampled', async (event, segments, outputPath, targetSampleRate, bextMeta) => {
  const result = await writeWavFromSegments(segments, outputPath, targetSampleRate, bextMeta);
  result.targetSampleRate = targetSampleRate;
  return result;
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
  const stat = await fd.stat();
  // Read up to 1MB to handle files with large metadata before the data chunk
  const headerSize = Math.min(1024 * 1024, stat.size);
  const headerBuf = Buffer.alloc(headerSize);
  await fd.read(headerBuf, 0, headerSize, 0);
  await fd.close();
  return {
    header: headerBuf.buffer.slice(headerBuf.byteOffset, headerBuf.byteOffset + headerBuf.byteLength),
    fileSize: stat.size
  };
});

// Read a chunk of raw PCM data from a specific file (for spectrogram computation)
// Uses FD cache to avoid open/close overhead on repeated reads from the same file.
ipcMain.handle('read-pcm-chunk', async (event, filePath, dataOffset, byteOffset, byteLength) => {
  const fd = await getCachedFd(filePath);
  const buf = Buffer.alloc(byteLength);
  const { bytesRead } = await fd.read(buf, 0, byteLength, dataOffset + byteOffset);
  const result = buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead);
  return result;
});

// Read multiple small scattered windows from a file in a single IPC call.
// windows: [{byteOffset, byteLength}], returns concatenated ArrayBuffer.
ipcMain.handle('read-pcm-scattered', async (event, filePath, dataOffset, windows) => {
  const fd = await getCachedFd(filePath);
  let totalBytes = 0;
  for (const w of windows) totalBytes += w.byteLength;
  const out = Buffer.alloc(totalBytes);
  let pos = 0;
  // Read all windows concurrently from the same fd
  const promises = windows.map((w, i) => {
    const offset = pos;
    pos += w.byteLength;
    return fd.read(out, offset, w.byteLength, dataOffset + w.byteOffset);
  });
  await Promise.all(promises);
  return out.buffer.slice(out.byteOffset, out.byteOffset + totalBytes);
});

// Set up the audio server for a session and return the URL
ipcMain.handle('setup-audio-server', async (event, files, requestedOutputRate) => {
  closeAllCachedFds(); // Close FDs from previous session
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
  const stat = await fd.stat();
  // Read up to 1MB to handle files with large metadata before the data chunk
  const headerSize = Math.min(1024 * 1024, stat.size);
  const buf = Buffer.alloc(headerSize);
  await fd.read(buf, 0, headerSize, 0);
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
      // For files >4GB the data chunk size may be wrong (uint32 wraps),
      // or may be 0xFFFFFFFF sentinel. Estimate from file size.
      if (result.dataSize === 0 || result.dataSize === 0xFFFFFFFF || result.dataSize > stat.size - chunkData) {
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

// ── iXML chunk read/write ───────────────────────────────────────────────

/**
 * Read the raw iXML chunk string from a WAV file.
 * Returns the XML string or null if no iXML chunk found.
 */
async function readIXMLFromFile(filePath) {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    // Read RIFF header (12 bytes)
    const headerBuf = Buffer.alloc(12);
    await fd.read(headerBuf, 0, 12, 0);

    if (headerBuf.toString('ascii', 0, 4) !== 'RIFF' || headerBuf.toString('ascii', 8, 12) !== 'WAVE') {
      return null;
    }

    // Walk chunks by seeking — don't buffer the whole file
    const chunkHeader = Buffer.alloc(8);
    let offset = 12;

    while (offset + 8 <= stat.size) {
      const { bytesRead } = await fd.read(chunkHeader, 0, 8, offset);
      if (bytesRead < 8) break;

      const chunkId = chunkHeader.toString('ascii', 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const chunkData = offset + 8;

      if (!/^[\x20-\x7E]{4}$/.test(chunkId) || chunkSize >= 0xFFFFFFF0) break;

      if (chunkId === 'iXML' || chunkId === 'IXML') {
        // Read iXML chunk body (up to 2MB)
        const readSize = Math.min(chunkSize, 2 * 1024 * 1024);
        const xmlBuf = Buffer.alloc(readSize);
        await fd.read(xmlBuf, 0, readSize, chunkData);
        let xmlStr = xmlBuf.toString('utf-8');
        // Strip trailing nulls
        const nullIdx = xmlStr.indexOf('\0');
        if (nullIdx >= 0) xmlStr = xmlStr.slice(0, nullIdx);
        return xmlStr.trim();
      }

      // Skip to next chunk (chunks are 2-byte aligned)
      offset = chunkData + chunkSize;
      if (offset % 2 !== 0) offset++;
    }
    return null;
  } finally {
    await fd.close();
  }
}

ipcMain.handle('read-ixml', async (event, filePath) => {
  return await readIXMLFromFile(filePath);
});

/**
 * Inject or replace the iXML chunk in a WAV file.
 * Reads the file, strips existing iXML, appends new one, updates RIFF size.
 * Writes to a temp file first, then atomically renames to prevent corruption.
 */
async function writeIXMLToFile(filePath, ixmlString) {
  const ixmlBuf = Buffer.from(ixmlString, 'utf-8');

  const data = await fs.promises.readFile(filePath);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a valid WAV file');
  }

  // Rebuild: copy all chunks except existing iXML, then append new iXML
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= data.length) {
    const chunkId = data.toString('ascii', offset, offset + 4);
    const chunkSize = data.readUInt32LE(offset + 4);
    let totalChunk = 8 + chunkSize;
    if (chunkSize % 2 === 1) totalChunk++; // RIFF pad byte

    if (!/^[\x20-\x7E]{4}$/.test(chunkId) || chunkSize >= 0xFFFFFFF0) break;

    if (chunkId !== 'iXML' && chunkId !== 'IXML') {
      chunks.push(data.subarray(offset, offset + totalChunk));
    }
    offset += totalChunk;
  }

  // Build new iXML chunk
  const ixmlChunkSize = ixmlBuf.length;
  const ixmlPadded = ixmlChunkSize % 2 === 1;
  const ixmlChunk = Buffer.alloc(8 + ixmlChunkSize + (ixmlPadded ? 1 : 0));
  ixmlChunk.write('iXML', 0, 4, 'ascii');
  ixmlChunk.writeUInt32LE(ixmlChunkSize, 4);
  ixmlBuf.copy(ixmlChunk, 8);

  // Calculate total size
  let totalSize = 12; // RIFF + size + WAVE
  for (const chunk of chunks) totalSize += chunk.length;
  totalSize += ixmlChunk.length;

  // Write to temp file first, then atomically rename
  const tmpPath = filePath + '.tmp';
  const out = Buffer.alloc(totalSize);
  let pos = 0;
  out.write('RIFF', pos); pos += 4;
  out.writeUInt32LE(Math.min(totalSize - 8, 0xFFFFFFFF), pos); pos += 4;
  out.write('WAVE', pos); pos += 4;

  for (const chunk of chunks) {
    chunk.copy(out, pos);
    pos += chunk.length;
  }
  ixmlChunk.copy(out, pos);

  await fs.promises.writeFile(tmpPath, out);
  await fs.promises.rename(tmpPath, filePath);
  return { success: true, ixmlSize: ixmlChunkSize };
}

ipcMain.handle('write-ixml', async (event, filePath, ixmlString) => {
  return await writeIXMLToFile(filePath, ixmlString);
});

/**
 * Read iXML from all WAV files in a folder, return first one found.
 * Used for auto-loading session metadata from any file in the session.
 */
ipcMain.handle('read-ixml-from-folder', async (event, folderPath) => {
  const entries = await fs.promises.readdir(folderPath);
  const wavFiles = entries
    .filter(f => /\.(wav|wave|bwf)$/i.test(f))
    .sort();

  for (const fname of wavFiles) {
    const filePath = path.join(folderPath, fname);
    const xml = await readIXMLFromFile(filePath);
    if (xml && xml.includes('<BWFXML')) {
      return { filePath, xml };
    }
  }
  return null;
});

/**
 * Write iXML to all WAV files in a folder.
 */
ipcMain.handle('write-ixml-to-folder', async (event, folderPath, ixmlString) => {
  const entries = await fs.promises.readdir(folderPath);
  const wavFiles = entries
    .filter(f => /\.(wav|wave|bwf)$/i.test(f))
    .sort()
    .map(f => path.join(folderPath, f));

  const results = [];
  for (const filePath of wavFiles) {
    try {
      await writeIXMLToFile(filePath, ixmlString);
      results.push({ filePath, success: true });
    } catch (err) {
      results.push({ filePath, success: false, error: err.message });
    }
  }
  return results;
});
