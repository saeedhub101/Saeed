'use strict';
// Add-on manager. Add-ons are folders with an addon.json manifest and a CommonJS entry file.
// Each add-on runs in its own utility process that is started on the first call and stopped when idle.
const { app, utilityProcess, shell } = require('electron');
const perms = require('./permissions');
const secrets = require('./secrets');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dir = () => path.join(app.getPath('userData'), 'addons');
const dataDirOf = (id) => path.join(app.getPath('userData'), 'addon-data', id);
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
let ctx = null, list = [];
const procs = new Map();

function init(c) { ctx = c; fs.mkdirSync(dir(), { recursive: true }); scan(); setTimeout(firstRun, 4000); }

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
function send(p, msg, onStream) {
  const id = ++p.seq;
  if (onStream) p.streams.set(id, onStream);
  return new Promise((resolve, reject) => { p.pending.set(id, { resolve, reject }); p.child.postMessage({ ...msg, id }); })
    .finally(() => p.streams.delete(id));
}
function start(a) {
  let p = procs.get(a.id);
  if (p) return p;
  const hostPath = path.join(__dirname, 'addon-host.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const child = utilityProcess.fork(hostPath, [], { serviceName: `saeed-${a.id}`, stdio: 'pipe' });
  p = { child, pending: new Map(), streams: new Map(), seq: 0, timer: null, since: Date.now() };
  child.on('message', (m) => {
    if (m.type === 'access' || m.type === 'trash' || m.type === 'permit' || m.type === 'secret') { hostRequest(a, child, m); return; }
    if (m.type === 'stream') { const cb = p.streams.get(m.callId); if (cb) cb(m.text); return; }
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

async function call(a, target, name, args, signal, onStream) {
  if (!isEnabled(a.id)) throw new Error(`The add-on "${a.name}" is turned off.`);
  const p = start(a);
  clearTimeout(p.timer);
  const onAbort = () => stop(a.id);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    await p.ready;
    const env = { denyPaths: perms.denyList(), settings: settingsOf(a) };
    let timeout;
    try {
      return await Promise.race([
        send(p, { type: 'call', target, name, args, env }, onStream),
        new Promise((_, rej) => { timeout = setTimeout(() => { stop(a.id); rej(new Error('The add-on took too long (5 minutes); its process was stopped.')); }, 300000); }),
      ]);
    } finally { clearTimeout(timeout); }
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
    else if (m.type === 'secret') {
      const v = secrets.get('user:' + String(m.name).replace(/^user:/, ''));
      perms.auditEvent({ addon: a.id, cap: 'secret', path: String(m.name), detail: v ? 'read' : 'missing' });
      reply(true, v);
    } else if (m.type === 'trash') {
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
async function callProvider(kind, providerId, args, signal, onStream) {
  const a = find(String(providerId).replace(/^addon:/, ''));
  if (!a) throw new Error('This provider add-on is not installed. Open Add-ons to install it.');
  return call(a, kind, '', args, signal, onStream);
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
  if (ctx.getSettings().addons.removed.includes(m.id)) ctx.setSetting((s) => { s.addons.removed = s.addons.removed.filter((x) => x !== m.id); });
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
  ctx.setSetting((s) => { if (!s.addons.removed.includes(id)) s.addons.removed.push(id); });
  fs.rmSync(path.join(dir(), id), { recursive: true, force: true });
  scan();
  if (ctx.onChange) ctx.onChange();
}

function registryUrl() {
  const s = ctx.getSettings();
  if (s.addons.registryUrl) return s.addons.registryUrl;
  return s.updates.repo ? `https://raw.githubusercontent.com/${s.updates.repo}/main/addons/registry.json` : '';
}
const cacheReg = new Map();
async function readRegistry(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return ((await r.json()).addons || []).map((e) => ({ ...e, source: url }));
}
// Included library + every online source (your repository, extra sources). Returns { list, errors }.
async function registry() {
  const s = ctx.getSettings();
  const urls = [...new Set([registryUrl(), ...(s.addons.sources || []).map((x) => x.url)].filter(Boolean))];
  const errors = [];
  const online = (await Promise.all(urls.map((u) => readRegistry(u).then((x) => { cacheReg.set(u, x); return x; }).catch((e) => { errors.push(e.message); return cacheReg.get(u) || []; })))).flat();
  const byId = new Map();
  for (const e of bundled().map((x) => ({ ...x, source: x.inApp ? 'included' : 'catalog' }))) byId.set(e.id, e);
  for (const e of online) { const cur = byId.get(e.id); if (!cur || cmp(e.version, cur.version) > 0) byId.set(e.id, e); }
  const out = [...byId.values()].map((e) => {
    const inst = find(e.id);
    return { ...e, category: e.category || 'other', installed: !!inst, installedVersion: inst ? inst.version : null, update: !!inst && cmp(e.version, inst.version) > 0 };
  });
  return { list: out, errors };
}

// A direct link: an add-on .zip is installed, a .glb is saved so it can become an accessory pack.
async function installUrl(url, onProgress) {
  const clean = String(url).trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('Paste a link that starts with http:// or https://');
  if (/\.glb(\?|#|$)/i.test(clean)) {
    const res = await fetch(clean);
    if (!res.ok) throw new Error('Download failed: ' + res.status);
    const tmp = path.join(app.getPath('temp'), `saeed-${Date.now()}.glb`);
    fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    return { glb: tmp };
  }
  const m = await download({ id: 'link', url: clean }, onProgress);
  return { addon: m.name };
}

/* ---------- the library that ships with Saeed ---------- */
// build-addons packs the add-ons into resources/addons-lib; "auto" ones are installed on first run, "offer" ones appear in the Store.
const libDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'addons-lib') : path.join(app.getAppPath(), 'build', 'addons-lib'));
function bundled() {
  try { return JSON.parse(fs.readFileSync(path.join(libDir(), 'index.json'), 'utf8')).addons || []; } catch { return []; }
}
function installBundled(id) {
  const e = bundled().find((x) => x.id === id && x.inApp);
  if (!e) throw new Error('This add-on is not packed in the installer. Download it from the Store.');
  return installZip(path.join(libDir(), e.file));
}
// First run and updates: install or upgrade the add-ons marked "auto", one at a time so the app stays responsive.
function firstRun() {
  const todo = bundled().filter((e) => e.inApp && e.bundle === 'auto' && !ctx.getSettings().addons.removed.includes(e.id)
    && (!find(e.id) || cmp(e.version, find(e.id).version) > 0));
  const next = () => {
    const e = todo.shift();
    if (!e) return;
    try { installBundled(e.id); } catch (err) { console.error('[addons] could not install', e.id, err.message); }
    setTimeout(next, 200);
  };
  next();
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

/* ---------- interface language, provided by a language add-on ---------- */
function languages() {
  const out = [{ code: 'en', name: 'English', rtl: false }];
  for (const a of list) {
    if (!isEnabled(a.id) || !a.provides || !a.provides.language) continue;
    out.push({ code: a.provides.language.code, name: a.provides.language.name || a.name, rtl: !!a.provides.language.rtl, addon: a.id });
  }
  return out;
}
function stringsFor(code) {
  if (!code || code === 'en') return { code: 'en', rtl: false, strings: {} };
  const a = list.find((x) => isEnabled(x.id) && x.provides && x.provides.language && x.provides.language.code === code);
  if (!a) return { code: 'en', rtl: false, strings: {} };
  try { return { code, rtl: !!a.provides.language.rtl, strings: JSON.parse(fs.readFileSync(path.join(a.dir, a.provides.language.file || 'strings.json'), 'utf8')) }; }
  catch { return { code: 'en', rtl: false, strings: {} }; }
}

/* ---------- info for windows ---------- */
function summary() {
  return list.map((a) => ({
    id: a.id, name: a.name, version: a.version, description: a.description, author: a.author, permissions: a.permissions || [],
    enabled: isEnabled(a.id), running: procs.has(a.id), tools: (a.tools || []).map((t) => ({ name: t.name, risk: t.risk || 'read' })),
    provides: a.provides || {}, settingsDef: a.settings || [], settings: settingsOf(a), accessories: (a.accessories || []).length, category: a.category || 'other',
  }));
}
const running = () => [...procs.keys()];

module.exports = { languages, stringsFor, installBundled, installUrl, createPack, init, scan, summary, toolDefs, invokeTool, providersOf, callProvider, accessories, readAddonFile, installZip, download, remove, registry, stop, stopAll, running };
