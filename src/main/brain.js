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
  'Use open_item for apps (Excel, Word, My Computer...), get_time for the time, and set_reminder when asked to remind.',
  'Use the other tools (files, Excel, Word, PDF, OCR...) when they are available and the task needs them: read before you change anything, never invent data, and report what you did in one or two sentences.',
  'To work inside another program: first EXPLORE it (ui_tree / explore_window; take a screenshot only if that gives nothing useful) rather than guessing coordinates. Prefer UI Automation tools (ui_tree, ui_read, ui_set_text, ui_click) over clicking by pixel position when a control has a name or automationId.',
  'Work in small steps and re-explore after each one. If the screen does not match what you expected (a dialog appeared, a field is missing, a save failed), stop acting blindly, explore again, and adjust the plan instead of repeating the same clicks.',
  'Before filling a form, list the fields you were given and the fields the screen asks for; ask the user (ask_user or confirm_with_user) for anything required that is missing instead of guessing it.',
  'VERIFY before you say a task is done: re-read the screen or the record after saving and check it matches what was asked. Never report success you have not checked.',
  'recall_skills(what you are about to do) before starting a multi-step task in a program or a system, in case you already learned how. After a task that used several UI or system steps succeeds, call learn_skill with the steps that worked and how to verify success, so it is faster and more reliable next time. If a saved skill turns out to be wrong or the screen changed, call update_skill with the correction (outcome: \'failure\' when it did not work) so it is not reused blindly.',
  'Before an irreversible step in any system (submit, issue, send, pay, delete, overwrite) call confirm_with_user with a clear question.',
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
  { name: 'learn_skill', description: 'Save a skill after successfully completing a multi-step task in a program or system, so it is faster and more reliable next time. Give the exact sequence of steps that worked (tool calls and field names, not coordinates), and how to verify it succeeded. Give the same name and app again to update an existing skill.',
    schema: { type: 'object', properties: { name: { type: 'string' }, app: { type: 'string', description: 'The program or system this is for' }, keywords: { type: 'string', description: 'Comma-separated words a future request might use' },
      steps: { type: 'string', description: 'The steps that worked, as clear instructions' }, fields: { type: 'object', description: 'Field name -> how to find it (e.g. automationId or label)' },
      verify: { type: 'string', description: 'How to check it worked' }, notes: { type: 'string' } }, required: ['name', 'steps'] } },
  { name: 'update_skill', description: 'Correct a previously learned skill, or record that it failed this time.',
    schema: { type: 'object', properties: { id: { type: 'string' }, steps: { type: 'string' }, verify: { type: 'string' }, notes: { type: 'string' }, outcome: { type: 'string', enum: ['success', 'failure'] } }, required: ['id'] } },
  { name: 'forget_skill', description: 'Delete a learned skill that is no longer right.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
const toolDefs = () => [...CORE_TOOLS, ...core.defs(), ...addons.toolDefs()];

async function execTool(settings, name, args, { onIntent, onTool, signal } = {}) {
  if (onTool) onTool({ name, args });
  if (name === 'express') { if (INTENTS.includes(args.intent) && onIntent) onIntent(args.intent); return 'ok'; }
  if (name === 'open_item') return actions.openItem(args.name, settings);
  if (name === 'get_time') return new Date().toString();
  if (name === 'confirm_with_user') {
    const r = await dialog.showMessageBox({ type: 'question', title: 'Saeed asks you', message: String(args.question || 'Continue?'), buttons: ['Yes, go ahead', 'No'], defaultId: 1, cancelId: 1, noLink: true });
    return r.response === 0 ? 'The user said yes.' : 'The user said no. Do not continue with this step.';
  }
  if (name === 'recall_skills') { const r = skills.recall(args.query); return r.length ? JSON.stringify(r.map(({ id, name, app, steps, fields, verify, notes, uses, failures }) => ({ id, name, app, steps, fields, verify, notes, usedBefore: uses, failedBefore: failures }))) : 'No matching skill was learned yet.'; }
  if (name === 'learn_skill') return skills.learn(args);
  if (name === 'update_skill') return skills.update(args.id, args);
  if (name === 'forget_skill') return skills.forget(args.id);
  if (core.has(name)) return core.run(name, args, { settings });
  return addons.invokeTool(name, args, signal);
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

async function ask(text, { signal, onIntent, onTool, onText, settings, images = [] }) {
  const h = load();
  const mine = { role: 'user', text: images.length ? `${text} [image attached]` : text, t: Date.now() };
  h.push(mine); save();
  const recent = h.slice(-(settings.llm.maxTurns || 12) * 2).map((m) => ({ ...m }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (images.length && recent.length) { const last = recent[recent.length - 1]; last.text = text; last.images = images; }
  const system = (settings.llm.systemPrompt || DEFAULT_PROMPT) + procedureText(settings, text) + (settings.memory && settings.memory.enabled ? memory.promptText() : '') + skills.promptText(text) + `\nCurrent local date and time: ${new Date().toLocaleString()}.`;
  try {
    const reply = await llm.runAgent(settings, {
      system, history: recent, tools: toolDefs(), signal, onText,
      execTool: (name, args) => execTool(settings, name, args, { onIntent, onTool, signal }),
    });
    h.push({ role: 'assistant', text: reply, t: Date.now() }); save();
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
module.exports = { ask, remember, history, clear, toolDefs, execTool, defaultPrompt };
