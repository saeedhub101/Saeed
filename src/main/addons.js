'use strict';
// Add-on manager. Add-ons are folders with an addon.json manifest and a CommonJS entry file.
// Each add-on runs in its own utility process that is started on the first call and stopped when idle.
const { app, utilityProcess, shell } = require('electron');
const perms = require('./permissions');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = () => path.join(app.getPath('userData'), 'addons');
const dataDirOf = (id) => path.join(app.getPath('userData'), 'addon-data', id);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
let ctx = null, list = [];
const procs = new Map();

function init(c) { ctx = c; fs.mkdirSync(dir(), { recursive: true }); scan(); }

function scan() {
  list = [];
  for (const d of fs.readdirSync(dir(), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir(), d.name, 'addon.json'), 'utf8'));
      if (m.id === d.name && ID_RE.test(m.id)) list.push({ ...m, dir: path.join(dir(), d.name) });
    } catch { /* ignore broken folders */ }
  }
  return list;
}

const A = () => ctx.getSettings().addons;
const isEnabled = (id) => A().enabled[id] !== false;
const settingsOf = (a) => {
  const out = {};
  for (const f of a.settings || []) out[f.key] = f.default;
  return { ...out, ...(A().settings[a.id] || {}) };
};
const find = (id) => list.find((a) => a.id === id);

/* ---------- process lifecycle ---------- */
function send(p, msg) {
  const id = ++p.seq;
  return new Promise((resolve, reject) => { p.pending.set(id, { resolve, reject }); p.child.postMessage({ ...msg, id }); });
}
function start(a) {
  let p = procs.get(a.id);
  if (p) return p;
  const hostPath = path.join(__dirname, 'addon-host.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const child = utilityProcess.fork(hostPath, [], { serviceName: `saeed-${a.id}`, stdio: 'pipe' });
  p = { child, pending: new Map(), seq: 0, timer: null, since: Date.now() };
  child.on('message', (m) => {
    if (m.type === 'access' || m.type === 'trash' || m.type === 'permit') { hostRequest(a, child, m); return; }
    if (m.type === 'status') { if (ctx.onStatus) ctx.onStatus(a.id, m.text); return; }
    const r = p.pending.get(m.id);
    if (!r) return;
    p.pending.delete(m.id);
    if (m.ok) r.resolve(m.result); else r.reject(new Error(m.error));
  });
  child.on('exit', () => {
    for (const [, r] of p.pending) r.reject(new Error('The add-on was stopped.'));
    procs.delete(a.id);
    if (ctx.onChange) ctx.onChange();
  });
  if (child.stderr) child.stderr.on('data', (d) => console.error(`[${a.id}]`, String(d).trim()));
  procs.set(a.id, p);
  p.ready = send(p, { type: 'init', dir: a.dir, main: a.main || 'index.js', dataDir: dataDirOf(a.id) });
  p.ready.catch(() => stop(a.id));
  if (ctx.onChange) ctx.onChange();
  return p;
}
function stop(id) { const p = procs.get(id); if (p) { clearTimeout(p.timer); try { p.child.kill(); } catch { /* gone */ } } }
const stopAll = () => { for (const id of [...procs.keys()]) stop(id); };

function armIdle(a, p) {
  clearTimeout(p.timer);
  const secs = a.idleSeconds || ctx.getSettings().agent.addonIdleSeconds || 90;
  p.timer = setTimeout(() => { if (p.pending.size) armIdle(a, p); else stop(a.id); }, secs * 1000);
}

async function call(a, target, name, args, signal) {
  if (!isEnabled(a.id)) throw new Error(`The add-on "${a.name}" is turned off.`);
  const p = start(a);
  clearTimeout(p.timer);
  const onAbort = () => stop(a.id);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    await p.ready;
    const env = { denyPaths: perms.denyList(), settings: settingsOf(a) };
    return await Promise.race([
      send(p, { type: 'call', target, name, args, env }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('The add-on took too long (5 minutes).')), 300000)),
    ]);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (procs.get(a.id) === p) armIdle(a, p);
  }
}

/* ---------- tools for the brain ---------- */
const safeName = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
function toolDefs() {
  const out = [];
  for (const a of list) {
    if (!isEnabled(a.id)) continue;
    for (const t of a.tools || []) {
      const risk = t.risk || 'read';
      const perm = t.perm ? [].concat(t.perm) : [risk === 'system' ? 'system.run' : risk === 'write' ? 'files.write' : 'files.read'];
      out.push({ name: safeName(`${a.id}__${t.name}`), description: `[${a.name}] ${t.description}`, schema: t.schema || { type: 'object', properties: {} }, risk, perm, addon: a.id, tool: t.name });
    }
  }
  return out;
}

// Requests from an add-on process that need the user's permissions (files, trash, capabilities).
async function hostRequest(a, child, m) {
  const reply = (ok, v) => { try { child.postMessage({ type: 'reply', rid: m.rid, ok, ...(ok ? { result: v } : { error: v }) }); } catch { /* process gone */ } };
  try {
    if (m.type === 'access') reply(true, await perms.access({ addon: a.id, addonName: a.name, path: m.path, action: m.action, detail: m.detail }));
    else if (m.type === 'trash') {
      const real = await perms.access({ addon: a.id, addonName: a.name, path: m.path, action: 'delete', detail: 'Move to the Recycle Bin' });
      await shell.trashItem(real);
      reply(true, real);
    } else {
      const why = await perms.checkCap({ addon: a.id, addonName: a.name, cap: m.cap, detail: m.detail });
      if (why) reply(false, why); else reply(true, true);
    }
  } catch (e) { reply(false, e.message); }
}

async function invokeTool(fullName, args, signal) {
  const def = toolDefs().find((d) => d.name === fullName);
  if (!def) return 'Unknown tool.';
  const a = find(def.addon);
  // File permissions are checked per path inside the add-on. Here: refuse early if a permission is switched off,
  // and ask for the permissions that are not about a file (commands, screen control, internet).
  for (const cap of def.perm) {
    const why = await perms.checkCap({ addon: a.id, addonName: a.name, cap, detail: `${def.tool} ${JSON.stringify(args).slice(0, 300)}`, onlyDeny: cap.startsWith('files.') });
    if (why) return 'Denied: ' + why;
  }
  if (def.perm.includes('desktop.control') && ctx.onDesktop) ctx.onDesktop();
  if (def.risk !== 'read') perms.auditEvent({ addon: a.id, cap: def.perm[0] || '', path: def.tool, detail: JSON.stringify(args).slice(0, 160) });
  try {
    const out = await call(a, 'tool', def.tool, args, signal);
    const cut = (t) => (t.length > 20000 ? t.slice(0, 20000) + '\n…(truncated)' : t);
    if (out && typeof out === 'object' && out.image) return { text: cut(String(out.text || '')), image: out.image };
    return cut(typeof out === 'string' ? out : JSON.stringify(out));
  } catch (e) { return 'Error: ' + e.message; }
}

/* ---------- providers (STT / TTS) ---------- */
const providersOf = (kind) => list.filter((a) => isEnabled(a.id) && a.provides && a.provides[kind])
  .map((a) => ({ id: `addon:${a.id}`, label: `${a.provides[kind].label || a.name} (add-on)` }));
async function callProvider(kind, providerId, args, signal) {
  const a = find(String(providerId).replace(/^addon:/, ''));
  if (!a) throw new Error('This provider add-on is not installed. Open Add-ons to install it.');
  return call(a, kind, '', args, signal);
}

/* ---------- accessories ---------- */
function accessories() {
  const out = [];
  for (const a of list) {
    if (!isEnabled(a.id)) continue;
    for (const x of a.accessories || []) out.push({ ...x, id: `${a.id}:${x.id}`, addon: a.id });
  }
  return out;
}
function readAddonFile(id, rel) {
  const a = find(id);
  if (!a) throw new Error('Unknown add-on');
  const full = path.resolve(a.dir, rel);
  if (!full.startsWith(a.dir + path.sep)) throw new Error('Bad path');
  return fs.readFileSync(full);
}

/* ---------- install / remove ---------- */
function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

function installZip(zipPath) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const mf = entries.find((e) => /(^|\/)addon\.json$/.test(e.entryName) && e.entryName.split('/').length <= 2);
  if (!mf) throw new Error('This file is not an add-on (addon.json is missing).');
  const prefix = mf.entryName.slice(0, mf.entryName.length - 'addon.json'.length);
  const m = JSON.parse(mf.getData().toString('utf8'));
  if (!ID_RE.test(m.id || '')) throw new Error('Invalid add-on id.');
  const target = path.join(dir(), m.id);
  stop(m.id);
  const staging = target + '.new';
  fs.rmSync(staging, { recursive: true, force: true });
  for (const e of entries) {
    if (!e.entryName.startsWith(prefix)) continue;
    const rel = e.entryName.slice(prefix.length);
    if (!rel) continue;
    const out = path.resolve(staging, rel);
    if (!out.startsWith(path.resolve(staging) + path.sep)) throw new Error('Unsafe path in the add-on file.');
    if (e.isDirectory) fs.mkdirSync(out, { recursive: true });
    else { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, e.getData()); }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  scan();
  if (ctx.onChange) ctx.onChange();
  return m;
}

async function download(entry, onProgress) {
  const res = await fetch(entry.url);
  if (!res.ok) throw new Error('Download failed: ' + res.status);
  const total = Number(res.headers.get('content-length')) || entry.size || 0;
  const tmp = path.join(app.getPath('temp'), `saeed-${entry.id}-${Date.now()}.zip`);
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  let got = 0;
  const t0 = Date.now();
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value); hash.update(value); got += value.length;
    const s = (Date.now() - t0) / 1000 || 1;
    onProgress({ id: entry.id, transferred: got, total, bps: got / s, eta: total ? (total - got) / (got / s) : 0 });
  }
  await new Promise((r) => out.end(r));
  if (entry.sha256 && hash.digest('hex') !== String(entry.sha256).toLowerCase()) { fs.rmSync(tmp, { force: true }); throw new Error('The downloaded file does not match its checksum. Not installed.'); }
  try { return installZip(tmp); } finally { fs.rmSync(tmp, { force: true }); }
}

function remove(id) {
  stop(id);
  fs.rmSync(path.join(dir(), id), { recursive: true, force: true });
  scan();
  if (ctx.onChange) ctx.onChange();
}

function registryUrl() {
  const s = ctx.getSettings();
  if (s.addons.registryUrl) return s.addons.registryUrl;
  return s.updates.repo ? `https://raw.githubusercontent.com/${s.updates.repo}/main/addons/registry.json` : '';
}
async function registry() {
  const url = registryUrl();
  if (!url) throw new Error('Set your GitHub repository in Settings → Updates (or a registry address here).');
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Could not read the add-on list: ' + r.status);
  const j = await r.json();
  return (j.addons || []).map((e) => {
    const inst = find(e.id);
    return { ...e, installed: !!inst, installedVersion: inst ? inst.version : null, update: !!inst && cmp(e.version, inst.version) > 0 };
  });
}

/* ---------- accessory packs made from the user's own GLB files ---------- */
function createPack(spec) {
  const slug = String(spec.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  if (slug.length < 2) throw new Error('Choose a name with letters or digits (a-z, 0-9).');
  if (!spec.file || !/\.glb$/i.test(spec.file)) throw new Error('Choose a .glb file.');
  const id = `pack-${slug}`;
  const root = path.join(dir(), id);
  fs.mkdirSync(path.join(root, 'files'), { recursive: true });
  const fileName = path.basename(spec.file).replace(/[^\w.-]/g, '_');
  fs.copyFileSync(spec.file, path.join(root, 'files', fileName));
  const acc = { id: slug, name: spec.name, type: spec.kind === 'outfit' ? 'outfit' : 'attach', file: `files/${fileName}` };
  if (acc.type === 'outfit') { acc.slot = spec.slot || 'top'; acc.hide = String(spec.hide || '').split(',').map((s) => s.trim()).filter(Boolean); }
  else { acc.bone = spec.bone || 'head'; acc.offset = [0, 0, 0]; }
  fs.writeFileSync(path.join(root, 'addon.json'), JSON.stringify({ id, name: spec.name, version: '1.0.0', description: acc.type === 'outfit' ? 'Outfit' : 'Accessory', permissions: [], accessories: [acc] }, null, 2));
  scan();
  if (ctx.onChange) ctx.onChange();
  return id;
}

/* ---------- info for windows ---------- */
function summary() {
  return list.map((a) => ({
    id: a.id, name: a.name, version: a.version, description: a.description, author: a.author, permissions: a.permissions || [],
    enabled: isEnabled(a.id), running: procs.has(a.id), tools: (a.tools || []).map((t) => ({ name: t.name, risk: t.risk || 'read' })),
    provides: a.provides || {}, settingsDef: a.settings || [], settings: settingsOf(a), accessories: (a.accessories || []).length,
  }));
}
const running = () => [...procs.keys()];

module.exports = { createPack, init, scan, summary, toolDefs, invokeTool, providersOf, callProvider, accessories, readAddonFile, installZip, download, remove, registry, stop, stopAll, running };
