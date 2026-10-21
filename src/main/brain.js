'use strict';
// The brain: one shared conversation history (voice + chat) and the tool-using LLM loop.
const fs = require('fs');
const path = require('path');
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
  'Reply in the same language the user writes or speaks (Arabic or English).',
  'Your answer is read aloud: use short natural sentences, no markdown, no lists, no emoji. For long results (tables, reports) put them in a file with the tools and say where it is.',
  'Use the express tool to show an emotion or posture when it fits (do not overuse it).',
  'You can act like a capable person at the computer: find files by name anywhere with find_files (never ask the user for a path you can find yourself), open them with open_path, read them, search the internet in the background with web_search and web_fetch, call web APIs with http_request, run commands with run_command, and remember lasting facts with remember.',
  'NEVER say you cannot access the user\'s files, the internet, their screen or a program as a general limitation - that is false, you have real tools for all of this. Always try the matching tool first (find_files, write_file, open_path, web_search, the UI/browser tools...). For a new file or folder the user did not give a full path for, put it under their own folders (Desktop, Documents, Downloads) rather than asking - find_files or system_info tells you where those are if you are unsure, you do not need to ask the user for their own home folder. If a tool call is refused, read the actual reason it gives (a permission, a missing item, a wrong name) and act on that specific reason - ask the user to change it in Permissions, or try the sensible alternative - instead of concluding you have no access at all.',
  'Use open_item for apps (Excel, Word, My Computer...), get_time for the time, and set_reminder when asked to remind.',
  'Use the other tools (files, Excel, Word, PDF, OCR...) when they are available and the task needs them: read before you change anything, never invent data, and report what you did in one or two sentences.',
  'To work inside another program: first EXPLORE it (ui_tree / explore_window; take a screenshot only if that gives nothing useful) rather than guessing coordinates. Prefer UI Automation tools (ui_tree, ui_read, ui_set_text, ui_click) over clicking by pixel position when a control has a name or automationId.',
  'ui_set_text reads the field back and tells you plainly if the text did not actually land - this happens on older programs and on web forms (ASP.NET/legacy pages, Internet Explorer-hosted pages) that do not expose themselves properly to UI Automation. When it says that, do not repeat the same call: take a screenshot (explore_window) to see the field, then use the act tool to click its exact position and type into it with real keystrokes - that works on almost anything because it is the same as a person using the mouse and keyboard, with no automation layer involved. The same applies if ui_click does not do what you expected.',
  'For anything that will take several tool calls in a program, website or database, call make_plan first with the concrete steps (the user sees this, so it also tells them what you are about to do), then check_step once you actually verify each one - never mark a step done just because you attempted it. Work in small steps and re-explore after each one. If the screen does not match what you expected (a dialog appeared, a field is missing, a save failed), stop acting blindly, explore again, and update the plan (a new make_plan call, or check_step with done:false to go back) instead of repeating the same clicks.',
  'Before filling a form, list the fields you were given and the fields the screen asks for; ask the user (ask_user or confirm_with_user) for anything required that is missing instead of guessing it.',
  'VERIFY before you say a task is done: re-read the screen or the record after saving and check it matches what was asked. Never report success you have not checked.',
  'Always call recall_skills with a short description of the task before doing any work in a program, a website or a database, even if you think you already know how — a matching skill, if one exists, is given to you with its exact steps and saves you from exploring from scratch, which is both faster and more reliable. When one matches well, follow it directly instead of re-exploring, but still verify the result.',
  'You do not need to remember to save a skill yourself: Saeed records the steps of any completed multi-step task in a program, website or database automatically in the background. Still call learn_skill yourself when you want to add something the automatic recording cannot know, such as what a field actually means, a rule to always follow, or a correction (use update_skill with outcome: \'failure\' when a saved skill turns out wrong or the screen changed, so it stops being suggested).',
  'Before an irreversible step in any system (submit, issue, send, pay, delete, overwrite) call confirm_with_user with a clear question.',
  'For logging in, signing up, or anything on a site that needs the user\'s own account: open the browser with visible:true so the user can see it and step in for a CAPTCHA or a code, and tell them briefly that you opened it. Big sites often load the login form a moment after the page itself, or hide it behind a button like "Log in" or "Sign up" that must be clicked first - if a field you expect is not in the last snapshot, click what opens the form, wait briefly, then take a fresh snapshot before concluding the field does not exist. Never report a field as missing from only the first snapshot.',
  'If you cannot do something, say so briefly and say which add-on would be needed.',
].join(' ');

const CORE_TOOLS = [
  { name: 'express', description: 'Show an emotion, gesture or posture on the 3D character.',
    schema: { type: 'object', properties: { intent: { type: 'string', enum: INTENTS } }, required: ['intent'] } },
  { name: 'open_item', description: 'Open an app, folder or file for the user: Excel, Word, PowerPoint, Notepad, Calculator, My Computer, Downloads, Documents, or an item from the user\'s quick launch list.',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_time', description: 'Get the current local date and time.', schema: { type: 'object', properties: {} } },
  { name: 'confirm_with_user', description: 'Ask the user a yes/no question in a window and wait for the answer. Use it before irreversible steps (submit, issue, send, pay, delete) and before anything the user did not fully specify.',
    schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'recall_skills', description: 'Look up skills you previously learned that might apply to the current task (by name, app or keywords).',
    schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'make_plan', description: 'Before doing multi-step work in a program, website or database, write down the concrete steps you are about to take (3-8 short steps, e.g. "Open the booking window", "Fill in the patient ID", "Verify the date saved correctly"). The user sees this plan, so it keeps you from skipping a step and lets them follow what you are doing. Call it once, before you start acting, for anything that will take several tool calls.',
    schema: { type: 'object', properties: { goal: { type: 'string', description: 'One short sentence: what this accomplishes' }, steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } },
  { name: 'check_step', description: 'Mark one step of your current plan as done, after you actually verify it worked - or as not done, to go back and redo it. Give a short note of what actually happened.',
    schema: { type: 'object', properties: { index: { type: 'number', description: '0-based position in the steps you gave to make_plan' }, done: { type: 'boolean' }, note: { type: 'string' } }, required: ['index'] } },
  { name: 'learn_skill', description: 'Save a skill after successfully completing a multi-step task in a program or system, so it is faster and more reliable next time. Give the exact sequence of steps that worked (tool calls and field names, not coordinates), and how to verify it succeeded. Give the same name and app again to update an existing skill.',
    schema: { type: 'object', properties: { name: { type: 'string' }, app: { type: 'string', description: 'The program or system this is for' }, keywords: { type: 'string', description: 'Comma-separated words a future request might use' },
      steps: { type: 'string', description: 'The steps that worked, as clear instructions' }, fields: { type: 'object', description: 'Field name -> how to find it (e.g. automationId or label)' },
      verify: { type: 'string', description: 'How to check it worked' }, notes: { type: 'string' } }, required: ['name', 'steps'] } },
  { name: 'update_skill', description: 'Correct a previously learned skill, or record that it failed this time.',
    schema: { type: 'object', properties: { id: { type: 'string' }, steps: { type: 'string' }, verify: { type: 'string' }, notes: { type: 'string' }, outcome: { type: 'string', enum: ['success', 'failure'] } }, required: ['id'] } },
  { name: 'forget_skill', description: 'Delete a learned skill that is no longer right.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
const toolDefs = () => [...CORE_TOOLS, ...core.defs(), ...addons.toolDefs()];

// A tool call counts as failed when its own text starts with "Error:" or "Denied:" (how every tool reports that).
const isToolOk = (result) => !/^(Error:|Denied:)/.test((typeof result === 'string' ? result : (result && result.text) || '').trim());
// Exploring/reading doesn't count toward the success/failure feeling of a task, only actually doing something does.
// Core tools are action by default except these; add-on tools use their own declared risk ('read' = not reported).
const NEUTRAL_CORE_TOOLS = new Set(['get_time', 'system_info', 'list_folder', 'read_file', 'file_info', 'find_files', 'view_image', 'web_search', 'web_fetch', 'recall_skills', 'list_reminders']);
function isActionTool(name) {
  if (name.includes('__')) { const def = addons.toolDefs().find((d) => d.name === name); return !def || def.risk !== 'read'; }
  return !NEUTRAL_CORE_TOOLS.has(name);
}

async function execTool(settings, name, args, { onIntent, onTool, onToolResult, onPlan, plan, signal, trace } = {}) {
  if (onTool) onTool({ name, args });
  if (trace) traceCall(trace, name, args);
  const report = (result) => { if (onToolResult && isActionTool(name)) onToolResult(name, isToolOk(result)); return result; };
  if (name === 'make_plan') {
    if (plan) { plan.goal = String(args.goal || ''); plan.steps = (Array.isArray(args.steps) ? args.steps : []).map((s) => ({ text: String(s), done: false, note: '' })); }
    if (onPlan && plan) onPlan({ goal: plan.goal, steps: plan.steps });
    return `Plan recorded with ${plan ? plan.steps.length : (args.steps || []).length} step(s).`;
  }
  if (name === 'check_step') {
    const i = Number(args.index);
    if (plan && plan.steps && plan.steps[i]) {
      plan.steps[i].done = args.done !== false; plan.steps[i].note = String(args.note || '');
      if (onPlan) onPlan({ goal: plan.goal, steps: plan.steps });
      return 'Updated.';
    }
    return 'No such step (call make_plan first).';
  }
  if (name === 'express') { if (INTENTS.includes(args.intent) && onIntent) onIntent(args.intent); return 'ok'; }
  if (name === 'open_item') return report(await actions.openItem(args.name, settings));
  if (name === 'get_time') return new Date().toString();
  if (name === 'confirm_with_user') {
    const r = await dialog.showMessageBox({ type: 'question', title: 'Saeed asks you', message: String(args.question || 'Continue?'), buttons: ['Yes, go ahead', 'No'], defaultId: 1, cancelId: 1, noLink: true });
    return r.response === 0 ? 'The user said yes.' : 'The user said no. Do not continue with this step.';
  }
  if (name === 'recall_skills') { const r = skills.recall(args.query); return r.length ? JSON.stringify(r.map(({ id, name, app, steps, fields, verify, notes, uses, failures }) => ({ id, name, app, steps, fields, verify, notes, usedBefore: uses, failedBefore: failures }))) : 'No matching skill was learned yet.'; }
  if (name === 'learn_skill') return skills.learn(args);
  if (name === 'update_skill') return skills.update(args.id, args);
  if (name === 'forget_skill') return skills.forget(args.id);
  if (core.has(name)) return report(await core.run(name, args, { settings }));
  return report(await addons.invokeTool(name, args, signal));
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
    case 'desktop-control__ui_select': return `Choose "${a.option || ''}" in "${field(a)}"${where(a)}`;
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
function autoCapture(text, trace, calledLearn) {
  if (calledLearn || trace.length < 2) return;
  const actionSteps = trace.filter((c) => ACTION_TOOLS.has(c.name));
  if (!actionSteps.length) return;                                     // exploring/reading only: nothing to repeat
  const verifyStep = [...trace].reverse().find((c) => READ_TOOLS.has(c.name));
  const steps = trace.filter((c) => ACTION_TOOLS.has(c.name) || c === verifyStep).map((c, i) => `${i + 1}. ${describeCall(c.name, c.args)}`).join('\n');
  skills.learn({
    name: String(text).trim().slice(0, 70) || 'Task', app: guessApp(trace), keywords: keywordsFrom(text),
    steps, verify: verifyStep ? describeCall(verifyStep.name, verifyStep.args) : 'Re-check the result in the program matches the request.',
    notes: 'learned automatically from a completed task',
  });
}

let hist = null, timer;
const file = () => path.join(app.getPath('userData'), 'history.json');
function load() {
  if (hist) return hist;
  try { hist = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { hist = []; }
  return hist;
}
function save() {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(file(), JSON.stringify(load().slice(-200)), () => {}), 500);
}

// Company procedures whose keywords appear in the request are added to the instructions.
function procedureText(settings, text) {
  const t = actions.norm(text);
  const hits = (settings.procedures || []).filter((p) => p.text && String(p.keywords || '').split(',').map((k) => actions.norm(k)).filter(Boolean).some((k) => t.includes(k)));
  return hits.length ? '\n\nProcedures of this company, follow them when they apply:\n' + hits.map((p) => `## ${p.name}\n${p.text}`).join('\n\n').slice(0, 6000) : '';
}

async function ask(text, { signal, onIntent, onTool, onToolResult, onPlan, onText, settings, images = [] }) {
  const h = load();
  const mine = { role: 'user', text: images.length ? `${text} [image attached]` : text, t: Date.now() };
  h.push(mine); save();
  const recent = h.slice(-(settings.llm.maxTurns || 12) * 2).map((m) => ({ ...m }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (images.length && recent.length) { const last = recent[recent.length - 1]; last.text = text; last.images = images; }
  const system = (settings.llm.systemPrompt || DEFAULT_PROMPT) + procedureText(settings, text) + (settings.memory && settings.memory.enabled ? memory.promptText() : '') + skills.promptText(text) + `\nCurrent local date and time: ${new Date().toLocaleString()}.`;
  const trace = []; let calledLearn = false;
  const plan = { goal: '', steps: [] };
  try {
    const reply = await llm.runAgent(settings, {
      system, history: recent, tools: toolDefs(), signal, onText,
      execTool: (name, args) => {
        if (name === 'learn_skill' || name === 'update_skill') calledLearn = true;
        return execTool(settings, name, args, { onIntent, onTool, onToolResult, onPlan, plan, signal, trace });
      },
    });
    h.push({ role: 'assistant', text: reply, t: Date.now() }); save();
    autoCapture(text, trace, calledLearn);
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
module.exports = { ask, remember, history, clear, toolDefs, execTool, defaultPrompt, traceCall, autoCapture };
