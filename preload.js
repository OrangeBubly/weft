const { contextBridge, ipcRenderer } = require('electron');

// Exposed as `window.loom` (the app's original name) to keep the renderer API stable.
contextBridge.exposeInMainWorld('loom', {
  platform: process.platform,
  version: ipcRenderer.sendSync('app:version'),
  getVault: () => ipcRenderer.invoke('vault:get'),
  chooseVault: () => ipcRenderer.invoke('vault:choose'),
  revealVault: () => ipcRenderer.invoke('vault:reveal'),
  listNotes: () => ipcRenderer.invoke('notes:list'),
  writeNote: (rel, content) => ipcRenderer.invoke('note:write', rel, content),
  writeNoteSync: (rel, content) => ipcRenderer.sendSync('note:writeSync', rel, content),
  createNote: (rel, content) => ipcRenderer.invoke('note:create', rel, content),
  renameNote: (from, to) => ipcRenderer.invoke('note:rename', from, to),
  deleteNote: (rel) => ipcRenderer.invoke('note:delete', rel),
  createFolder: (rel) => ipcRenderer.invoke('folder:create', rel),
  setTheme: (t) => ipcRenderer.invoke('theme:set', t),
  saveFile: (opts) => ipcRenderer.invoke('export:save', opts),
  exportGraphHtml: (payload) => ipcRenderer.invoke('export:graphHtml', payload),
  onVaultChanged: (cb) => ipcRenderer.on('vault:changed', () => cb()),
});
