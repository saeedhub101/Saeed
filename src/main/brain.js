'use strict';
// The brain: one shared conversation history (voice + chat) and the tool-using LLM loop.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const llm = require('./llm');
const actions = require('./actions');
const addons = require('./addons');
const core = require('./tools-core');
const memory = require('./memory');
const skills = require('./skills');
const { dialog } = require('electron');

const INTENTS = ['happy', 'sad', 'think', 'yes', 'no', 'greet', 'bow', 'sit', 'lie', 'sleep', 'stand', 'wink', 'smile', 'surprised', 'angry', 'worried', 'laugh', 'tongue', 'kiss'];
const DEFAULT_PROMPT = [
  'You are Saeed, a friendly desktop assistant shown as a 3D character on the user\'s PC, and a capable agent.',
  'Reply in the same language the user writes or speaks (Arabic or English). Treat spelling mistakes, dialect, transliteration and incomplete phrasing as normal; infer likely intent from context and ask only when a missing detail materially changes the action or result.',
  'Your answer is read aloud: use short natural sentences, no markdown, no lists, no emoji. For long results (tables, reports) put them in a file with the tools and say where it is.',
  'Use the express tool to show an emotion or posture when it fits (do not overuse it).',
  'You can act like a capable person at the computer: find files by name anywhere with find_files (never ask the user for a path you can find yourself), open them with open_path, read them, search the internet in the background with web_search and web_fetch, call web APIs with http_request, run commands with run_command, and remember lasting facts with remember.',
  'Do not assume you lack access: try the matching available tool first (find_files, write_file, open_path, web_search, UI/browser tools). If a tool is unavailable, fails or is refused, report the exact limitation and use a sensible permitted alternative; never claim access or success without evidence. For a new file or folder without a full path, prefer the user\'s Desktop, Documents or Downloads rather than asking for their home path. If a call is refused, use its actual reason (permission, missing item, wrong name) to decide the next step.',
  'Use open_item for apps (Excel, Word, My Computer...), get_time for the time, and set_reminder when asked to remind.',
  'Use the other tools (files, Excel, Word, PDF, OCR...) when they are available and the task needs them: read before you change anything, never invent data, and report what you did in one or two sentences.',
  'To work inside another program: first EXPLORE it (ui_tree / explore_window; take a screenshot only if that gives nothing useful) rather than guessing coordinates. Prefer UI Automation tools (ui_tree, ui_read, ui_set_text, ui_click) over clicking by pixel position when a control has a name or automationId.',
  'For every request, first classify the goal, constraints, available context and expected deliverable. For multi-step tasks, build a concise internal ordered plan with dependencies; do not expose private chain-of-thought. Use tools to gather missing facts instead of guessing, and ask only for information that cannot be safely inferred or retrieved.',
  'Treat tool output as evidence, not as proof of completion. After each call, inspect its actual result. If it reports an error, denial, empty result, timeout or unexpected state, diagnose the cause and try a meaningfully different permitted approach; never repeat an identical failed call without a reason. Keep going while useful alternatives and step budget remain.',
  'Before finalizing a task that changes data or performs several actions, use an independent read-back or status check to verify the final state against the original request. If verification is unavailable or fails, state exactly what is unverified; do not turn a successful click, command launch or file write response into a claim that the whole task succeeded.',
  'Treat the newest user request as the active goal; use earlier messages for constraints and context, but do not resume an unrelated older task unless the new message clearly refers to it. For multi-part requests, maintain an internal checklist of every requested deliverable, complete all feasible items rather than stopping after the first, and compare each item against evidence before the final answer. If blocked, identify the exact blocker and continue with independent parts.',
  'Preserve the user\'s constraints across follow-up messages. A short reply such as yes, continue, do that, or fix it refers to the current pending task unless context indicates otherwise. Apply corrections immediately, update the plan, and do not restart unrelated work or ask the user to repeat known details.',
  'For research and analysis, separate observed facts from assumptions, cross-check important claims when tools allow, and reconcile conflicting evidence. For code changes, inspect relevant implementation and callers, make the smallest coherent change, consider failure paths, and run relevant checks; a passing build is not proof that product behavior is complete.',
  'Work in small steps and re-explore after each one. If the screen does not match what you expected (a dialog appeared, a field is missing, a save failed), stop acting blindly, explore again, and adjust the plan instead of repeating the same clicks.',
  'Before filling a form, compare the supplied data with required fields; if a required value is missing, ask the user in chat instead of guessing it. Reserve confirm_with_user for explicit approval of high-impact actions.',
  'VERIFY before you say a task is done: re-read the screen or the record after saving and check it matches what was asked. Never report success you have not checked.',
  'Always call recall_skills with a short description of the task before doing any work in a program, a website or a database, even if you think you already know how — a matching skill, if one exists, is given to you with its exact steps and saves you from exploring from scratch, which is both faster and more reliable. When one matches well, follow it directly instead of re-exploring, but still verify the result.',
  'You do not need to remember to save a skill yourself: Saeed records the steps of any completed multi-step task in a program, website or database automatically in the background. Still call learn_skill yourself when you want to add something the automatic recording cannot know, such as what a field actually means, a rule to always follow, or a correction (use update_skill with outcome: \'failure\' when a saved skill turns out wrong or the screen changed, so it stops being suggested).',
  'Before an irreversible step in any system (submit, issue, send, pay, delete, overwrite), call confirm_with_user with a clear question AND pass actionName plus actionArgs exactly matching the tool call you want to make next. A yes approves only that exact tool and those exact arguments; if they change, ask again.',
  'For logging in, signing up, or anything on a site that needs the user\'s own account: open the browser with visible:true so the user can see it and step in for a CAPTCHA or a code, and tell them briefly that you opened it. Big sites often load the login form a moment after the page itself, or hide it behind a button like "Log in" or "Sign up" that must be clicked first - if a field you expect is not in the last snapshot, click what opens the form, wait briefly, then take a fresh snapshot before concluding the field does not exist. Never report a field as missing from only the first snapshot.',
  'If you cannot do something, say so briefly and say which add-on would be needed.',
].join(' ');

const CORE_TOOLS = [
  { name: 'express', description: 'Show an emotion, gesture or posture on the 3D character.',
    schema: { type: 'object', properties: { intent: { type: 'string', enum: INTENTS } }, required: ['intent'] } },
  { name: 'open_item', description: 'Open an app, folder or file for the user: Excel, Word, PowerPoint, Notepad, Calculator, My Computer, Downloads, Documents, or an item from the user\'s quick launch list.',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_time', description: 'Get the current local date and time.', schema: { type: 'object', properties: {} } },
  { name: 'confirm_with_user', description: 'Ask the user a yes/no question in a window and wait for the answer. Before an irreversible action, include actionName and actionArgs exactly matching the tool call you want to perform next; a yes approves only that exact action.',
    schema: { type: 'object', properties: { question: { type: 'string' }, actionName: { type: 'string', description: 'Exact tool name of the action being confirmed' }, actionArgs: { type: 'object', description: 'Exact arguments for that action' } }, required: ['question', 'actionName', 'actionArgs'] } },
  { name: 'recall_skills', description: 'Look up skills you previously learned that might apply to the current task (by name, app or keywords).',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'learn_skill', description: 'Save a skill after successfully completing a multi-step task in a program or system, so it is faster and more reliable next time. Give the exact sequence of steps that worked (tool calls and field names, not coordinates), and how to verify it succeeded. Give the same name and app again to update an existing skill.',
    schema: { type: 'object', properties: { name: { type: 'string' }, app: { type: 'string', description: 'The program or system this is for' }, keywords: { type: 'string', description: 'Comma-separated words a future request might use' },
      steps: { type: 'string', description: 'The steps that worked, as clear instructions' }, fields: { type: 'object', description: 'Field name -> how to find it (e.g. automationId or label)' },
      verify: { type: 'string', description: 'How to check it worked' }, notes: { type: 'string' } }, required: ['name', 'steps'] } },
  { name: 'update_skill', description: 'Correct a previously learned skill, or record that it failed this time.',
    schema: { type: 'object', properties: { id: { type: 'string' }, steps: { type: 'string' }, verify: { type: 'string' }, notes: { type: 'string' }, outcome: { type: 'string', enum: ['success', 'failure'] } }, required: ['id'] } },
  { name: 'forget_skill', description: 'Delete a learned skill that is no longer right.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
const toolDefs = () => [...CORE_TOOLS, ...core.defs(), ...addons.toolDefs()];

// High-impact actions require an explicit yes for that next action, even if a permission
// capability is configured to allow the underlying operation.
function confirmationSignature(name, args) {
  const stable = (value) => Array.isArray(value) ? value.map(stable)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return JSON.stringify({ name: String(name || ''), args: stable(args || {}) });
}

function confirmationReason(name, args) {
  const highImpactLabel = /\b(submit|send|pay|delete|remove|overwrite|save|purchase|issue|approve|confirm|place order)\b|حذف|ارسال|إرسال|دفع|حفظ|اصدار|إصدار|موافقه|موافقة/i;
  if (name === 'browser__click' && highImpactLabel.test(String(args.label || ''))) return 'clicking the browser control "' + args.label + '"';
  if (name === 'desktop-control__ui_click' && highImpactLabel.test(String(args.name || args.automationId || ''))) return 'clicking the desktop control "' + String(args.name || args.automationId) + '"';
  if (name === 'desktop-control__act' && Array.isArray(args.steps)) {
    const types = args.steps.some((step) => step && step.action === 'type');
    const enter = args.steps.some((step) => step && step.action === 'key' && /^(enter|return)$/i.test(String(step.keys || '')));
    if (types && enter) return 'submitting typed information with the keyboard';
  }
  if (name === 'delete_path') return 'deleting "' + String(args.path || 'the selected item') + '"';
  if (name === 'write_file' && !args.append && args.path) {
    let target = String(args.path).trim();
    target = target.replace(/^~(?=[\\/]|$)/, os.homedir());
    target = target.replace(/%([^%]+)%/g, (m, key) => {
      const envKey = Object.keys(process.env).find((k) => k.toLowerCase() === key.toLowerCase());
      return envKey ? process.env[envKey] : m;
    });
    const full = path.isAbsolute(target) ? path.resolve(target) : path.resolve(os.homedir(), target);
    if (fs.existsSync(full)) return 'overwriting the existing file "' + full + '"';
  }
  if (name === 'http_request' && !['GET', 'HEAD', 'OPTIONS'].includes(String(args.method || 'GET').toUpperCase())) {
    return 'sending a ' + String(args.method).toUpperCase() + ' request to ' + String(args.url || 'an external service');
  }
  if (name === 'browser__type' && args.submit) return 'submitting the current browser form';
  if (name === 'database__execute') {
    const sql = String(args.sql || args.query || args.statement || '');
    if (/\b(?:insert|update|delete|drop|alter|truncate|replace|merge|create|grant|revoke|call|exec|execute|do)\b/i.test(sql)) return 'changing database records or schema';
  }
  if (name === 'run_command' && /(?:remove-item|\brm\s+-rf\b|\bformat(?:\.com)?\b|\bdiskpart\b|\bdel\s+\/s\b|\bshutdown(?:\.exe)?\b|\brestart-computer\b|\bclear-content\b)/i.test(String(args.command || ''))) {
    return 'running a potentially destructive system command';
  }
  return '';
}

// Validate model-generated arguments at the execution boundary, regardless of provider.
// Provider schemas help the model; this check protects the actual tool dispatcher.
function validateToolArgs(value, schema, at = 'args') {
  if (!schema || typeof schema !== 'object') return null;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return at + ' must be an object';
    for (const key of schema.required || []) if (!Object.prototype.hasOwnProperty.call(value, key)) return at + '.' + key + ' is required';
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && schema.properties[key]) {
        const issue = validateToolArgs(item, schema.properties[key], at + '.' + key);
        if (issue) return issue;
      } else if (schema.additionalProperties === false) return at + '.' + key + ' is not allowed';
    }
  } else if (type === 'string' && typeof value !== 'string') return at + ' must be a string';
  else if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return at + ' must be a number';
  else if (type === 'integer' && !Number.isInteger(value)) return at + ' must be an integer';
  else if (type === 'boolean' && typeof value !== 'boolean') return at + ' must be a boolean';
  else if (type === 'array') {
    if (!Array.isArray(value)) return at + ' must be an array';
    if (schema.items) for (let i = 0; i < value.length; i++) {
      const issue = validateToolArgs(value[i], schema.items, at + '[' + i + ']');
      if (issue) return issue;
    }
  }
  if (schema.enum && !schema.enum.some((v) => v === value)) return at + ' must be one of the allowed values';
  if (typeof value === 'string' && schema.minLength != null && value.length < schema.minLength) return at + ' is too short';
  if (typeof value === 'string' && schema.maxLength != null && value.length > schema.maxLength) return at + ' is too long';
  if (typeof value === 'number' && schema.minimum != null && value < schema.minimum) return at + ' is below the minimum';
  if (typeof value === 'number' && schema.maximum != null && value > schema.maximum) return at + ' is above the maximum';
  return null;
}

async function execTool(settings, name, args, { onIntent, onTool, signal, trace, policy } = {}) {
  const def = toolDefs().find((tool) => tool.name === name);
  if (!def) return 'Tool call rejected: "' + String(name) + '" is not available.';
  const issue = validateToolArgs(args, def.schema);
  if (issue) return 'Tool call rejected because its arguments are invalid: ' + issue + '. Correct the arguments and try again.';
  const confirmation = confirmationReason(name, args);
  const signature = confirmation ? confirmationSignature(name, args) : '';
  if (confirmation && !(policy && policy.confirmedAction === signature)) {
    return 'Action paused: explicit confirmation is required before ' + confirmation + '. Call confirm_with_user with a clear question plus actionName="' + name + '" and actionArgs exactly matching this tool call, then retry only if the user says yes.';
  }
  if (confirmation && policy) policy.confirmedAction = null;
  if (onTool) onTool({ name, args });
  if (trace) traceCall(trace, name, args);
  if (name === 'express') { if (INTENTS.includes(args.intent) && onIntent) onIntent(args.intent); return 'ok'; }
  if (name === 'open_item') return actions.openItem(args.name, settings);
  if (name === 'get_time') return new Date().toString();
  if (name === 'confirm_with_user') {
    const r = await dialog.showMessageBox({ type: 'question', title: 'Saeed asks you', message: String(args.question || 'Continue?'), buttons: ['Yes, go ahead', 'No'], defaultId: 1, cancelId: 1, noLink: true });
    const result = r.response === 0 ? 'The user said yes.' : 'The user said no. Do not continue with this step.';
    if (policy) {
      policy.confirmedAction = result === 'The user said yes.' && typeof args.actionName === 'string'
        && args.actionArgs && typeof args.actionArgs === 'object' && !Array.isArray(args.actionArgs)
        ? confirmationSignature(args.actionName, args.actionArgs) : null;
    }
    return result;
  }
  if (name === 'recall_skills') { const r = skills.recall(args.query); return r.length ? JSON.stringify(r.map(({ id, name, app, steps, fields, verify, notes, uses, failures }) => ({ id, name, app, steps, fields, verify, notes, usedBefore: uses, failedBefore: failures }))) : 'No matching skill was learned yet.'; }
  if (name === 'learn_skill') return skills.learn(args);
  if (name === 'update_skill') return skills.update(args.id, args);
  if (name === 'forget_skill') return skills.forget(args.id);
  if (core.has(name)) return core.run(name, args, { settings });
  return addons.invokeTool(name, args, signal);
}


/* ---------- automatic skill capture ---------- */
// Which tool calls are worth remembering, and how to describe them in plain words (never the typed values,
// so the saved skill stays general instead of being tied to one person's data). This runs in code, not by
// asking the model to remember - so a skill is captured even if the model itself never calls learn_skill.
const SYSTEM_PREFIXES = ['desktop-control__', 'browser__', 'database__'];
const isSystemCall = (name) => SYSTEM_PREFIXES.some((p) => name.startsWith(p)) || name === 'run_command';
const ACTION_TOOLS = new Set(['desktop-control__ui_click', 'desktop-control__ui_set_text', 'desktop-control__ui_select', 'desktop-control__act', 'browser__click', 'browser__type', 'browser__select', 'browser__press', 'database__execute', 'run_command']);
const READ_TOOLS = new Set(['desktop-control__ui_read', 'desktop-control__ui_table', 'database__query', 'browser__extract']);
const where = (a) => a.window ? ` in "${a.window}"` : '';
const field = (a) => a.name || a.automationId || (a.id != null ? `[${a.id}]` : '');
function describeCall(name, a) {
  switch (name) {
    case 'desktop-control__ui_click': return `Click "${field(a)}"${where(a)}`;
    case 'desktop-control__ui_set_text': return `Fill in "${field(a)}"${where(a)}`;
    case 'desktop-control__ui_select': return `Choose an option in "${field(a)}"${where(a)}`;
    case 'desktop-control__act': return 'Click/type at a fixed screen position (prefer the UI Automation tools next time if the program supports them)';
    case 'desktop-control__ui_read': return `Read "${field(a)}"${where(a)} to check it`;
    case 'desktop-control__ui_table': return `Read the table "${field(a)}"${where(a)}`;
    case 'browser__open': return `Open the page ${a.url || ''}`.trim();
    case 'browser__click': return `Click ${field(a)} on the page`;
    case 'browser__type': return `Type into ${field(a)} on the page`;
    case 'browser__select': return `Choose an option in ${field(a)} on the page`;
    case 'browser__extract': return 'Read the page to check it';
    case 'database__query': return `Check the data (${(a.sql || '').split(/\s+/).slice(0, 2).join(' ')}…) on "${a.connection || ''}"`.trim();
    case 'database__execute': return `Run a ${(a.sql || '').trim().split(/\s+/)[0] || 'change'} on "${a.connection || ''}"`;
    case 'run_command': return 'Run a command';
    default: return name.includes('__') ? name.split('__')[1].replace(/_/g, ' ') : name;
  }
}
function traceCall(trace, name, args) { if (isSystemCall(name)) trace.push({ name, args: args || {} }); }
function guessApp(trace) {
  for (const c of trace) if (c.args.window) return c.args.window;
  for (const c of trace) if (c.args.url) { try { return new URL(c.args.url.includes('://') ? c.args.url : 'https://' + c.args.url).hostname; } catch { return c.args.url; } }
  for (const c of trace) if (c.args.connection) return c.args.connection;
  if (trace.some((c) => c.name === 'run_command')) return 'the command line';
  return '';
}
function keywordsFrom(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'in', 'on', 'with', 'this', 'that', 'my', 'please', 'من', 'في', 'على', 'الى', 'إلى', 'و', 'هذا', 'هذه']);
  return [...new Set(actions.norm(text).split(' ').filter((w) => w.length > 2 && !stop.has(w)))].slice(0, 8).join(', ');
}
// Called after a turn finishes. Saves what was done automatically, unless the model already saved or corrected a skill itself this turn.
function autoCapture(text, trace, calledLearn, reply) {
  if (calledLearn || trace.length < 2) return;
  if (/\b(?:could not|couldn't|unable to|failed|failure|denied|not completed)\b|لم أتمكن|لم أستطع|فشل|لم ينجح|رفض المستخدم/i.test(String(reply || ''))) return;
  const actionSteps = trace.filter((c) => ACTION_TOOLS.has(c.name) && c.ok === true);
  if (!actionSteps.length) return; // Failed actions are never taught as reusable skills.
  const lastActionIndex = Math.max(...actionSteps.map((c) => trace.indexOf(c)));
  const verifyStep = trace.slice(lastActionIndex + 1).reverse().find((c) => READ_TOOLS.has(c.name) && c.ok === true);
  if (!verifyStep) return; // Require a successful read-back after the last action.
  const steps = trace.filter((c) => (ACTION_TOOLS.has(c.name) && c.ok === true) || c === verifyStep)
    .map((c, i) => (i + 1) + '. ' + describeCall(c.name, c.args)).join('\n');
  skills.learn({
    name: String(text).trim().slice(0, 70) || 'Task', app: guessApp(trace), keywords: keywordsFrom(text),
    steps, verify: describeCall(verifyStep.name, verifyStep.args),
    notes: 'learned automatically after an action and a successful read-back',
  });
}

let hist = null, timer;
const file = () => path.join(app.getPath('userData'), 'history.json');
function load() {
  if (hist) return hist;
  try { hist = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { hist = []; }
  return hist;
}
function persistHistory() {
  const target = file(), tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(load().slice(-200)), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup is best effort */ }
    throw error;
  }
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try { persistHistory(); } catch (error) { console.error('[history] Could not save conversation:', error); }
  }, 500);
}
function flushHistory() {
  clearTimeout(timer);
  timer = null;
  persistHistory();
}

// Company procedures whose keywords appear in the request are added to the instructions.
function procedureText(settings, text) {
  const t = actions.norm(text);
  const hits = (settings.procedures || []).filter((p) => p.text && String(p.keywords || '').split(',').map((k) => actions.norm(k)).filter(Boolean).some((k) => t.includes(k)));
  return hits.length ? '\n\nProcedures of this company, follow them when they apply:\n' + hits.map((p) => `## ${p.name}\n${p.text}`).join('\n\n').slice(0, 6000) : '';
}

async function ask(text, { signal, onIntent, onTool, onText, settings, images = [] }) {
  const h = load();
  const mine = { role: 'user', text: images.length ? `${text} [image attached]` : text, t: Date.now() };
  h.push(mine); save();
  const recent = h.slice(-(settings.llm.maxTurns || 12) * 2).map((m) => ({ ...m }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (images.length && recent.length) { const last = recent[recent.length - 1]; last.text = text; last.images = images; }
  const customPrompt = String(settings.llm.systemPrompt || '').trim();
  // A custom prompt should add preferences, not silently remove Saeed's core tool-use and verification rules.
  const system = DEFAULT_PROMPT + (customPrompt ? `\n\nAdditional user instructions (apply when compatible with the core rules):\n${customPrompt}` : '') + procedureText(settings, text) + (settings.memory && settings.memory.enabled ? memory.promptText(text) : '') + skills.promptText(text) + `\nCurrent local date and time: ${new Date().toLocaleString()}.`;
  const trace = [], policy = { confirmedAction: null }; let calledLearn = false;
  try {
    const availableTools = toolDefs();
    const reply = await llm.runAgent(settings, {
      system, history: recent, tools: availableTools, signal, onText,
      execTool: async (name, args) => {
        if (!availableTools.some((tool) => tool.name === name)) return 'Tool call rejected: "' + String(name) + '" is not available in this turn.';
        if (name === 'learn_skill' || name === 'update_skill') calledLearn = true;
        const traceStart = trace.length;
        const resultText = (value) => typeof value === 'string' ? value : String((value && typeof value.text === 'string' && value.text) || (value && value.error) || '');
        const markResult = (value, ok) => {
          if (trace.length > traceStart) {
            const call = trace[trace.length - 1];
            call.result = resultText(value).slice(0, 800);
            call.ok = ok;
          }
        };
        try {
          const result = await execTool(settings, name, args, { onIntent, onTool, signal, trace, policy });
          const summary = resultText(result);
          const explicitFailure = result && typeof result === 'object'
            && (result.ok === false || result.success === false || Boolean(result.error));
          const failed = explicitFailure
            || /\b(?:error|denied|failed|failure|could not|couldn't|unknown tool|tool call rejected|destination already exists|no file with that name|not found|does not exist|permission denied|cannot|invalid|rejected)\b/i.test(summary)
            || /the user said no|\bHTTP [45]\d\d\b/i.test(summary)
            || /لم يتم العثور|لم أتمكن|تعذر|مرفوض|غير موجود|لا يوجد|لم ينجح|فشل|خطأ|رفض/i.test(summary);
          markResult(result, !failed);
          return result;
        } catch (error) {
          markResult(error && error.message ? error.message : String(error), false);
          throw error;
        }
      },
    });
    h.push({ role: 'assistant', text: reply, t: Date.now() }); save();
    autoCapture(text, trace, calledLearn, reply);
    return { text: reply };
  } catch (e) {
    if (h[h.length - 1] === mine) h.pop();
    throw e;
  }
}

// Commands answered locally (time, open Excel...) are still part of the same conversation.
function remember(userText, reply) {
  const h = load();
  h.push({ role: 'user', text: userText, t: Date.now() }, { role: 'assistant', text: reply, t: Date.now() });
  save();
}
const history = () => load().slice(-100);
function clear() { hist = []; save(); }

const defaultPrompt = () => DEFAULT_PROMPT;
module.exports = { ask, remember, history, clear, flushHistory, toolDefs, execTool, defaultPrompt, validateToolArgs, confirmationReason, confirmationSignature };
