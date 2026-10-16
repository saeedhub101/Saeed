#!/usr/bin/env node
// One command that catches the mistakes a quick start would miss. Runs before every build (npm run dist).
//   npm run check
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };
const files = (dir, skip = []) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
  const rel = path.join(dir, e.name);
  if (e.isDirectory()) return ['node_modules', 'vendor', ...skip].includes(e.name) ? [] : files(rel, skip);
  return e.name.endsWith('.js') ? [rel] : [];
});

console.log('Syntax');
let n = 0, before = failed;
for (const f of [...files('src/main'), ...files('scripts'), ...files('addons')]) {
  const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
  n++; if (r.status !== 0) bad(`${f}\n${r.stderr.split('\n').slice(0, 4).join('\n')}`);
}
for (const f of [...files('src/shared'), ...files('src/renderer')]) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(root, f)), encoding: 'utf8' });
  n++; if (r.status !== 0) bad(`${f}\n${r.stderr.split('\n').slice(0, 4).join('\n')}`);
}
if (failed === before) ok(`${n} files`);

console.log('Undefined names');
const lint = spawnSync(process.execPath, ['--expose-internals', path.join(__dirname, 'lint-undefined.js')], { encoding: 'utf8' });
const lintOut = lint.stdout.split('\n').filter((l) => l && !/ExperimentalWarning|node --trace/.test(l));
if (lint.status === 0) ok(lintOut.join(' ')); else { failed++; for (const l of lintOut) console.log('  FAIL ' + l); }

console.log('Modules and add-ons');
const stub = path.join(os.tmpdir(), 'saeed-check', 'node_modules', 'electron');
fs.mkdirSync(stub, { recursive: true });
fs.writeFileSync(path.join(stub, 'index.js'), `const mk = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : mk()), apply: () => mk(), construct: () => mk() });
const e = mk();
module.exports = new Proxy({}, { get: (_t, k) => { if (k === 'app') return { getPath: () => ${JSON.stringify(os.tmpdir())}, getAppPath: () => ${JSON.stringify(root)}, isPackaged: false, requestSingleInstanceLock: () => true, setAppUserModelId() {}, whenReady: () => ({ then() {} }), on() {}, getVersion: () => '0.0.0', getLoginItemSettings: () => ({}), commandLine: { appendSwitch() {} } }; if (k === 'safeStorage') return { isEncryptionAvailable: () => false }; if (k === 'screen') return { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), getAllDisplays: () => [] }; if (k === 'ipcMain') return { handle() {}, on() {} }; return e; } });
`);
const shim = path.join(os.tmpdir(), 'saeed-check', 'electron-shim.js');
// NODE_PATH has lower precedence than the project's installed node_modules, so the real
// Electron package was loaded in plain Node and exposed no app object. Force only the
// "electron" import in this isolated acceptance child to use the deterministic stub.
fs.writeFileSync(shim, `const Module = require('module');
const path = require('path');
const electronStub = path.join(${JSON.stringify(path.join(os.tmpdir(), 'saeed-check', 'node_modules', 'electron'))}, 'index.js');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') return originalLoad.call(this, electronStub, parent, isMain);
  return originalLoad.call(this, request, parent, isMain);
};
`);
const child = spawnSync(process.execPath, [path.join(__dirname, 'check-child.js')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: path.join(os.tmpdir(), 'saeed-check', 'node_modules'), NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${shim}`].filter(Boolean).join(' ') } });
process.stdout.write(child.stdout);
if (child.status !== 0) failed++;

console.log('Windows and main process talk to each other');
{
  const pre = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8'), main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const exposed = new Set([...pre.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1])), used = new Set();
  for (const f of fs.readdirSync(path.join(root, 'src/renderer'))) if (/\.(js|html)$/.test(f)) for (const m of fs.readFileSync(path.join(root, 'src/renderer', f), 'utf8').matchAll(/\bapi\.(\w+)/g)) used.add(m[1]);
  const missing = [...used].filter((x) => !exposed.has(x));
  const chMain = new Set([...main.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)].map((m) => m[1])), chPre = new Set([...pre.matchAll(/(?:call|send)\('([^']+)'/g)].map((m) => m[1]));
  const diff = [...chPre].filter((x) => !chMain.has(x)).concat([...chMain].filter((x) => !chPre.has(x)));
  if (missing.length) bad('windows use api.' + missing.join(', api.') + ' that preload does not expose');
  if (diff.length) bad('IPC channels without a partner: ' + diff.join(', '));
  if (!missing.length && !diff.length) ok('preload, handlers and windows agree');
}

console.log(failed ? `\n${failed} problem(s). Fix them before building.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
