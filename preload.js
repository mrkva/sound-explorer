const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  scanFiles: (filePaths) => ipcRenderer.invoke('scan-files', filePaths),
  exportWavSegment: (segments, outputPath) => ipcRenderer.invoke('export-wav-segment', segments, outputPath),
  readFileHeader: (filePath) => ipcRenderer.invoke('read-file-header', filePath),
  readPcmChunk: (filePath, dataOffset, byteOffset, byteLength) =>
    ipcRenderer.invoke('read-pcm-chunk', filePath, dataOffset, byteOffset, byteLength),
  setupAudioServer: (files) => ipcRenderer.invoke('setup-audio-server', files)
});
