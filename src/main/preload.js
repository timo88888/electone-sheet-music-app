const { contextBridge, ipcRenderer } = require('electron');

// The renderer runs with contextIsolation/sandbox on (see main.js), so it has
// no direct access to Node/Electron APIs — printToPDF and the native save
// dialog only exist in the main process. This is the one narrow bridge the
// PDF export button (see app.js's btn-export-pdf) needs.
contextBridge.exposeInMainWorld('electronAPI', {
  exportPdf: (defaultFileName) => ipcRenderer.invoke('export-pdf', defaultFileName),
  // Score file I/O. Going through the main process (rather than a browser
  // download + <input type="file">) is what makes 上書き保存 possible at all:
  // the renderer can remember the path it last read or wrote and save straight
  // back to it, instead of dropping a new numbered copy in the downloads
  // folder every time.
  saveScoreAs: (defaultFileName, contents) => ipcRenderer.invoke('save-score-as', defaultFileName, contents),
  saveScoreTo: (filePath, contents) => ipcRenderer.invoke('save-score-to', filePath, contents),
  openScore: () => ipcRenderer.invoke('open-score'),
  // Binary exports (MIDI / WAV) use the same native save dialog.
  saveBinaryAs: (defaultFileName, filters, data) => ipcRenderer.invoke('save-binary-as', defaultFileName, filters, data),
  // Close-confirmation flow: main.js intercepts the window's close button and
  // asks the renderer (which alone knows whether there are unsaved changes)
  // before actually closing — see main.js's 'close' handler and app.js's
  // onCloseRequested handler.
  onCloseRequested: (callback) => ipcRenderer.on('close-requested', callback),
  respondClose: (action) => ipcRenderer.send('close-response', action),
});
