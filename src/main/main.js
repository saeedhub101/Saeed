'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.avataragent.app');

const AV = { w: 420, h: 600 };
const DEFAULTS = {
  modelPath: null,
  modelYaw: 0,          // 0 = model faces +Z, 180 = model faces -Z
  boneMap: {},          // canonical bone id -> bone name in the GLB
  restPose: {},         // canonical bone id -> [x,y,z] degrees (model space)
  clips: {},            // user-made / edited motions
  overrides: {},        // clip -> bone -> axis fixes
  customRig: null,      // bones built by the Rig builder
  intents: {},          // optional intent -> clips overrides
  zoom: 1,
  fps: 30,
  clickThrough: true,
  windowPos: null,
  visible: true,
};

let cfg = { ...DEFAULTS };
let avatarWin = null, studioWin = null, tray = null;
const preload = path.join(__dirname, 'preload.js');
const page = (n) => path.join(__dirname, '..', 'renderer', n);
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');

function loadCfg() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; }
  catch { cfg = { ...DEFAULTS }; }
}
let saveTimer;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(cfgFile(), JSON.stringify(cfg, null, 2), () => {}), 300);
}
function broadcast(exceptContents) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents !== exceptContents) w.webContents.send('config:changed', cfg);
  }
}

/* ---------------- Avatar window ---------------- */
function startPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  const def = { x: wa.x + wa.width - AV.w - 20, y: wa.y + wa.height - AV.h };
  const p = cfg.windowPos;
  if (!p) return def;
  const cx = p.x + AV.w / 2, cy = p.y + AV.h / 2;
  const ok = screen.getAllDisplays().some((d) => cx >= d.bounds.x && cx <= d.bounds.x + d.bounds.width && cy >= d.bounds.y && cy <= d.bounds.y + d.bounds.height);
  return ok ? p : def;
}

function createAvatar() {
  const { x, y } = startPosition();
  avatarWin = new BrowserWindow({
    x, y, width: AV.w, height: AV.h,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  avatarWin.setAlwaysOnTop(true, 'screen-saver');
  avatarWin.loadFile(page('avatar.html'));
  avatarWin.once('ready-to-show', () => { if (cfg.visible) avatarWin.show(); });
  let t;
  avatarWin.on('moved', () => {
    clearTimeout(t);
    t = setTimeout(() => { const b = avatarWin.getBounds(); cfg.windowPos = { x: b.x, y: b.y }; saveCfg(); }, 400);
  });
}

function setVisible(v) {
  cfg.visible = v; saveCfg();
  if (!avatarWin || avatarWin.isDestroyed()) return;
  if (v) { avatarWin.show(); avatarWin.webContents.send('service', 'resume'); }
  else { avatarWin.webContents.send('service', 'pause'); avatarWin.hide(); }
  buildTray();
}

/* ---------------- Studio window ---------------- */
function openStudio(tab = 'bones') {
  if (studioWin && !studioWin.isDestroyed()) {
    studioWin.show(); studioWin.focus(); studioWin.webContents.send('studio:tab', tab); return;
  }
  studioWin = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1000, minHeight: 640,
    backgroundColor: '#14171c', title: 'Avatar Studio', autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  studioWin.removeMenu();
  studioWin.loadFile(page('studio.html'), { query: { tab } });
  studioWin.webContents.on('before-input-event', (_e, i) => {
    if (i.type === 'keyDown' && (i.key === 'F12' || (i.control && i.shift && i.key.toLowerCase() === 'i'))) studioWin.webContents.toggleDevTools();
  });
  studioWin.on('closed', () => { studioWin = null; });
}

/* ---------------- Model dialogs ---------------- */
async function pickModel() {
  const parent = studioWin && !studioWin.isDestroyed() ? studioWin : undefined;
  const r = await dialog.showOpenDialog(parent, {
    title: 'Choose a character', properties: ['openFile'],
    filters: [{ name: 'GLB model', extensions: ['glb'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  Object.assign(cfg, { modelPath: r.filePaths[0], boneMap: {}, restPose: {}, overrides: {}, customRig: null });
  saveCfg(); broadcast(null);
  return cfg;
}

/* ---------------- Tray ---------------- */
function sendCommand(cmd, args) {
  if (avatarWin && !avatarWin.isDestroyed() && cfg.visible) avatarWin.webContents.send('command', cmd, args);
}
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }));
    tray.setToolTip('Avatar Agent');
    tray.on('click', () => tray.popUpContextMenu());
  }
  const test = ['happy', 'greet', 'yes', 'no', 'think', 'sad'].map((c) => ({ label: c, click: () => sendCommand(c) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: cfg.visible ? 'Hide me' : 'Show me', click: () => setVisible(!cfg.visible) },
    { type: 'separator' },
    { label: 'Change character…', click: pickModel },
    { label: 'Studio', submenu: [
      { label: 'Bones (remap)', click: () => openStudio('bones') },
      { label: 'Pose (rest / T-pose)', click: () => openStudio('pose') },
      { label: 'Fix motions', click: () => openStudio('fix') },
      { label: 'Create motion', click: () => openStudio('create') },
      { label: 'Rig builder', click: () => openStudio('rig') },
    ] },
    { label: 'Test', submenu: [...test, { label: 'say hello', click: () => sendCommand('say', { text: 'Hello! I am ready.' }) }] },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Developer tools', click: () => {
      for (const w of [avatarWin, studioWin]) if (w && !w.isDestroyed()) w.webContents.openDevTools({ mode: 'detach' });
    } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/* ---------------- IPC ---------------- */
ipcMain.handle('config:get', () => cfg);
ipcMain.on('config:set', (e, patch) => { Object.assign(cfg, patch); saveCfg(); broadcast(e.sender); });
ipcMain.handle('model:read', async () => {
  if (!cfg.modelPath) return null;
  try { return await fs.promises.readFile(cfg.modelPath); } catch { return null; }
});
ipcMain.handle('model:pick', pickModel);
ipcMain.handle('model:save', async (_e, buffer, name) => {
  const parent = studioWin && !studioWin.isDestroyed() ? studioWin : undefined;
  const r = await dialog.showSaveDialog(parent, { defaultPath: name || 'character.glb', filters: [{ name: 'GLB model', extensions: ['glb'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, Buffer.from(buffer));
  return r.filePath;
});
ipcMain.on('studio:open', (_e, tab) => openStudio(tab));
ipcMain.on('command', (_e, cmd, args) => sendCommand(cmd, args));
ipcMain.handle('win:dragstart', (e) => BrowserWindow.fromWebContents(e.sender)?.getBounds());
ipcMain.on('win:dragmove', (e, x, y) => {
  BrowserWindow.fromWebContents(e.sender)?.setBounds({ x: Math.round(x), y: Math.round(y), width: AV.w, height: AV.h });
});
ipcMain.on('win:ignore', (e, v) => BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!!v, { forward: true }));

/* ---------------- Lifecycle ---------------- */
app.on('second-instance', () => setVisible(true));
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.whenReady().then(() => {
  loadCfg();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  createAvatar();
  buildTray();
});
