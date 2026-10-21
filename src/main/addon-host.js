'use strict';
// Runs inside an Electron utilityProcess: one process per add-on, started on demand and stopped when idle.
// Sensitive operations (files, trash, permissions) are not done here: they are requested from the main process,
// which applies the user's Permissions and asks when needed.
const path = require('path');

const port = process.parentPort;
let mod = null, base = null, rid = 0;
const waiting = new Map();

function reply(id, ok, payload) {
  port.postMessage(ok ? { id, ok: true, result: payload } : { id, ok: false, error: String((payload && payload.message) || payload) });
}
function request(type, data) {
  const r = ++rid;
  return new Promise((resolve, reject) => { waiting.set(r, { resolve, reject }); port.postMessage({ type, rid: r, ...data }); });
}
const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));

function makeCtx(env, callId) {
  const blocked = (env.denyPaths || []).map(norm);
  return {
    dataDir: base.dataDir, addonDir: base.dir, settings: env.settings || {},
    status: (t) => port.postMessage({ type: 'status', text: String(t) }),
    stream: (t) => port.postMessage({ type: 'stream', callId, text: String(t) }),   // partial text of a long answer
    secret: (name) => request('secret', { name }),                                  // a secret saved by the user (Settings -> Web)
    log: (...a) => console.log(...a),
    // await ctx.access(path, 'read' | 'write' | 'delete' | 'delete-permanent', detail?) -> real path (throws if refused)
    access: (p, action = 'read', detail) => request('access', { path: p, action, detail }),
    safePath: (p, action = 'read') => request('access', { path: p, action }),
    // await ctx.trash(path): moves to the Recycle Bin after the permission check
    trash: (p) => request('trash', { path: p }),
    // await ctx.permit('system.run', 'what for'): for actions that are not about a file
    permit: (cap, detail) => request('permit', { cap, detail }),
    // true when the folder is blocked by a rule (use it to skip folders while walking a tree)
    isBlocked: (p) => { const n = norm(p); return blocked.some((b) => n === b || n.startsWith(b + path.sep)); },
  };
}

port.on('message', async (e) => {
  const m = e.data;
  if (m.type === 'reply') {
    const w = waiting.get(m.rid);
    if (w) { waiting.delete(m.rid); if (m.ok) w.resolve(m.result); else w.reject(new Error(m.error)); }
    return;
  }
  try {
    if (m.type === 'init') {
      base = m;
      require('fs').mkdirSync(m.dataDir, { recursive: true });
      mod = require(path.join(m.dir, m.main));
      if (mod.activate) await mod.activate(makeCtx({}));
      reply(m.id, true, true);
    } else if (m.type === 'call') {
      const fn = m.target === 'tool' ? mod.tools && mod.tools[m.name]
        : m.target === 'stt' ? mod.stt && mod.stt.transcribe
        : m.target === 'tts' ? mod.tts && mod.tts.synthesize : null;
      if (!fn) throw new Error(`This add-on does not provide ${m.target} ${m.name || ''}`);
      reply(m.id, true, await fn(m.args, makeCtx(m.env || {}, m.id)));
    } else if (m.type === 'shutdown') {
      if (mod && mod.deactivate) await mod.deactivate();
      process.exit(0);
    }
  } catch (err) { reply(m.id, false, err); }
});
