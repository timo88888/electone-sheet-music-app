const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with contextIsolation/sandbox on (see main.js), so it has
// no direct access to Node/Electron APIs — printToPDF and the native save
// dialog only exist in the main process. This is the one narrow bridge the
// PDF export button (see app.js's btn-export-pdf) needs.
contextBridge.exposeInMainWorld('electronAPI', {
  exportPdf: (defaultFileName) => ipcRenderer.invoke('export-pdf', defaultFileName),
});
