const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with contextIsolation/sandbox on (see main.js), so it has
// no direct access to Node/Electron APIs — printToPDF and the native save
// dialog only exist in the main process. This is the one narrow bridge the
// PDF export button (see app.js's btn-export-pdf) needs.
contextBridge.exposeInMainWorld('electronAPI', {
  exportPdf: (defaultFileName) => ipcRenderer.invoke('export-pdf', defaultFileName),
  // Close-confirmation flow: main.js intercepts the window's close button and
  // asks the renderer (which alone knows whether there are unsaved changes)
  // before actually closing — see main.js's 'close' handler and app.js's
  // onCloseRequested handler.
  onCloseRequested: (callback) => ipcRenderer.on('close-requested', callback),
  respondClose: (action) => ipcRenderer.send('close-response', action),
});
