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

/* 2b. agent orchestration must recover from tool errors and synthesize the last tool result. */
try {
  const agentSource = fs.readFileSync(path.join(root, 'src/main/llm.js'), 'utf8');
  const required = [
    ['Anthropic final synthesis', "const final = await anthropicCall", 'tools: []'],
    ['OpenAI final synthesis', "const final = await openaiCall", "tool_choice: 'none'"],
    ['local add-on final synthesis', "const final = await addons.callProvider", 'tools: []'],
  ];
  for (const [label, first, second] of required) {
    const start = agentSource.indexOf(first);
    if (start < 0 || !agentSource.slice(start, start + 800).includes(second)) fail(label + ' is missing after the tool-step limit');
  }
  if (!agentSource.includes('function createToolRunner')) fail('agent does not guard against repeated failed tool calls');
  if (!agentSource.includes("Object.defineProperty(b, '_invalidInput'")) fail('Anthropic parser does not mark malformed tool JSON');
  if (!agentSource.includes('u._invalidInput')) fail('Anthropic agent may execute malformed tool JSON');
  if (!agentSource.includes('if (signal && signal.aborted) throw error')) fail('agent swallows cancellation while recovering from tool errors');
  const llmTest = require(path.join(root, 'src/main/llm.js'))._test;
  if (llmTest.parseToolArguments('{"path":"ok"}').path !== 'ok') fail('valid tool JSON arguments were not parsed');
  for (const malformed of ['{bad json', '[]', 'null', '"text"']) {
    let rejected = false; try { llmTest.parseToolArguments(malformed); } catch { rejected = true; }
    if (!rejected) fail('invalid tool arguments were accepted: ' + malformed);
  }
  const autoSearchCases = [
    ['Where is Rome?', true],
    ['What is photosynthesis?', true],
    ['How does a solar panel work?', true],
    ['What is the weather in Jordan today?', true],
    ['كم الساعة في إيطاليا؟', true],
    ['أين تقع روما؟', true],
    ['ما عاصمة إيطاليا؟', true],
    ['Open Excel', false],
    ['How do I open Excel?', false],
    ['افتح الإكسل', false],
    ['احسب 2 + 2', false],
  ];
  for (const [question, expected] of autoSearchCases) {
    if (llmTest.shouldAutoSearch(question) !== expected) fail('automatic web-search classification mismatch for: ' + question);
  }
  const reasoningSettings = { llm: { reasoningEffort: 'high' } };
  if (llmTest.requestOptions(reasoningSettings, 'openai', 'gpt-5.1').reasoning_effort !== 'high') fail('GPT-5 reasoning effort was not enabled');
  if (llmTest.requestOptions(reasoningSettings, 'openai', 'gpt-5-mini').reasoning_effort !== 'high') fail('GPT-5 mini reasoning effort was not enabled');
  if (llmTest.requestOptions(reasoningSettings, 'openai', 'gpt-6-astra').reasoning_effort !== 'high') fail('GPT-6 reasoning effort was not enabled');
  if (llmTest.requestOptions({ llm: { reasoningEffort: 'max' } }, 'openai', 'gpt-6-astra').reasoning_effort !== 'max') fail('GPT-6 maximum reasoning effort was not enabled');
  if (llmTest.requestOptions({ llm: { reasoningEffort: 'max' } }, 'openai', 'gpt-5.1').reasoning_effort !== 'high') fail('unsupported maximum reasoning leaked to GPT-5');
  if (Object.keys(llmTest.requestOptions(reasoningSettings, 'custom', 'gpt-5.1')).length) fail('reasoning parameters leaked to an arbitrary OpenAI-compatible provider');
  const updaterTest = require(path.join(root, 'src/main/updater.js'))._test;
  const defaultFeed = updaterTest.repository('');
  if (defaultFeed.owner !== 'saeedhub101' || defaultFeed.repo !== 'Saeed') fail('updater does not default to the official Saeed release repository');
  const configuredFeed = updaterTest.repository('https://github.com/example/saeed.git');
  if (configuredFeed.owner !== 'example' || configuredFeed.repo !== 'saeed') fail('updater does not normalize configured GitHub repository URLs');
  for (const invalidRepo of ['https://example.com/evil', 'owner', 'owner/name/extra']) {
    let rejected = false; try { updaterTest.repository(invalidRepo); } catch { rejected = true; }
    if (!rejected) fail('updater accepted an invalid GitHub repository path: ' + invalidRepo);
  }
  const defaults = require(path.join(root, 'src/main/settings.js')).DEFAULT_SETTINGS;
  if (defaults.llm.anthropic.model !== 'claude-sonnet-5' || defaults.llm.openai.model !== 'gpt-6-astra') fail('default brain models are not current reasoning-capable choices');
  if (defaults.llm.provider !== 'openai') fail('new Saeed installs do not default to the GPT-6 brain');
  if (defaults.llm.reasoningEffort !== 'max') fail('new Saeed installs do not default to maximum GPT-6 reasoning');
  if (defaults.updates.repo !== 'saeedhub101/Saeed') fail('default updater repository is not the official Saeed repository');
} catch (e) { fail('agent orchestration checks could not run: ' + e.message); }

/* 2c. failed-call guard is awaited before the acceptance process exits. */
let retryGuardTest = Promise.resolve();
try {
  const runnerFactory = require(path.join(root, 'src/main/llm.js'))._test.createToolRunner;
  retryGuardTest = (async () => {
    let calls = 0;
    const runner = runnerFactory(async (_name, args) => { calls++; return args.path === 'missing' ? 'Error: file not found' : 'Saved successfully'; }, { aborted: false });
    await runner('write_file', { path: 'missing' });
    await runner('write_file', { path: 'missing' });
    if (calls !== 1) throw new Error('identical failed tool call was executed twice');
    await runner('write_file', { path: 'corrected' });
    if (calls !== 2) throw new Error('corrected arguments were blocked after an earlier failure');
  })();
} catch (e) { fail('tool-call retry guard could not load: ' + e.message); }

/* 2d. long-term memory retrieval prioritizes relevant facts instead of dumping the whole memory. */
try {
  const rankFacts = require(path.join(root, 'src/main/memory.js'))._test.rankFacts;
  const facts = [
    { text: 'User prefers Arabic responses and works in Jordan', t: 3 },
    { text: 'Saeed development happens on main branch only', t: 2 },
    { text: 'Excel reports should include annual tax calculations', t: 1 },
    { text: 'The user prefers concise answers', t: 4 },
  ];
  const selected = rankFacts(facts, 'تطوير سعيد على main', 3).map((x) => x.text);
  if (!selected.some((x) => x.includes('main branch'))) fail('memory retrieval missed a directly relevant fact');
  if (selected.some((x) => x.includes('Excel reports'))) fail('memory retrieval included an unrelated fact ahead of relevant context');
} catch (e) { fail('memory retrieval checks could not run: ' + e.message); }

/* 2g. conversation recall recovers relevant older exchanges without treating them as active instructions. */
try {
  const recall = require(path.join(root, 'src/main/brain.js'))._test;
  const history = [
    { role: 'user', text: 'نريد تطوير سعيد على main فقط', t: 1 },
    { role: 'assistant', text: 'سأحافظ على فرع main وأطور العقل الحقيقي', t: 2 },
    { role: 'user', text: 'أنشئ تقرير ضريبة Excel سنوي', t: 3 },
    { role: 'assistant', text: 'سأحسب الضريبة الشهرية والسنوية في Excel', t: 4 },
    { role: 'user', text: 'افتح المتصفح', t: 5 },
    { role: 'assistant', text: 'تم فتح المتصفح', t: 6 },
  ];
  const ranked = recall.rankHistoryPairs(history, 'واصل تطوير سعيد على main', 2);
  if (!ranked.length || !ranked[0].userText.includes('تطوير سعيد')) fail('conversation recall missed a relevant older Arabic project exchange');
  if (ranked.some((x) => x.userText.includes('تقرير ضريبة'))) fail('conversation recall selected an unrelated older task');
  const context = recall.historyContext(history, 'واصل تطوير سعيد على main', 2);
  if (!context.includes('historical context only') || !context.includes('تطوير سعيد')) fail('recalled context is missing relevance or historical-only boundaries');
  if (recall.historyContext(history, 'xyz qqq zzz', 2) !== '') fail('conversation recall injected unrelated history when no match existed');
} catch (e) { fail('conversation recall checks could not run: ' + e.message); }

/* 2f. Arabic error results are treated as failures rather than successful tool evidence. */
try {
  const brainSource = fs.readFileSync(path.join(root, 'src/main/brain.js'), 'utf8');
  const agentSource = fs.readFileSync(path.join(root, 'src/main/llm.js'), 'utf8');
  if (!brainSource.includes('لم يتم العثور|لم أتمكن|تعذر|مرفوض|غير موجود|لا يوجد|لم ينجح|فشل|خطأ|رفض')) fail('brain does not classify common Arabic tool failures');
  if (!agentSource.includes('لم يتم العثور|لم أتمكن|تعذر|مرفوض|غير موجود|لا يوجد|لم ينجح|فشل|خطأ|رفض')) fail('agent retry guard does not recognize common Arabic tool failures');
} catch (e) { fail('Arabic failure-classification checks could not run: ' + e.message); }

/* 2e. skill retrieval normalizes Arabic and ranks directly relevant workflows above vague matches. */
try {
  const scoreSkill = require(path.join(root, 'src/main/skills.js'))._test.scoreSkill;
  const target = { name: 'Create Excel report', app: 'Microsoft Excel', keywords: 'اكسل تقرير ضريبة سنوي', uses: 2, failures: 0 };
  const unrelated = { name: 'Open browser', app: 'Chrome', keywords: 'website login', uses: 10, failures: 0 };
  if (scoreSkill(target, 'أنشئ تقرير اكسل للضريبة السنوية') <= scoreSkill(unrelated, 'أنشئ تقرير اكسل للضريبة السنوية')) fail('skill retrieval failed to prioritize a matching Arabic workflow');
} catch (e) { fail('skill retrieval checks could not run: ' + e.message); }

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
  const recoveryTools = selectTools(catalogue, [
    { role: 'user', text: 'ساعدني في المهمة' },
    { role: 'assistant', text: '[Requested tool: browser__click]' },
    { role: 'tool', name: 'browser__click', text: 'Could not find element. The task needs reading an Excel workbook.' },
  ]);
  if (!recoveryTools.some((t) => t.name === 'excel__read_workbook')) fail('local tool router did not use recent tool failure context to discover an alternate add-on');
  if (recoveryTools.some((t) => t.name === 'run_command' || t.name === 'http_request')) fail('local recovery routing exposed raw command/API tools from tool-result text');
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
    'newest user request as the active goal',
    'every requested deliverable',
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
    const actions = require(path.join(root, 'src/main/actions.js'));
    const defaults = require(path.join(root, 'src/main/settings.js')).DEFAULT_SETTINGS;
    for (const greeting of ['hello', 'Hi', 'good morning', 'مرحبا', 'السلام عليكم', 'كيفك']) {
      if (!actions.isGreeting(greeting)) fail('offline greeting was not recognized: ' + greeting);
      const result = await actions.route(greeting, defaults);
      if (!result || !result.reply || result.intent !== 'greet') fail('offline greeting did not produce a local response: ' + greeting);
    }
    if (actions.isGreeting('hello, please create a spreadsheet')) fail('greeting matcher swallowed a real task request');
    const pipelineSource = fs.readFileSync(path.join(root, 'src/main/pipeline.js'), 'utf8');
    if (!pipelineSource.includes('s.commands.local || actions.isGreeting(text)')) fail('greetings still depend on the optional local-commands setting');
    const defaults = require(path.join(root, 'src/main/settings.js')).DEFAULT_SETTINGS;
    const whisperManifest = JSON.parse(fs.readFileSync(path.join(root, 'addons/whisper-local/addon.json'), 'utf8'));
    if (defaults.stt.provider !== 'addon:whisper-local') fail('new installs do not default to offline speech recognition');
    if (defaults.addons.enabled['whisper-local'] !== true) fail('local speech recognition is not enabled by default');
    if (whisperManifest.bundle !== 'auto') fail('local speech recognition is not included in the installer');
    const mainSource = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
    if (!mainSource.includes("cfg.settings.stt.provider = 'addon:whisper-local'")) fail('existing installs do not migrate away from cloud STT when no key is configured');
    const llmSource = fs.readFileSync(path.join(root, 'src/main/llm.js'), 'utf8');
    if (!llmSource.includes('No OpenAI API key is configured')) fail('missing OpenAI credentials do not produce a clear actionable error');
    if (!llmSource.includes('select a configured local brain')) fail('missing-key guidance does not mention a local brain option');
    if (!bad) console.log('  ok   greetings work locally without an API key');
  } catch (e) { fail('offline greeting checks could not run: ' + e.message); }
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
  await retryGuardTest.catch((e) => fail('tool-call retry guard: ' + e.message));
  process.exit(bad ? 1 : 0);
})();
