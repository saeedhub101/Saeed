'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, screen, session, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { DEFAULT_SETTINGS, merge } = require('./settings');
const secrets = require('./secrets');
const providers = require('./providers');
const addons = require('./addons');
const realtime = require('./realtime');
const updater = require('./updater');
const brain = require('./brain');
const pipeline = require('./pipeline');
const prayer = require('./prayer');
const perms = require('./permissions');
const memory = require('./memory');
const skills = require('./skills');

if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('com.avataragent.app');

const AV = { w: 420, h: 600 };
const DEFAULTS = {
  modelPath: null, modelYaw: 0, boneMap: {}, restPose: {}, clips: {}, overrides: {}, customRig: null, intents: {},
  hiddenMeshes: [], face: null, glbClips: {}, faceMaps: {},
  zoom: 1, fps: 30, clickThrough: true, windowPos: null, visible: true,
  accessories: {},      // { 'addon:accessory': { on, offset, rot, scale } }
  settings: DEFAULT_SETTINGS,
};

let cfg = { ...DEFAULTS };
let avatarWin = null, studioWin = null, tray = null;
const wins = {};      // settings, chat
const preload = path.join(__dirname, 'preload.js');
const page = (n) => path.join(__dirname, '..', 'renderer', n);
const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
const alive = (w) => w && !w.isDestroyed();

function loadCfg() {
  try { cfg = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { cfg = { ...DEFAULTS }; }
  cfg.settings = merge(DEFAULT_SETTINGS, cfg.settings);
  if (String(cfg.settings.stt.provider) === 'local') cfg.settings.stt.provider = 'openai';   // moved to the Whisper add-on
  // Old "allowed folders" become allow rules in Permissions.
  const ag = cfg.settings.agent || {};
  for (const f of Array.isArray(ag.allowedFolders) ? ag.allowedFolders : []) {
    if (!cfg.settings.permissions.locations.some((r) => r.path === f)) cfg.settings.permissions.locations.push({ path: f, mode: 'allow' });
  }
  delete ag.allowedFolders; delete ag.confirm;
}
// Change settings from the main process and tell every window.
function setSetting(fn) { fn(cfg.settings); cfg.settings = merge(DEFAULT_SETTINGS, cfg.settings); saveCfg(); broadcast(null); }
let notifyTimer;
function notifyAddons() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('addons:changed');
    buildTray();
  }, 150);
}
let saveTimer;
function saveCfg() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(cfgFile(), JSON.stringify(cfg, null, 2), () => {}), 300);
}
function broadcast(except) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents !== except) w.webContents.send('config:changed', cfg);
}

/* ---------------- services state ---------------- */
// The brain works while the character is visible OR the chat window is open.
const chatOpen = () => alive(wins.chat);
const isActive = () => cfg.visible || chatOpen();
const bus = {
  avatar: (ev) => { if (alive(avatarWin)) avatarWin.webContents.send('pipeline', ev); },
  chat: (ev) => { if (chatOpen()) wins.chat.webContents.send('chat:event', ev); },
};
pipeline.init({ bus, getSettings: () => cfg.settings, canSpeak: () => cfg.visible, isActive });

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
    x, y, width: AV.w, height: AV.h, transparent: true, frame: false, resizable: false, hasShadow: false,
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
  if (!alive(avatarWin)) return;
  if (v) { avatarWin.show(); avatarWin.webContents.send('service', 'resume'); }
  else {
    avatarWin.webContents.send('service', 'pause');       // stops mic and audio in the window
    avatarWin.hide();
    pipeline.cancel();                                     // stops the brain unless the chat is open
    realtime.stop();
    addons.stopAll();                                      // frees the memory of every add-on process
    if (!chatOpen()) bus.avatar({ type: 'cancel' });
  }
  buildTray();
}

/* ---------------- Other windows ---------------- */
function devKeys(w) {
  w.webContents.on('before-input-event', (_e, i) => {
    if (i.type === 'keyDown' && (i.key === 'F12' || (i.control && i.shift && i.key.toLowerCase() === 'i'))) w.webContents.toggleDevTools();
  });
}
function openStudio(tab = 'bones') {
  if (alive(studioWin)) { studioWin.show(); studioWin.focus(); studioWin.webContents.send('studio:tab', tab); return; }
  studioWin = new BrowserWindow({
    width: 1320, height: 840, minWidth: 1000, minHeight: 640, backgroundColor: '#14171c', title: 'Avatar Studio', autoHideMenuBar: true,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  studioWin.removeMenu();
  studioWin.loadFile(page('studio.html'), { query: { tab } });
  devKeys(studioWin);
  studioWin.on('closed', () => { studioWin = null; });
}
const SIZES = {
  settings: { width: 940, height: 800, title: 'Saeed settings' },
  chat: { width: 460, height: 660, title: 'Chat with Saeed' },
  addons: { width: 920, height: 720, title: 'Saeed add-ons' },
  permissions: { width: 980, height: 820, title: 'Saeed permissions' },
  update: { width: 430, height: 270, title: 'Saeed update', resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true },
};
function openWin(kind) {
  if (!SIZES[kind]) return;
  if (alive(wins[kind])) { wins[kind].show(); wins[kind].focus(); return; }
  const w = new BrowserWindow({ ...SIZES[kind], backgroundColor: '#14171c', autoHideMenuBar: true, webPreferences: { preload, contextIsolation: true, sandbox: true } });
  w.removeMenu();
  w.loadFile(page(kind + '.html'));
  devKeys(w);
  w.on('closed', () => {
    wins[kind] = null;
    if (kind === 'chat' && !cfg.visible) pipeline.cancel();   // hidden + chat closed = brain stopped
  });
  wins[kind] = w;
}

/* ---------------- Model dialogs ---------------- */
async function pickModel() {
  const r = await dialog.showOpenDialog(alive(studioWin) ? studioWin : undefined, {
    title: 'Choose a character', properties: ['openFile'], filters: [{ name: 'GLB model', extensions: ['glb'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  if (cfg.modelPath) cfg.faceMaps[cfg.modelPath] = { face: cfg.face, glbClips: cfg.glbClips };   // each character keeps its own face mapping
  const saved = cfg.faceMaps[r.filePaths[0]] || {};
  Object.assign(cfg, { modelPath: r.filePaths[0], boneMap: {}, restPose: {}, overrides: {}, customRig: null, face: saved.face || null, glbClips: saved.glbClips || {} });
  saveCfg(); broadcast(null);
  return cfg;
}

/* ---------------- Adhan ---------------- */
const AR = { Fajr: 'الفجر', Dhuhr: 'الظهر', Asr: 'العصر', Maghrib: 'المغرب', Isha: 'العشاء' };
async function triggerAdhan(name) {
  if (!cfg.visible) return;
  const p = cfg.settings.prayer;
  const text = `حان الآن موعد أذان ${AR[name] || name}`;
  let bytes = null;
  if (p.adhanFile) { try { bytes = await fs.promises.readFile(p.adhanFile); } catch { /* announce instead */ } }
  if (bytes) bus.avatar({ type: 'adhan', name, text, bytes, volume: p.adhanVolume, pose: p.pose });
  else pipeline.say(text);
}

/* ---------------- Tray ---------------- */
function sendCommand(cmd, args) { if (alive(avatarWin) && cfg.visible) avatarWin.webContents.send('command', cmd, args); }
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 }));
    tray.setToolTip('Saeed');
    tray.on('click', () => tray.popUpContextMenu());
  }
  const nx = prayer.next();
  const accs = addons.accessories();
  const test = ['happy', 'greet', 'yes', 'no', 'think', 'sad', 'sit', 'lie', 'sleep', 'stand'].map((c) => ({ label: c, click: () => sendCommand(c) }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: cfg.visible ? 'Hide me' : 'Show me', click: () => setVisible(!cfg.visible) },
    { label: 'Chat…', click: () => openWin('chat') },
    { label: 'Mute voice', type: 'checkbox', checked: cfg.settings.audio.muted, click: (i) => {
      cfg.settings.audio.muted = i.checked; saveCfg(); broadcast(null);
      if (i.checked) pipeline.cancel();
    } },
    { type: 'separator' },
    { label: 'Settings…', click: () => openWin('settings') },
    { label: 'Permissions…', click: () => openWin('permissions') },
    { label: 'Add-ons…', click: () => openWin('addons') },
    { label: 'Change character…', click: pickModel },
    { label: 'Studio', submenu: [
      { label: 'Bones (remap)', click: () => openStudio('bones') },
      { label: 'Pose (rest / T-pose)', click: () => openStudio('pose') },
      { label: 'Fix motions', click: () => openStudio('fix') },
      { label: 'Create motion', click: () => openStudio('create') },
      { label: 'Face', click: () => openStudio('face') },
      { label: 'Rig builder', click: () => openStudio('rig') },
    ] },
    { label: 'Test', submenu: [...test, { label: 'say hello', click: () => sendCommand('say', { text: 'Hello! I am ready.' }) },
      { label: 'adhan', click: () => triggerAdhan('Dhuhr') }] },
    ...(accs.length ? [{ label: 'Accessories', submenu: accs.map((x) => ({
      label: x.name, type: 'checkbox', checked: !!(cfg.accessories[x.id] && cfg.accessories[x.id].on),
      click: (i) => {
        cfg.accessories[x.id] = { ...(cfg.accessories[x.id] || {}), on: i.checked };
        if (i.checked && x.type === 'outfit' && x.slot) for (const y of accs) if (y.id !== x.id && y.type === 'outfit' && y.slot === x.slot && cfg.accessories[y.id]) cfg.accessories[y.id].on = false;
        saveCfg(); broadcast(null); buildTray();
      },
    })) }] : []),
    { type: 'separator' },
    ...(cfg.settings.prayer.enabled && nx ? [{ label: `Next prayer: ${nx.name} ${nx.time}`, enabled: false }] : []),
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { label: 'Check for updates…', click: () => { openWin('update'); updater.check(); } },
    { label: 'Stop everything', click: stopEverything },
    { label: 'Developer tools', click: () => { for (const w of [avatarWin, studioWin, wins.settings, wins.chat]) if (alive(w)) w.webContents.openDevTools({ mode: 'detach' }); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

/* ---------------- Screen control: visible banner, emergency stop ---------------- */
let banner = null, desktopTimer = 0, shortcutOn = false;
function createBanner() {
  const b = screen.getPrimaryDisplay().bounds;
  banner = new BrowserWindow({
    width: 560, height: 46, x: Math.round(b.x + b.width / 2 - 280), y: b.y + 6, frame: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, focusable: false, resizable: false, hasShadow: false,
    webPreferences: { preload, contextIsolation: true, sandbox: true },
  });
  banner.setAlwaysOnTop(true, 'screen-saver');
  banner.setContentProtection(true);            // not part of screenshots, so the model never sees it
  banner.loadFile(page('banner.html'));
  banner.on('closed', () => { banner = null; });
}
function desktopPing() {                        // called whenever a screen-control tool runs
  if (!alive(banner)) createBanner();
  if (!shortcutOn) shortcutOn = globalShortcut.register('Control+Alt+X', stopEverything);
  if (alive(avatarWin)) avatarWin.setContentProtection(true);
  clearTimeout(desktopTimer);
  desktopTimer = setTimeout(desktopOff, 25000);
}
function desktopOff() {
  clearTimeout(desktopTimer);
  if (alive(banner)) banner.close();
  banner = null;
  if (shortcutOn) { globalShortcut.unregister('Control+Alt+X'); shortcutOn = false; }
  if (alive(avatarWin)) avatarWin.setContentProtection(false);
}

function stopEverything() {
  pipeline.cancel(); realtime.stop(); addons.stopAll(); perms.endTask(); desktopOff();
  bus.avatar({ type: 'rt-state', state: 'closed' });
}

/* ---------------- IPC ---------------- */
ipcMain.handle('config:get', () => cfg);
ipcMain.on('config:set', (e, patch) => {
  if (patch.settings) patch = { ...patch, settings: merge(DEFAULT_SETTINGS, patch.settings) };
  const langChanged = patch.settings && patch.settings.ui && patch.settings.ui.language !== cfg.settings.ui.language;
  Object.assign(cfg, patch);
  saveCfg(); broadcast(e.sender);
  if (patch.settings) buildTray();
  if (langChanged) for (const kind of ['settings', 'addons', 'permissions', 'chat']) if (alive(wins[kind])) wins[kind].webContents.reload();
});
ipcMain.handle('model:read', async () => {
  if (!cfg.modelPath) return null;
  try { return await fs.promises.readFile(cfg.modelPath); } catch { return null; }
});
ipcMain.handle('model:pick', pickModel);
ipcMain.handle('model:save', async (_e, buffer, name) => {
  const r = await dialog.showSaveDialog(alive(studioWin) ? studioWin : undefined, { defaultPath: name || 'character.glb', filters: [{ name: 'GLB model', extensions: ['glb'] }] });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, Buffer.from(buffer));
  return r.filePath;
});
ipcMain.handle('file:pick', async (e, exts) => {
  const parent = BrowserWindow.fromWebContents(e.sender) || undefined;
  const r = await dialog.showOpenDialog(parent, { properties: [exts === 'dir' ? 'openDirectory' : 'openFile'], filters: Array.isArray(exts) && exts.length ? [{ name: 'Files', extensions: exts }] : [] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('studio:open', (_e, tab) => openStudio(tab));
ipcMain.on('win:open', (_e, kind) => openWin(kind));
ipcMain.on('command', (_e, cmd, args) => sendCommand(cmd, args));
ipcMain.handle('win:dragstart', (e) => BrowserWindow.fromWebContents(e.sender)?.getBounds());
// Where the real OS cursor is relative to this window's center, for the character's idle eye glances.
ipcMain.handle('win:cursor', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return null;
  const b = w.getBounds(), p = screen.getCursorScreenPoint();
  const dx = p.x - (b.x + b.width / 2), dy = p.y - (b.y + b.height / 2);
  return { dx, dy, near: Math.hypot(dx, dy) < Math.max(b.width, b.height) * 2.2 };
});
ipcMain.on('win:dragmove', (e, x, y) => {
  BrowserWindow.fromWebContents(e.sender)?.setBounds({ x: Math.round(x), y: Math.round(y), width: AV.w, height: AV.h });
});
ipcMain.on('win:ignore', (e, v) => BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!!v, { forward: true }));

// voice
ipcMain.on('voice:utterance', async (_e, f32) => {
  if (!isActive()) return;
  try {
    bus.chat({ type: 'state', text: 'transcribing…' });
    const text = await providers.transcribe(cfg.settings, f32);
    if (!text || text.replace(/[\s.,!?؟،…-]/g, '').length < 2) { bus.chat({ type: 'state', text: '' }); return; }
    await pipeline.handleText(text, 'voice');
  } catch (e) {
    bus.chat({ type: 'state', text: '' });
    bus.chat({ type: 'error', text: 'Speech recognition: ' + e.message });
    bus.avatar({ type: 'error', text: 'Speech recognition failed: ' + String(e.message).slice(0, 120) });
  }
});
ipcMain.on('voice:interrupt', () => pipeline.cancel());

// chat
ipcMain.on('chat:send', (_e, text, images) => pipeline.handleText(text, 'chat', Array.isArray(images) ? images.slice(0, 4) : []));
ipcMain.on('chat:cancel', () => pipeline.cancel());
ipcMain.handle('chat:history', () => brain.history());
ipcMain.handle('chat:clear', () => { brain.clear(); return true; });

// permissions
ipcMain.handle('perm:info', () => perms.info());
ipcMain.handle('perm:set', (_e, p) => { setSetting((s) => { s.permissions = p; }); return true; });
ipcMain.handle('perm:log', () => perms.readLog(120));
ipcMain.handle('perm:clear-log', () => { perms.clearLog(); return true; });
ipcMain.handle('perm:explain', (_e, p, action) => { try { return perms.explain(p, action); } catch (e) { return { error: e.message }; } });

// add-ons
const sendTo = (kind, ch, ...a) => { if (alive(wins[kind])) wins[kind].webContents.send(ch, ...a); };
ipcMain.handle('addons:list', () => addons.summary());
ipcMain.handle('addons:toggle', (_e, id, on) => { setSetting((s) => { s.addons.enabled[id] = !!on; }); if (!on) addons.stop(id); notifyAddons(); return true; });
ipcMain.handle('addons:remove', (_e, id) => { addons.remove(id); return true; });
ipcMain.handle('addons:stop', (_e, id) => { addons.stop(id); return true; });
ipcMain.handle('addons:save-settings', (_e, id, values) => { setSetting((s) => { s.addons.settings[id] = values; }); return true; });
ipcMain.handle('addons:registry', async () => { try { const r = await addons.registry(); return { ok: true, list: r.list, errors: r.errors }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('addons:set-sources', (_e, list) => { setSetting((s) => { s.addons.sources = (list || []).filter((x) => x && /^https?:\/\//i.test(String(x.url || '').trim())).map((x) => ({ name: String(x.name || '').slice(0, 40), url: String(x.url).trim() })); }); return true; });
ipcMain.handle('addons:install-url', async (_e, url) => {
  try {
    if (!/\.glb(\?|#|$)/i.test(String(url)) && !(await askInstall(String(url).slice(0, 80), '', ['unknown: check the source'].slice(0, 0)))) return { ok: false, error: 'Cancelled.' };
    return { ok: true, ...(await addons.installUrl(url, (p) => sendTo('addons', 'addons:progress', { ...p, id: 'link' }))) };
  } catch (e) { return { ok: false, error: e.message }; }
});
async function askInstall(name, version, perms) {
  const r = await dialog.showMessageBox(wins.addons && !wins.addons.isDestroyed() ? wins.addons : undefined, {
    type: 'warning', buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    message: `Install "${name}" ${version || ''}?`,
    detail: `Add-ons run code on this PC with your permissions. Install only add-ons from a source you trust.\n\nPermissions it asks for: ${perms && perms.length ? perms.join(', ') : 'none'}`,
  });
  return r.response === 0;
}
ipcMain.handle('addons:install', async (_e, entry) => {
  try {
    if (!(await askInstall(entry.name, entry.version, entry.permissions))) return { ok: false, error: 'Cancelled.' };
    if (entry.source === 'included') addons.installBundled(entry.id);
    else await addons.download(entry, (p) => sendTo('addons', 'addons:progress', p));
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('addons:install-zip', async () => {
  const r = await dialog.showOpenDialog(alive(wins.addons) ? wins.addons : undefined, { properties: ['openFile'], filters: [{ name: 'Add-on', extensions: ['zip'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, error: 'Cancelled.' };
  try {
    if (!(await askInstall(require('path').basename(r.filePaths[0]), '', []))) return { ok: false, error: 'Cancelled.' };
    return { ok: true, addon: addons.installZip(r.filePaths[0]).name };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('accessories:list', () => addons.accessories());
ipcMain.handle('ui:languages', () => addons.languages());
ipcMain.handle('ui:strings', () => addons.stringsFor(cfg.settings.ui.language));
ipcMain.handle('addons:create-pack', (_e, spec) => { try { return { ok: true, id: addons.createPack(spec) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.on('banner:stop', () => stopEverything());
ipcMain.handle('addon:file', (_e, id, rel) => addons.readAddonFile(id, rel));

// live conversation
ipcMain.handle('rt:start', async () => {
  try { const r = await realtime.start({ bus, getSettings: () => cfg.settings }); return { ok: true, rate: r.rate }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rt:stop', () => { realtime.stop(); return true; });
ipcMain.on('rt:audio', (_e, buf) => realtime.audio(buf));
ipcMain.on('rt:interrupt', () => realtime.interrupt());

// updates + resources
ipcMain.handle('update:get', () => updater.get());
ipcMain.on('update:action', (_e, a) => {
  if (a === 'check') updater.check();
  else if (a === 'download') updater.download();
  else if (a === 'install') updater.install();
  else if (a === 'close') { if (alive(wins.update)) wins.update.close(); }
});
ipcMain.handle('sys:metrics', () => ({
  processes: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, memMB: Math.round((m.memory.workingSetSize || 0) / 1024), cpu: +m.cpu.percentCPUUsage.toFixed(1) })),
  addons: addons.running(),
  addonDetail: addons.runningDetail(),
  windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).map((w) => `${w.getTitle() || 'window'}${w.isVisible() ? '' : ' (hidden)'}`),
}));

// settings helpers
ipcMain.handle('secret:set', (_e, name, value) => { secrets.set(name, value); return true; });
ipcMain.handle('secret:has', (_e, name) => secrets.has(name));
ipcMain.handle('secret:names', (_e, prefix) => secrets.names(prefix));
ipcMain.handle('memory:list', () => memory.listFacts());
ipcMain.handle('memory:add', (_e, t) => memory.addFact(t));
ipcMain.handle('memory:remove', (_e, i) => { memory.removeFactAt(i); return true; });
ipcMain.handle('skills:list', () => skills.list());
ipcMain.handle('skills:remove', (_e, i) => { skills.removeAt(i); return true; });
ipcMain.handle('test:tts', async (_e, text) => {
  try { const a = await providers.synthesize(cfg.settings, text); return { ok: true, mime: a.mime, bytes: a.bytes }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('test:llm', async () => {
  try {
    const m = await brain.ask('Say hello in one short sentence.', { settings: cfg.settings, onIntent: () => {} });
    return { ok: true, text: m.text };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('test:stt', async (_e, f32) => {
  try { return { ok: true, text: await providers.transcribe(cfg.settings, f32) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('prayer:refresh', async () => { try { return { ok: true, times: await prayer.refresh() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('prayer:today', () => prayer.today());
ipcMain.on('prayer:test', () => triggerAdhan('Dhuhr'));

/* ---------------- Lifecycle ---------------- */
app.on('second-instance', () => setVisible(true));
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.whenReady().then(() => {
  loadCfg();
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  createAvatar();
  buildTray();
  prayer.start({ getSettings: () => cfg.settings, onAdhan: triggerAdhan, onUpdate: buildTray });
  memory.initReminders((r) => { if (cfg.visible) pipeline.say((/[\u0600-\u06FF]/.test(r.text) ? 'تذكير: ' : 'Reminder: ') + r.text); });
  perms.init({ getSettings: () => cfg.settings, setSetting, notify: (t) => { bus.chat({ type: 'state', text: t }); bus.avatar({ type: 'notice', text: t }); } });
  addons.init({
    getSettings: () => cfg.settings, setSetting,
    onStatus: (_id, text) => bus.chat({ type: 'state', text }),
    onChange: notifyAddons, onDesktop: desktopPing,
  });
  let silent = false;
  updater.init({ emit: (st) => {
    sendTo('update', 'update:state', st);
    if (silent && st.state === 'available') { silent = false; openWin('update'); }
    if (['none', 'error', 'dev'].includes(st.state)) silent = false;
  } });
  const autoCheck = () => { if (app.isPackaged && cfg.settings.updates.autoCheck) { silent = true; updater.check(); } };
  setTimeout(autoCheck, 30000);
  setInterval(autoCheck, 24 * 3600 * 1000);
});
