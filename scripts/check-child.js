// Runs with an electron stub on NODE_PATH (see check.js): loads every main-process module, validates add-on manifests.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
let bad = 0;
const fail = (m) => { bad++; console.log('  FAIL ' + m); };

// 1. every main-process module must load, and export only defined things
for (const f of fs.readdirSync(path.join(root, 'src/main')).filter((x) => x.endsWith('.js') && !['addon-host.js', 'preload.js'].includes(x))) {
  try {
    const m = require(path.join(root, 'src/main', f));
    const und = Object.entries(m || {}).filter(([, v]) => v === undefined).map(([k]) => k);
    if (und.length) fail(`${f} exports undefined: ${und.join(', ')}`);
  } catch (e) { fail(`${f} does not load: ${e.message.split('\n')[0]}`); }
}
if (!bad) console.log('  ok   all main-process modules load');

// 2. add-on manifests
let CAPS = {};
try { CAPS = require(path.join(root, 'src/main/permissions.js')).CAPS; } catch { /* reported above */ }
const catList = ['files', 'web', 'data', 'voice', 'brain', 'look', 'language', 'other'];
for (const id of fs.readdirSync(path.join(root, 'addons'))) {
  const dir = path.join(root, 'addons', id);
  if (!fs.statSync(dir).isDirectory()) continue;
  let m;
  try { m = JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf8')); } catch (e) { fail(`${id}: addon.json is not valid JSON`); continue; }
  if (m.id !== id) fail(`${id}: id "${m.id}" must equal the folder name`);
  if (m.category && !catList.includes(m.category)) fail(`${id}: unknown category ${m.category}`);
  const src = fs.existsSync(path.join(dir, 'index.js')) ? fs.readFileSync(path.join(dir, 'index.js'), 'utf8') : '';
  const seen = new Set();
  for (const t of m.tools || []) {
    if (seen.has(t.name)) fail(`${id}: duplicate tool ${t.name}`); seen.add(t.name);
    for (const c of t.perm || []) if (!CAPS[c]) fail(`${id}.${t.name}: unknown permission ${c}`);
    if ((id + '__' + t.name).length > 64) fail(`${id}.${t.name}: tool name longer than 64 characters`);
    if (!(src.includes('async ' + t.name + '(') || src.includes(t.name + '(') || src.includes('uiaTools'))) fail(`${id}: no handler for tool ${t.name}`);
  }
  if (m.provides && m.provides.language) {
    const lf = path.join(dir, m.provides.language.file || 'strings.json');
    try { const j = JSON.parse(fs.readFileSync(lf, 'utf8')); if (Object.values(j).some((v) => typeof v !== 'string')) fail(`${id}: strings.json values must be text`); } catch { fail(`${id}: strings.json is missing or invalid`); }
  }
}
if (!bad) console.log('  ok   add-on manifests');
process.exit(bad ? 1 : 0);
