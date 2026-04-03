const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// File open dialog
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

// Read file as ArrayBuffer
ipcMain.handle('read-file', async (event, filePath) => {
  const buffer = await fs.promises.readFile(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

// Read file metadata only (first 64KB for BWF header parsing)
ipcMain.handle('read-file-header', async (event, filePath) => {
  const fd = await fs.promises.open(filePath, 'r');
  const headerBuf = Buffer.alloc(65536);
  await fd.read(headerBuf, 0, 65536, 0);
  const stat = await fd.stat();
  await fd.close();
  return { header: headerBuf.buffer.slice(headerBuf.byteOffset, headerBuf.byteOffset + headerBuf.byteLength), fileSize: stat.size };
});
