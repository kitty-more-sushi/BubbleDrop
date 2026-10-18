'use strict';
// BubbleDrop for Windows: Electron shell around the shared engine + web UI.
const { app, BrowserWindow, Tray, Menu, dialog, shell, Notification, nativeImage, clipboard, ipcMain, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { Engine } = require('./core/engine');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}
app.setAppUserModelId('app.bubbledrop.desktop');

const ICON = path.join(__dirname, 'assets', 'icon.png');
const TRAY = path.join(__dirname, 'assets', 'tray.png');
// Dev runs use ../web directly; the packaged app carries its own copy.
const WEB_DIR = [path.join(__dirname, '..', 'web'), path.join(__dirname, 'web')].find((p) => fs.existsSync(path.join(p, 'index.html')));
const THEMES = { dark: { color: '#140b1c', symbolColor: '#fcf0ff' }, light: { color: '#fff3f9', symbolColor: '#3b2142' } };

let win = null;
let tray = null;
let engine = null;
let quitting = false;
let blocker = null;
let toldAboutTray = false;

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsVerbatimArguments: true, windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stdout || stderr || err.message).toString().trim()));
      else resolve(stdout.toString());
    });
  });
}

const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

// Joins a Wi-Fi network (e.g. the phone's BubbleDrop hotspot) through netsh.
async function joinWifi(ssidIn, pass) {
  if (process.platform !== 'win32') throw new Error('Joining Wi-Fi from the app only works on Windows');
  const ssid = String(ssidIn || '').replace(/"/g, '').trim();
  if (!ssid) throw new Error('Type the hotspot name first');
  const open = !pass;
  const xml = `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEsc(ssid)}</name>
  <SSIDConfig><SSID><name>${xmlEsc(ssid)}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>
    <authEncryption><authentication>${open ? 'open' : 'WPA2PSK'}</authentication><encryption>${open ? 'none' : 'AES'}</encryption><useOneX>false</useOneX></authEncryption>
    ${open ? '' : `<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEsc(pass)}</keyMaterial></sharedKey>`}
  </security></MSM>
</WLANProfile>`;
  const file = path.join(os.tmpdir(), `bubbledrop-wifi-${Date.now()}.xml`);
  fs.writeFileSync(file, xml);
  try {
    await run('netsh', ['wlan', 'add', 'profile', `filename="${file}"`, 'user=current']);
    await run('netsh', ['wlan', 'connect', `name="${ssid}"`]);
  } catch (e) {
    throw new Error(/no wireless interface|wlansvc|not running/i.test(e.message) ? 'This PC has no Wi-Fi adapter turned on' : e.message);
  } finally {
    fs.unlink(file, () => {});
  }
  return { message: `Joining ${ssid}… your phone should appear in a few seconds` };
}

const hooks = {
  caps: { dragDrop: true, pickFolder: true, pickMedia: false, apps: false, hotspot: false, joinWifi: process.platform === 'win32', scanQr: false, chooseSaveDir: true, tray: true },
  pick: async (kind) => {
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'Pick folders to send' : 'Pick files to send',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  },
  openPath: (p) => shell.openPath(p),
  showInFolder: (p) => shell.showItemInFolder(p),
  copyText: (t) => clipboard.writeText(t),
  notify: (title, body, extra = {}) => {
    if (win && win.isVisible() && win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: ICON });
    n.on('click', () => {
      showWindow();
      if (extra.reveal) shell.showItemInFolder(extra.reveal);
    });
    n.show();
    if (win && extra.rid) win.flashFrame(true);
  },
  action: async (op, b) => {
    if (op === 'choose-save-dir') {
      const r = await dialog.showOpenDialog(win, { title: 'Save received files to…', defaultPath: engine.settings.saveDir, properties: ['openDirectory', 'createDirectory'] });
      if (!r.canceled && r.filePaths[0]) engine.setSaveDir(r.filePaths[0]);
      return { ok: true };
    }
    if (op === 'join-wifi') return joinWifi(b.ssid, b.password);
    if (op === 'open-url') {
      if (/^https?:\/\//i.test(String(b.url))) shell.openExternal(String(b.url));
      return { ok: true };
    }
    if (op === 'quit') {
      quitting = true;
      setTimeout(() => app.quit(), 60);
      return { ok: true };
    }
    return undefined;
  },
};

function createWindow() {
  const theme = THEMES[engine.settings.theme === 'light' ? 'light' : 'dark'];
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    show: false,
    title: 'BubbleDrop',
    icon: ICON,
    backgroundColor: theme.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...theme, height: 34 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  win.removeMenu();
  const home = `http://127.0.0.1:${engine.port}/ui/`;
  win.loadURL(home);
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  if (process.env.BD_SNAPSHOT) {
    // Self-check used during development: save a screenshot of the window, then quit.
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.BD_SNAPSHOT, img.toPNG());
      const ok = await win.webContents.executeJavaScript('!!(window.bd && window.bd.electron && document.querySelector(".radar"))');
      console.log('snapshot saved; preload+ui ok =', ok);
      quitting = true;
      app.quit();
    }, 3000));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(home)) e.preventDefault(); });
  win.on('focus', () => win.flashFrame(false));
  win.on('close', (e) => {
    if (quitting || !engine.settings.minimizeToTray) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'BubbleDrop is still here 🫧', body: 'It keeps running in the tray so nearby devices can send you files.', icon: ICON }).show();
    }
  });
  win.on('closed', () => { win = null; });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(TRAY));
  tray.setToolTip('BubbleDrop: ready to receive');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open BubbleDrop', click: showWindow },
    { label: 'Open received files', click: () => { fs.mkdirSync(engine.settings.saveDir, { recursive: true }); shell.openPath(engine.settings.saveDir); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

ipcMain.on('theme', (_e, t) => {
  if (!win || !THEMES[t]) return;
  try { win.setTitleBarOverlay({ ...THEMES[t], height: 34 }); } catch { /* not supported */ }
  win.setBackgroundColor(THEMES[t].color);
});
ipcMain.on('attention', () => {
  if (!win) return;
  if (!win.isVisible()) win.showInactive();
  if (!win.isFocused()) win.flashFrame(true);
});
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url)); });

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  engine = new Engine({ dataDir: app.getPath('userData'), webDir: WEB_DIR, hooks });
  engine.on('busy', (busy) => {
    if (busy && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
    if (tray) tray.setToolTip(busy ? 'BubbleDrop: transferring…' : 'BubbleDrop: ready to receive');
  });
  try {
    await engine.start();
  } catch (e) {
    dialog.showErrorBox('BubbleDrop could not start', String(e && e.message ? e.message : e));
    app.exit(1);
    return;
  }
  createTray();
  createWindow();
});

app.on('window-all-closed', () => { /* keep running in the tray */ });

let stopped = false;
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', (e) => {
  if (stopped || !engine) return;
  e.preventDefault();
  stopped = true;
  engine.stop().catch(() => {}).finally(() => app.quit());
});
