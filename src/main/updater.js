'use strict';
// Update check, download and install through electron-updater (GitHub Releases).
const { app } = require('electron');

let au = null, state = { state: 'idle', current: app.getVersion() }, emit = () => {}, getSettings = () => ({});
const DEFAULT_REPOSITORY = 'saeedhub101/Saeed';
function repository(value) {
  const candidate = String(value || '').trim().replace(/^https?:\\/\\/github\\.com\\//i, '').replace(/\\.git$/i, '').replace(/^\\/+|\\/+$/g, '');
  const parts = candidate.split('/');
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part)) ? { owner: parts[0], repo: parts[1] } : (() => { throw new Error('Invalid update repository. Use owner/name, for example saeedhub101/Saeed.'); })();
}
function set(s) { state = { ...state, ...s }; emit(state); }
const first = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);
const notesText = (n) => (Array.isArray(n) ? n.map((x) => x.note || '').join('\n') : String(n || '')).replace(/<[^>]+>/g, '').trim().slice(0, 600);

function lazy() {
  if (au) return au;
  au = require('electron-updater').autoUpdater;
  const configured = getSettings().updates && getSettings().updates.repo;
  const target = repository(configured || DEFAULT_REPOSITORY);
  // Explicitly set the GitHub feed. Do not rely on electron-builder's implicit publish URL,
  // which can point at a stale repository after settings/repository changes.
  au.setFeedURL({ provider: 'github', owner: target.owner, repo: target.repo });
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  au.logger = null;
  au.on('update-available', (i) => set({ state: 'available', version: i.version, notes: notesText(i.releaseNotes), size: (i.files && i.files[0] && i.files[0].size) || 0 }));
  au.on('update-not-available', () => set({ state: 'none' }));
  au.on('download-progress', (p) => set({ state: 'downloading', percent: p.percent, transferred: p.transferred, total: p.total, bps: p.bytesPerSecond, eta: p.bytesPerSecond ? (p.total - p.transferred) / p.bytesPerSecond : 0 }));
  au.on('update-downloaded', () => set({ state: 'ready' }));
  au.on('error', (e) => set({ state: 'error', error: first(e) }));
  return au;
}

function init(o = {}) { emit = typeof o.emit === 'function' ? o.emit : () => {}; getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({}); }
const get = () => state;

async function check() {
  if (!app.isPackaged) { set({ state: 'dev' }); return; }
  set({ state: 'checking', error: null });
  try { await lazy().checkForUpdates(); } catch (e) { set({ state: 'error', error: first(e) }); }
}
async function download() {
  set({ state: 'downloading', percent: 0, transferred: 0, total: state.size || 0, bps: 0, eta: 0 });
  try { await lazy().downloadUpdate(); } catch (e) { set({ state: 'error', error: first(e) }); }
}
const install = () => lazy().quitAndInstall(true, true);

module.exports = { init, get, check, download, install, _test: { repository, DEFAULT_REPOSITORY } };
