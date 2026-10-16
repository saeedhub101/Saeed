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

/* 3. local brain tool-call parsing: tolerant of common formatting, strict about allowed names and schemas. */
try {
  const parse = require(path.join(root, 'addons/llm-llamacpp/index.js')).__test.parseToolCall;
  const defs = [
    { name: 'open_item', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'express', schema: { type: 'object', properties: { intent: { type: 'string', enum: ['happy', 'sit'] } }, required: ['intent'] } },
  ];
  const cases = [
    ['plain JSON', '{"tool_call":{"name":"open_item","args":{"name":"Excel"}}}', 'open_item'],
    ['fenced JSON', '```json' + String.fromCharCode(10) + '{"tool_call":{"name":"open_item","args":{"name":"Excel"}}}' + String.fromCharCode(10) + '```', 'open_item'],
    ['JSON in explanation', 'سأفتح البرنامج الآن. {"tool_call":{"name":"open_item","args":{"name":"Excel"}}}', 'open_item'],
    ['stringified arguments', JSON.stringify({ function_call: { name: 'open_item', arguments: JSON.stringify({ name: 'Excel' }) } }), 'open_item'],
    ['OpenAI-style tool_calls', JSON.stringify({ tool_calls: [{ function: { name: 'open_item', arguments: JSON.stringify({ name: 'Excel' }) } }] }), 'open_item'],
    ['tool-call tag', '<tool_call>{"name":"open_item","arguments":{"name":"Excel"}}</tool_call>', 'open_item'],
  ];
  for (const [label, input, expected] of cases) {
    const result = parse(input, defs);
    if (!result.length || result[0].name !== expected || result[0].args.name !== 'Excel') fail('local tool parser: ' + label);
  }
  if (parse('{"tool_call":{"name":"delete_everything","args":{}}}', defs).length) fail('local tool parser accepted an unknown tool');
  if (parse('{"tool_call":{"name":"open_item","args":{}}}', defs).length) fail('local tool parser accepted missing required arguments');
  if (parse('{"tool_call":{"name":"express","args":{"intent":"destroy"}}}', defs).length) fail('local tool parser accepted an invalid enum');
  if (parse('Example JSON only: {"name":"open_item","args":{"name":"Excel"}}', defs).length) fail('local tool parser executed an ordinary JSON example in prose');
  const validate = require(path.join(root, 'src/main/brain.js')).validateToolArgs;
  const nested = { type: 'object', properties: { profile: { type: 'object', properties: { age: { type: 'integer', minimum: 0 } }, required: ['age'] } }, required: ['profile'] };
  if (validate({ profile: { age: 8 } }, nested) !== null) fail('central tool validator rejected valid nested arguments');
  if (!validate({ profile: {} }, nested)) fail('central tool validator accepted missing nested required arguments');
  if (!validate({ profile: { age: -1 } }, nested)) fail('central tool validator accepted out-of-range numeric arguments');
  const policy = require(path.join(root, 'src/main/brain.js')).confirmationReason;
  if (!policy('delete_path', { path: 'Documents/old.txt' })) fail('confirmation policy did not protect deletion');
  if (policy('http_request', { method: 'GET', url: 'https://example.com' })) fail('confirmation policy incorrectly blocked a read-only HTTP request');
  if (!policy('http_request', { method: 'POST', url: 'https://example.com' })) fail('confirmation policy did not protect an external write request');
  if (!policy('database__execute', { sql: 'UPDATE customers SET active = 0' })) fail('confirmation policy did not protect database writes');
  if (policy('database__execute', { sql: 'SELECT * FROM customers' })) fail('confirmation policy incorrectly blocked a read-only database query');
  const signature = require(path.join(root, 'src/main/brain.js')).confirmationSignature;
  if (signature('delete_path', { path: 'Documents/a.txt' }) === signature('delete_path', { path: 'Documents/b.txt' })) fail('confirmation signature did not bind approval to the exact target');
  if (signature('delete_path', { path: 'Documents/a.txt', permanent: true }) !== signature('delete_path', { permanent: true, path: 'Documents/a.txt' })) fail('confirmation signature depends on object key order');
  const brainModule = require(path.join(root, 'src/main/brain.js'));
  const confirmSchema = brainModule.toolDefs().find((t) => t.name === 'confirm_with_user').schema;
  if (validate({ question: 'Proceed?' }, confirmSchema) === null) fail('confirmation tool accepted an unscoped approval request');
  if (validate({ question: 'Delete?', actionName: 'delete_path', actionArgs: { path: 'Documents/a.txt' } }, confirmSchema) !== null) fail('confirmation tool rejected a properly scoped approval request');
  if (!bad) console.log('  ok   local brain tool-call parsing and schema validation');
} catch (e) { fail('local brain tool-call tests could not run: ' + e.message); }

(async () => {
  try {
    const brain = require(path.join(root, 'src/main/brain.js'));
    const deletion = await brain.execTool({}, 'delete_path', { path: 'Documents/should-not-be-deleted.txt' });
    if (!String(deletion).startsWith('Action paused: explicit confirmation is required')) fail('shared executor allowed deletion without confirmation');
    const mismatched = await brain.execTool({}, 'delete_path', { path: 'Documents/should-not-be-deleted.txt' }, {
      policy: { confirmedAction: brain.confirmationSignature('delete_path', { path: 'Documents/a-different-file.txt' }) },
    });
    if (!String(mismatched).startsWith('Action paused: explicit confirmation is required')) fail('shared executor accepted confirmation for a different target');
    const externalWrite = await brain.execTool({}, 'http_request', { method: 'POST', url: 'https://example.com', body: {} });
    if (!String(externalWrite).startsWith('Action paused: explicit confirmation is required')) fail('shared executor allowed an external write without confirmation');
    if (!bad) console.log('  ok   shared executor blocks unconfirmed or mismatched high-impact actions');
  } catch (e) { fail('shared executor policy tests could not run: ' + e.message); }
  process.exit(bad ? 1 : 0);
})();
