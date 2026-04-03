const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openFilesDialog: () => ipcRenderer.invoke('open-files-dialog'),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  scanFiles: (filePaths) => ipcRenderer.invoke('scan-files', filePaths),
  readFileHeader: (filePath) => ipcRenderer.invoke('read-file-header', filePath),
  readPcmChunk: (filePath, dataOffset, byteOffset, byteLength) =>
    ipcRenderer.invoke('read-pcm-chunk', filePath, dataOffset, byteOffset, byteLength),
  setupAudioServer: (files) => ipcRenderer.invoke('setup-audio-server', files)
});
