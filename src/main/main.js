const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

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
  createWindow();
  if (app.isPackaged) setUpAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
