const {
  app, BrowserWindow, dialog, ipcMain, Menu,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// PDF書き出し (separate from 印刷/window.print(), see app.js's btn-export-pdf)
// — printToPDF only exists on webContents in the main process, so the
// sandboxed/contextIsolated renderer reaches it through this IPC handler
// (see preload.js) rather than calling it directly. Reuses the same
// @media print CSS window.print() does, so page numbers etc. match.
ipcMain.handle('export-pdf', async (event, defaultFileName) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'PDFとして書き出し',
    defaultPath: defaultFileName || '楽譜.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  const pdfData = await event.sender.printToPDF({});
  fs.writeFileSync(filePath, pdfData);
  return { canceled: false, filePath };
});

// Checks GitHub Releases (see package.json's build.publish config) for a
// newer version, downloads it in the background, then asks the user to
// restart once it's ready. Only meaningful for an installed/packaged build —
// `npm start` has no update metadata to check against and would just log a
// harmless "not packaged" style error, so it's skipped entirely in dev.
function setUpAutoUpdater() {
  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'アップデートの準備ができました',
      message: '新しいバージョンをダウンロードしました。再起動して更新しますか？',
      buttons: ['再起動して更新', '後で'],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (err) => {
    console.error('自動アップデートの確認に失敗しました:', err);
  });
  autoUpdater.checkForUpdates();
}

app.whenReady().then(() => {
  // Without this, Electron's default application menu registers native
  // accelerators for Ctrl+Z/Shift+Ctrl+Z/Ctrl+X/C/V bound to
  // webContents.undo()/redo()/cut()/copy()/paste() — those intercept the
  // keystroke at the menu level before it ever reaches the renderer's own
  // keydown handling (see app.js's copy/cut/paste/undo/redo shortcuts),
  // which is why they only seemed to work while focus was inside a
  // contentEditable text box (the one case where Electron's built-in
  // action actually does something) and not for score-level selections.
  Menu.setApplicationMenu(null);
  createWindow();
  if (app.isPackaged) setUpAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
