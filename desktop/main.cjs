const { app, BrowserWindow, net, protocol, session } = require('electron');
const { basename, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const playerURL = new URL('recorder://player/');
const siteDirectory = join(app.getAppPath(), 'dist');

protocol.registerSchemesAsPrivileged([{
  scheme: 'recorder',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

function loadAsset(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.hostname !== 'player') return new Response(null, { status: 404 });

  const asset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (asset !== 'index.html' && !/^assets\/[a-z0-9][a-z0-9.-]*$/i.test(asset)) {
    return new Response(null, { status: 404 });
  }
  return net.fetch(pathToFileURL(join(siteDirectory, asset)).href);
}

async function createWindow(playerSession) {
  const win = new BrowserWindow({
    width: 1260,
    height: 980,
    minWidth: 540,
    minHeight: 580,
    backgroundColor: '#f4f6f9',
    webPreferences: {
      session: playerSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  await win.loadURL(playerURL.href);
}

app.whenReady().then(async () => {
  const { languageFor, messagesFor } = await import('../src/i18n.js');
  const language = languageFor(app.getPreferredSystemLanguages()[0] || app.getLocale());
  const messages = messagesFor(language);
  playerURL.searchParams.set('locale', language);
  const playerSession = session.fromPartition('recorder-desktop');
  playerSession.protocol.handle('recorder', loadAsset);
  playerSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  playerSession.setPermissionCheckHandler(() => false);
  playerSession.on('will-download', (event, item) => {
    if (!item.getURL().startsWith('blob:recorder://player/') || item.getMimeType() !== 'video/mp4') {
      event.preventDefault();
      return;
    }
    const filename = basename(item.getFilename());
    item.setSaveDialogOptions({
      title: messages.saveTitle,
      defaultPath: join(app.getPath('downloads'), filename),
      filters: [{ name: messages.saveFileType, extensions: ['mp4'] }],
      dontAddToRecent: true
    });
  });
  await createWindow(playerSession);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(playerSession);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
