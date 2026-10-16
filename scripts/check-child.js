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

/* 2c. failed-call guard is exercised in an async helper check launched before process exit. */
try {
  const runnerFactory = require(path.join(root, 'src/main/llm.js'))._test.createToolRunner;
  (async () => {
    let calls = 0;
    const runner = runnerFactory(async (_name, args) => { calls++; return args.path === 'missing' ? 'Error: file not found' : 'Saved successfully'; }, { aborted: false });
    await runner('write_file', { path: 'missing' });
    await runner('write_file', { path: 'missing' });
    if (calls !== 1) throw new Error('identical failed tool call was executed twice');
    await runner('write_file', { path: 'corrected' });
    if (calls !== 2) throw new Error('corrected arguments were blocked after an earlier failure');
  })().catch((e) => { console.error('  FAIL tool-call retry guard: ' + e.message); process.exitCode = 1; });
} catch (e) { fail('tool-call retry guard could not load: ' + e.message); }

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
  // Guard the live local-LLM path against a regression that passed syntax-only checks:
  // the selected tool list must exist before it is used to construct the chat session.
  const localSource = fs.readFileSync(path.join(root, 'addons/llm-llamacpp/index.js'), 'utf8');
  const completeStart = localSource.indexOf('async complete({ system, messages, tools }, ctx)');
  const completeEnd = localSource.indexOf('async deactivate()', completeStart);
  const completeSource = localSource.slice(completeStart, completeEnd < 0 ? undefined : completeEnd);
  const activeToolsAt = completeSource.indexOf('const activeTools = selectLocalTools(tools, messages)');
  const sessionAt = completeSource.indexOf('new LlamaChatSession(');
  if (activeToolsAt < 0 || sessionAt < 0 || activeToolsAt > sessionAt) fail('local LLM initializes its chat session before selecting active tools');
  if (!/systemPrompt:\s*String\(system \|\| ''\) \+ toolInstructions\(activeTools\)/.test(completeSource)) fail('local LLM session prompt does not use the selected tool catalogue');
  if (!/text:\s*String\(system \|\| ''\) \+ toolInstructions\(activeTools\)/.test(completeSource)) fail('local LLM chat history does not use the selected tool catalogue');
  const selectTools = require(path.join(root, 'addons/llm-llamacpp/index.js')).__test.selectLocalTools;
  const catalogue = [
    { name: 'confirm_with_user' }, { name: 'open_item' }, { name: 'web_search' },
    { name: 'excel__read_workbook' }, { name: 'word__create_document' },
    { name: 'browser__click' }, { name: 'desktop-control__ui_read' }, { name: 'database__query' },
    { name: 'run_command' }, { name: 'http_request' },
  ];
  const excelTools = selectTools(catalogue, [{ role: 'user', text: 'أنشئ تقرير Excel' }]);
  if (!excelTools.some((t) => t.name === 'excel__read_workbook')) fail('local tool router missed Excel tools for an Arabic Excel request');
  if (excelTools.some((t) => t.name === 'run_command' || t.name === 'http_request')) fail('local tool router exposed raw command/API tools for a normal Excel task');
  const staleCommandHistory = selectTools(catalogue, [
    { role: 'user', text: 'شغل أمر PowerShell لفحص الملفات' },
    { role: 'assistant', text: 'تم فحص الملفات.' },
    { role: 'user', text: 'أنشئ تقرير Excel' },
  ]);
  if (staleCommandHistory.some((t) => t.name === 'run_command' || t.name === 'http_request')) fail('local tool router retained privileged tools from an unrelated prior request');
  const followUpTools = selectTools(catalogue, [
    { role: 'user', text: 'شغل أمر PowerShell لفحص الملفات' },
    { role: 'assistant', text: 'هل أتابع؟' },
    { role: 'user', text: 'نعم، تابع' },
  ]);
  if (!followUpTools.some((t) => t.name === 'run_command')) fail('local tool router lost task tools on a short Arabic follow-up');
  const commandTools = selectTools(catalogue, [{ role: 'user', text: 'شغل أمر PowerShell لفحص الملفات' }]);
  if (!commandTools.some((t) => t.name === 'run_command')) fail('local tool router missed run_command for an explicit Arabic PowerShell request');
  const apiTools = selectTools(catalogue, [{ role: 'user', text: 'Call the REST API endpoint with an HTTP request' }]);
  if (!apiTools.some((t) => t.name === 'http_request')) fail('local tool router missed HTTP tools for an explicit API request');
  const mixedTools = selectTools(catalogue, [{ role: 'user', text: 'افتح الموقع ثم اقرأ جدول البيانات في Excel' }]);
  if (!mixedTools.some((t) => t.name === 'browser__click') || !mixedTools.some((t) => t.name === 'excel__read_workbook')) fail('local tool router failed to preserve multiple relevant tool families in a mixed request');
  if (mixedTools.some((t) => t.name === 'run_command' || t.name === 'http_request')) fail('local tool router exposed privileged core tools through semantic fallback');
  const browserTools = selectTools(catalogue, [{ role: 'user', text: 'افتح صفحة في المتصفح واضغط الزر' }]);
  if (!browserTools.some((t) => t.name === 'browser__click') || !browserTools.some((t) => t.name === 'desktop-control__ui_read')) fail('local tool router missed browser and desktop tools for an Arabic UI request');
  const cognitivePrompt = require(path.join(root, 'src/main/brain.js')).defaultPrompt();
  for (const rule of [
    'concise internal ordered plan',
    'Treat tool output as evidence',
    'independent read-back or status check',
    'Preserve the user',
    'passing build is not proof',
  ]) if (!cognitivePrompt.includes(rule)) fail('core agent instructions missing: ' + rule);
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
  if (!policy('browser__click', { id: 7, label: 'Submit payment' })) fail('confirmation policy did not protect a browser payment button');
  if (policy('browser__click', { id: 7, label: 'Open menu' })) fail('confirmation policy incorrectly blocked a harmless browser click');
  if (!policy('desktop-control__ui_click', { name: 'Delete record' })) fail('confirmation policy did not protect a destructive desktop control');
  if (policy('database__execute', { sql: 'SELECT * FROM customers' })) fail('confirmation policy incorrectly blocked a read-only database query');
  const signature = require(path.join(root, 'src/main/brain.js')).confirmationSignature;
  if (signature('delete_path', { path: 'Documents/a.txt' }) === signature('delete_path', { path: 'Documents/b.txt' })) fail('confirmation signature did not bind approval to the exact target');
  if (signature('delete_path', { path: 'Documents/a.txt', permanent: true }) !== signature('delete_path', { permanent: true, path: 'Documents/a.txt' })) fail('confirmation signature depends on object key order');
  const mainLifecycleSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  if (!mainLifecycleSource.includes('function persistCfg()') || !mainLifecycleSource.includes("fs.renameSync(tmp, target)")) fail('configuration persistence is not atomic');
  if (!mainLifecycleSource.includes("app.on('before-quit'") || !mainLifecycleSource.includes('persistCfg();')) fail('configuration is not flushed before application exit');
  const historySource = fs.readFileSync(path.join(root, 'src/main/brain.js'), 'utf8');
  if (!historySource.includes('function persistHistory()') || !historySource.includes("fs.renameSync(tmp, target)")) fail('conversation history is not persisted atomically');
  if (!historySource.includes('function flushHistory()') || !historySource.includes('flushHistory,')) fail('conversation history has no explicit flush operation');
  if (!mainLifecycleSource.includes('brain.flushHistory()')) fail('conversation history is not flushed before application exit');
  const skillsSource = fs.readFileSync(path.join(root, 'src/main/skills.js'), 'utf8');
  if (!/function removeAt\(i\).*Number\.isInteger\(index\).*index < 0.*index >= l\.length/.test(skillsSource)) fail('learned-skill removal does not validate its index');
  if (!mainLifecycleSource.includes("ipcMain.handle('skills:remove', (_e, i) => skills.removeAt(i))")) fail('skills removal IPC does not return the actual result');
  const addonsSource = fs.readFileSync(path.join(root, 'src/main/addons.js'), 'utf8');
  if (!addonsSource.includes('finally { clearTimeout(timeout); }')) fail('add-on call timeout timer is not cleaned up');
  if (!addonsSource.includes('p.pending.clear();') || !addonsSource.includes('p.streams.clear();')) fail('exited add-on processes retain pending IPC or stream references');
  if (!addonsSource.includes('if (procs.get(a.id) !== p) return;')) fail('add-on idle timer does not verify process ownership');
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
