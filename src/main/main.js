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

  // Ask the renderer before closing so unsaved score edits aren't silently
  // discarded (see app.js's onCloseRequested — it's the only side that knows
  // whether there are unsaved changes, via its undo-history position).
  let allowClose = false;
  const onCloseResponse = (event, action) => {
    if (event.sender !== win.webContents) return;
    if (action === 'close') {
      allowClose = true;
      win.close();
    }
  };
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    win.webContents.send('close-requested');
  });
  ipcMain.on('close-response', onCloseResponse);
  win.on('closed', () => ipcMain.removeListener('close-response', onCloseResponse));
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
  // Without explicit options printToPDF defaults to Letter with its own
  // margins, which doesn't match the A4-proportioned pages the renderer lays
  // out — the score came out rescaled and clipped. preferCSSPageSize honors
  // the stylesheet's own `@page { size: A4; margin: 0 }` instead, and
  // printBackground is needed for anything the score draws as a fill.
  const pdfData = await event.sender.printToPDF({
    pageSize: 'A4',
    landscape: false,
    printBackground: true,
    preferCSSPageSize: true,
    margins: {
      top: 0, bottom: 0, left: 0, right: 0,
    },
  });
  await fs.promises.writeFile(filePath, pdfData);
  return { canceled: false, filePath };
});

// ---------- 楽譜ファイルの保存/読み込み ----------
//
// These exist so the app can do a real 上書き保存. The renderer used to save by
// creating a Blob and clicking a hidden <a download>, which always dropped a
// new file in the downloads folder — saving three times left score.json,
// score(1).json and score(2).json, and there was no way to write back over the
// file you had opened. Going through the main process means the renderer can
// hold on to a path and save straight to it.

const SCORE_FILTERS = [{ name: '楽譜ファイル', extensions: ['json'] }];

ipcMain.handle('save-score-as', async (event, defaultFileName, contents) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '名前を付けて保存',
    defaultPath: defaultFileName || '楽譜.json',
    filters: SCORE_FILTERS,
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, contents, 'utf-8');
  return { canceled: false, filePath };
});

ipcMain.handle('save-score-to', async (event, filePath, contents) => {
  await fs.promises.writeFile(filePath, contents, 'utf-8');
  return { canceled: false, filePath };
});

ipcMain.handle('open-score', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '楽譜を開く',
    filters: SCORE_FILTERS,
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  const filePath = filePaths[0];
  const contents = await fs.promises.readFile(filePath, 'utf-8');
  return { canceled: false, filePath, contents };
});

// MIDI / WAV. `data` arrives as an ArrayBuffer over IPC and is written as-is.
ipcMain.handle('save-binary-as', async (event, defaultFileName, filters, data) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '書き出し',
    defaultPath: defaultFileName,
    filters,
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, Buffer.from(data));
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
