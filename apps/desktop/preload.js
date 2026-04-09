const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  saveFileDialog: (options) => ipcRenderer.invoke('save-file-dialog', options),
  fileExists: (filePath) => ipcRenderer.invoke('file-exists', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  writeBinaryFile: (filePath, data) => ipcRenderer.invoke('write-binary-file', filePath, data),
  saveTempFile: (fileName, data) => ipcRenderer.invoke('save-temp-file', fileName, data),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),
  scanFiles: (filePaths) => ipcRenderer.invoke('scan-files', filePaths),
  exportWavSegment: (segments, outputPath, bextMeta) => ipcRenderer.invoke('export-wav-segment', segments, outputPath, bextMeta),
  exportWavResampled: (segments, outputPath, targetSampleRate, bextMeta) => ipcRenderer.invoke('export-wav-resampled', segments, outputPath, targetSampleRate, bextMeta),
  readFileHeader: (filePath) => ipcRenderer.invoke('read-file-header', filePath),
  readPcmChunk: (filePath, dataOffset, byteOffset, byteLength) =>
    ipcRenderer.invoke('read-pcm-chunk', filePath, dataOffset, byteOffset, byteLength),
  readPcmScattered: (filePath, dataOffset, windows) =>
    ipcRenderer.invoke('read-pcm-scattered', filePath, dataOffset, windows),
  setupAudioServer: (files, outputRate) => ipcRenderer.invoke('setup-audio-server', files, outputRate),
  onOpenFiles: (callback) => ipcRenderer.on('open-files', (_event, filePaths) => callback(filePaths)),

  // iXML metadata
  readIXML: (filePath) => ipcRenderer.invoke('read-ixml', filePath),
  writeIXML: (filePath, ixmlString) => ipcRenderer.invoke('write-ixml', filePath, ixmlString),
  readIXMLFromFolder: (folderPath) => ipcRenderer.invoke('read-ixml-from-folder', folderPath),
  writeIXMLToFolder: (folderPath, ixmlString) => ipcRenderer.invoke('write-ixml-to-folder', folderPath, ixmlString),
});
