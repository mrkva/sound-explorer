const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let mainWindow;
let audioServer;
let sessionFiles = []; // [{filePath, dataOffset, dataSize, bytesPerSample, channels, sampleRate}]
let totalDataBytes = 0;

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

      // Build a virtual WAV header for the stitched file
      const wavHeader = buildWavHeader(
        totalDataBytes,
        ref.channels,
        ref.sampleRate,
        ref.bitsPerSample
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

  // Serve from stitched data files
  let dataPos = pos - headerLen;
  const dataEnd = end - headerLen;

  // Walk through files to find and serve the right bytes
  let cumulative = 0;
  for (const file of sessionFiles) {
    if (dataPos > dataEnd) break;

    const fileStart = cumulative;
    const fileEnd = cumulative + file.dataSize;
    cumulative = fileEnd;

    // Skip files before our range
    if (fileEnd <= dataPos) continue;

    // Calculate what to read from this file
    const offsetInFile = Math.max(0, dataPos - fileStart);
    const availableInFile = file.dataSize - offsetInFile;
    const needed = dataEnd - dataPos + 1;
    const readLen = Math.min(availableInFile, needed);

    if (readLen <= 0) continue;

    // Read in reasonable chunks (max 1MB) to avoid huge allocations
    const MAX_READ = 1024 * 1024;
    let fileReadOffset = offsetInFile;
    let remaining = readLen;

    const fd = await fs.promises.open(file.filePath, 'r');
    try {
      while (remaining > 0) {
        const chunkLen = Math.min(remaining, MAX_READ);
        const buf = Buffer.alloc(chunkLen);
        const { bytesRead } = await fd.read(buf, 0, chunkLen, file.dataOffset + fileReadOffset);
        if (bytesRead === 0) break;
        if (!res.writable) break;
        res.write(bytesRead < chunkLen ? buf.slice(0, bytesRead) : buf);
        fileReadOffset += bytesRead;
        remaining -= bytesRead;
        dataPos += bytesRead;
      }
    } finally {
      await fd.close();
    }
  }
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

// Open single file dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'WAV Audio', extensions: ['wav', 'wave', 'bwf'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  return result.filePaths[0];
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
ipcMain.handle('setup-audio-server', async (event, files) => {
  sessionFiles = files;
  totalDataBytes = files.reduce((sum, f) => sum + f.dataSize, 0);
  const port = await startAudioServer();
  return `http://127.0.0.1:${port}/audio`;
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
