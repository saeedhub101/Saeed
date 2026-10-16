'use strict';
// Central permission broker. Every sensitive action (files, apps, commands...) is decided here, in the main process.
// Decision = the permission for the kind of action (ask / allow / deny) combined with the rule of the place it touches.
const { app, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CAPS = {
  'files.read': { label: 'Read files and list folders', desc: 'Open and read files, list what is inside folders, search for files.' },
  'files.write': { label: 'Create and change files', desc: 'Create new files and folders, edit, copy or move existing ones.' },
  'files.delete': { label: 'Delete files and folders (to the Recycle Bin)', desc: 'Delete items. They go to the Recycle Bin and can be restored.' },
  'files.deletePermanent': { label: 'Delete permanently', desc: 'Delete without the Recycle Bin. This cannot be undone.' },
  'apps.open': { label: 'Open apps, files and folders', desc: 'Start programs (Excel, Word...), open files and folders.' },
  'system.run': { label: 'Run commands and scripts', desc: 'Run programs and scripts on this PC (for add-ons that need it).' },
  'desktop.control': { label: 'See the screen and control mouse and keyboard', desc: 'Operate other programs on screen (for add-ons that do it).' },
  'network': { label: 'Use the internet from add-ons', desc: 'Send or fetch data over the internet from inside an add-on.' },
  'web.read': { label: 'Search and read the web', desc: 'Search the internet and read web pages in the background.' },
  'web.send': { label: 'Send data to web services', desc: 'Requests that change something online (POST, PUT, DELETE) and downloads to disk.' },
  'browser.control': { label: 'Control a web browser', desc: 'Open a real browser (visible or hidden), log in, fill forms and click.' },
  'data.read': { label: 'Read company databases', desc: 'Run read-only queries on the databases you connected.' },
  'data.write': { label: 'Change company databases', desc: 'Insert, update or delete rows in the databases you connected.' },
};
const ACTION_CAP = { read: 'files.read', write: 'files.write', delete: 'files.delete', 'delete-permanent': 'files.deletePermanent' };
const DELETE_CAPS = new Set(['files.delete', 'files.deletePermanent']);
const isWin = process.platform === 'win32';

let ctx = null, queue = Promise.resolve();
const sessions = new Map();           // 'addon|cap' -> expiry: "Allow for this task" for actions that are not about a file
const sessionOk = (addon, cap) => (sessions.get(`${addon}|${cap}`) || 0) > Date.now();
const endTask = () => sessions.clear();
const P = () => ctx.getSettings().permissions;
const logFile = () => path.join(app.getPath('userData'), 'audit.log');

function init(c) {
  ctx = c;
  try {
    const f = logFile();
    if (fs.existsSync(f) && fs.statSync(f).size > 512 * 1024) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').slice(-300).join('\n'));
  } catch { /* log is optional */ }
}

/* ---------- paths ---------- */
function expand(p) {
  let s = String(p || '').trim();
  if (!s) return null;
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  let missing = false;
  s = s.replace(/%([^%]+)%/g, (_m, name) => {
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === name.toLowerCase());
    if (!key) { missing = true; return ''; }
    return process.env[key];
  });
  return missing ? null : s;
}
function resolveReal(p) {
  const s = expand(p) || String(p);
  // A relative path ("Desktop/notes.txt", "notes.txt") means a place under the user's own folders, never the
  // app's install or working directory - resolving it against process.cwd() would silently land somewhere like
  // Program Files, which is denied by default, and look to the caller like "no file access" instead of a bad path.
  const full = path.isAbsolute(s) ? path.resolve(s) : path.resolve(os.homedir(), s);
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  return path.join(fs.realpathSync(probe), path.relative(probe, full));
}
const norm = (p) => { let s = path.resolve(p); if (s.length > 3 && s.endsWith(path.sep)) s = s.slice(0, -1); return isWin ? s.toLowerCase() : s; };
const within = (x, root) => x === root || x.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const isDriveRoot = (p) => path.parse(p).root === p || path.parse(p).root === p + path.sep;

function locationFor(real) {
  const n = norm(real);
  let best = null;
  for (const r of P().locations) {
    const e = expand(r.path);
    if (!e) continue;
    const rr = norm(resolveReal(e));
    if (within(n, rr) && (!best || rr.length > best.len)) best = { mode: r.mode, rule: r, len: rr.length };
  }
  return best || { mode: P().defaultLocation, rule: null, len: 0 };
}

function isDangerous(real, cap) {
  if (!DELETE_CAPS.has(cap)) return false;
  const n = norm(real);
  if (n === norm(path.parse(real).root)) return true;
  const win = expand('%SystemRoot%');
  if (win && n === norm(resolveReal(win))) return true;
  return n === norm(os.homedir());
}

/* ---------- decision ---------- */
function decide({ addon, cap, real }) {
  const meta = CAPS[cap];
  const capMode = P().caps[cap] || 'ask';
  if (capMode === 'deny') return { decision: 'deny', why: `"${meta.label}" is turned off in Saeed → Permissions.`, capMode };
  let loc = null;
  if (real) {
    if (isDangerous(real, cap) && !P().dangerous) return { decision: 'deny', why: 'Drive roots, the Windows folder and the user profile folder are protected. This can be unlocked in Permissions → Danger zone.', capMode };
    loc = locationFor(real);
    if (loc.mode === 'deny') return { decision: 'deny', why: `This place is blocked in Permissions (${loc.rule ? loc.rule.path : 'places not listed'}).`, capMode, loc };
  }
  const needAsk = capMode === 'ask' || (loc && loc.mode === 'ask');
  if (!needAsk) return { decision: 'allow', how: 'rule', capMode, loc };
  const granted = (P().grants[addon] || {})[cap];
  if (granted && !(loc && loc.mode === 'ask')) return { decision: 'allow', how: 'granted', capMode, loc };
  return { decision: 'ask', capMode, loc };
}

/* ---------- asking the user ---------- */
const folderOf = (real) => { try { return fs.statSync(real).isDirectory() ? real : path.dirname(real); } catch { return path.dirname(real); } };

function remember(o) {
  ctx.setSetting((s) => {
    if (o.capMode === 'ask') { s.permissions.grants[o.addon] = { ...(s.permissions.grants[o.addon] || {}), [o.cap]: true }; }
    if (o.loc && o.loc.mode === 'ask' && o.real) {
      const folder = folderOf(o.real);
      if (folder && !isDriveRoot(folder)) s.permissions.locations.push({ path: folder, mode: 'allow' });
    }
  });
}

function ask(o) {
  const run = async () => {
    if (ctx.notify) ctx.notify('Waiting for your permission…');
    const warn = DELETE_CAPS.has(o.cap) || o.cap === 'system.run' || o.cap === 'desktop.control';
    const r = await dialog.showMessageBox({
      type: warn ? 'warning' : 'question', title: 'Saeed asks for permission',
      message: `${o.addonName || o.addon} wants to: ${o.label}`,
      detail: [o.detail, o.real ? `Location:\n${o.real}` : ''].filter(Boolean).join('\n\n'),
      buttons: [o.real ? 'Allow once' : 'Allow for this task', 'Always allow', 'Deny'], defaultId: warn ? 2 : 0, cancelId: 2, noLink: true,
    });
    const allowed = r.response !== 2;
    if (r.response === 1) remember(o);
    if (r.response === 0 && !o.real) sessions.set(`${o.addon}|${o.cap}`, Date.now() + 15 * 60000);
    audit({ addon: o.addon, cap: o.cap, path: o.real, decision: allowed ? 'allowed' : 'denied', how: 'asked' });
    return { allowed };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/* ---------- public API ---------- */
// A path action: returns the real path, or throws with the reason.
async function access({ addon, addonName, path: p, action = 'read', detail }) {
  const cap = ACTION_CAP[action];
  if (!cap) throw new Error('Unknown action: ' + action);
  const real = resolveReal(p);
  const d = decide({ addon, cap, real });
  if (d.decision === 'deny') { audit({ addon, cap, path: real, decision: 'denied', how: 'rule' }); throw new Error('Denied. ' + d.why); }
  if (d.decision === 'ask') {
    const r = await ask({ addon, addonName, cap, label: CAPS[cap].label, real, detail, capMode: d.capMode, loc: d.loc });
    if (!r.allowed) throw new Error('The user denied this action.');
    return real;
  }
  audit({ addon, cap, path: real, decision: 'allowed', how: d.how });
  return real;
}

// An action without a path. Returns null when allowed, otherwise the reason. onlyDeny: never ask, only refuse.
async function checkCap({ addon, addonName, cap, detail, onlyDeny }) {
  const meta = CAPS[cap];
  if (!meta) return `Unknown permission ${cap}.`;
  const mode = P().caps[cap] || 'ask';
  if (mode === 'deny') { audit({ addon, cap, decision: 'denied', how: 'setting' }); return `"${meta.label}" is turned off in Saeed → Permissions.`; }
  if (onlyDeny || mode === 'allow') { if (!onlyDeny) audit({ addon, cap, decision: 'allowed', how: 'rule' }); return null; }
  if ((P().grants[addon] || {})[cap] || sessionOk(addon, cap)) return null;
  const r = await ask({ addon, addonName, cap, label: meta.label, real: null, detail, capMode: mode, loc: null });
  return r.allowed ? null : 'The user denied this action.';
}

function explain(p, action) {
  const cap = ACTION_CAP[action] || 'files.read';
  const real = resolveReal(p);
  const d = decide({ addon: '(test)', cap, real });
  return { real, cap, decision: d.decision, capMode: d.capMode, locMode: d.loc ? d.loc.mode : null, rule: d.loc && d.loc.rule ? d.loc.rule.path : null, why: d.why || (d.decision === 'ask' ? 'Saeed will ask you.' : 'Allowed.') };
}

// Folders that are blocked, so add-ons can skip them when they walk through sub-folders.
function denyList() {
  const out = [];
  for (const r of P().locations) { if (r.mode !== 'deny') continue; const e = expand(r.path); if (e) out.push(resolveReal(e)); }
  return out;
}

// A separate, hard-coded cautious preset - independent of DEFAULT_SETTINGS (which ships wide open) - so
// "Restore safe restrictions" always means the same thing, for any install at any time.
const SAFE_PRESET = {
  caps: {
    'files.read': 'allow', 'files.write': 'ask', 'files.delete': 'ask', 'files.deletePermanent': 'deny',
    'apps.open': 'allow', 'system.run': 'ask', 'desktop.control': 'ask', 'network': 'ask',
    'web.read': 'allow', 'web.send': 'ask', 'browser.control': 'ask', 'data.read': 'ask', 'data.write': 'ask',
  },
  defaultLocation: 'ask',
  locations: [
    { path: '~/Documents', mode: 'allow' }, { path: '~/Desktop', mode: 'allow' }, { path: '~/Downloads', mode: 'allow' }, { path: '~/Pictures', mode: 'allow' },
    { path: '%OneDrive%/Documents', mode: 'allow' }, { path: '%OneDrive%/Desktop', mode: 'allow' },
    { path: '%SystemRoot%', mode: 'deny' }, { path: '%ProgramFiles%', mode: 'deny' }, { path: '%ProgramFiles(x86)%', mode: 'deny' },
    { path: '%ProgramData%', mode: 'deny' }, { path: '%APPDATA%', mode: 'deny' }, { path: '%LOCALAPPDATA%', mode: 'deny' },
  ],
  grants: {}, dangerous: false,
};
const info = () => ({ caps: CAPS, defaults: require('./settings').DEFAULT_SETTINGS.permissions, safePreset: SAFE_PRESET });

/* ---------- activity log ---------- */
function audit(e) { fs.appendFile(logFile(), JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n', () => {}); }
function readLog(n = 100) {
  try { return fs.readFileSync(logFile(), 'utf8').split('\n').filter(Boolean).slice(-n).reverse().map((l) => JSON.parse(l)); } catch { return []; }
}
const clearLog = () => { try { fs.rmSync(logFile(), { force: true }); } catch { /* none */ } };

const auditEvent = (e) => audit({ decision: 'ran', how: 'tool', ...e });

module.exports = { endTask, auditEvent, init, access, checkCap, explain, denyList, info, readLog, clearLog, resolveReal, CAPS };
