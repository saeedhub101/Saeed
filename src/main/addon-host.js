'use strict';
// Runs inside an Electron utilityProcess: one process per add-on, started on demand and stopped when idle.
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = process.parentPort;
let mod = null, base = null;

function reply(id, ok, payload) {
  port.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String((payload && payload.message) || payload) });
}

// Resolves a path and refuses anything outside the folders the user allowed.
function safePath(p, roots) {
  const allowed = (roots && roots.length ? roots : ['Documents', 'Desktop', 'Downloads'].map((n) => path.join(os.homedir(), n))).map((r) => path.resolve(r));
  const full = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir()));
  let probe = full;
  while (!fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  const real = path.join(fs.realpathSync(probe), path.relative(probe, full));
  const norm = (x) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const ok = allowed.some((r) => {
    const rr = norm(fs.existsSync(r) ? fs.realpathSync(r) : r), x = norm(real);
    return x === rr || x.startsWith(rr + path.sep);
  });
  if (!ok) throw new Error('This path is outside the folders Saeed may use. Allowed: ' + allowed.join('; ') + '. The user can add folders in Settings → Agent.');
  return real;
}

function makeCtx(env) {
  return {
    dataDir: base.dataDir, addonDir: base.dir, settings: env.settings || {}, allowedFolders: env.allowedFolders || [],
    status: (t) => port.postMessage({ type: 'status', text: String(t) }),
    log: (...a) => console.log(...a),
    safePath: (p) => safePath(p, env.allowedFolders),
  };
}

port.on('message', async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      base = m;
      fs.mkdirSync(m.dataDir, { recursive: true });
      mod = require(path.join(m.dir, m.main));
      if (mod.activate) await mod.activate(makeCtx({}));
      reply(m.id, true, true);
    } else if (m.type === 'call') {
      const fn = m.target === 'tool' ? mod.tools && mod.tools[m.name]
        : m.target === 'stt' ? mod.stt && mod.stt.transcribe
        : m.target === 'tts' ? mod.tts && mod.tts.synthesize : null;
      if (!fn) throw new Error(`This add-on does not provide ${m.target} ${m.name || ''}`);
      reply(m.id, true, await fn(m.args, makeCtx(m.env || {})));
    } else if (m.type === 'shutdown') {
      if (mod && mod.deactivate) await mod.deactivate();
      process.exit(0);
    }
  } catch (err) { reply(m.id, false, err); }
});
