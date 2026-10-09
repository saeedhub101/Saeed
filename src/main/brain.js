'use strict';
// The brain: one shared conversation history (voice + chat) and the tool-using LLM loop.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const llm = require('./llm');
const actions = require('./actions');
const addons = require('./addons');

const INTENTS = ['happy', 'sad', 'think', 'yes', 'no', 'greet', 'bow', 'sit', 'lie', 'sleep', 'stand'];
const DEFAULT_PROMPT = [
  'You are Saeed, a friendly desktop assistant shown as a 3D character on the user\'s PC, and a capable agent.',
  'Reply in the same language the user writes or speaks (Arabic or English).',
  'Your answer is read aloud: use short natural sentences, no markdown, no lists, no emoji. For long results (tables, reports) put them in a file with the tools and say where it is.',
  'Use the express tool to show an emotion or posture when it fits (do not overuse it).',
  'Use open_item to open apps, folders or files, and get_time for the time.',
  'Use the other tools (files, Excel, Word, PDF, OCR...) when they are available and the task needs them: read before you change anything, never invent data, and report what you did in one or two sentences.',
  'If you cannot do something, say so briefly and say which add-on would be needed.',
].join(' ');

const CORE_TOOLS = [
  { name: 'express', description: 'Show an emotion, gesture or posture on the 3D character.',
    schema: { type: 'object', properties: { intent: { type: 'string', enum: INTENTS } }, required: ['intent'] } },
  { name: 'open_item', description: 'Open an app, folder or file for the user: Excel, Word, PowerPoint, Notepad, Calculator, My Computer, Downloads, Documents, or an item from the user\'s quick launch list.',
    schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'get_time', description: 'Get the current local date and time.', schema: { type: 'object', properties: {} } },
];
const toolDefs = () => [...CORE_TOOLS, ...addons.toolDefs()];

async function execTool(settings, name, args, { onIntent, onTool, signal } = {}) {
  if (onTool) onTool({ name, args });
  if (name === 'express') { if (INTENTS.includes(args.intent) && onIntent) onIntent(args.intent); return 'ok'; }
  if (name === 'open_item') return actions.openItem(args.name, settings);
  if (name === 'get_time') return new Date().toString();
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

async function ask(text, { signal, onIntent, onTool, settings, images = [] }) {
  const h = load();
  const mine = { role: 'user', text: images.length ? `${text} [image attached]` : text, t: Date.now() };
  h.push(mine); save();
  const recent = h.slice(-(settings.llm.maxTurns || 12) * 2).map((m) => ({ ...m }));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  if (images.length && recent.length) { const last = recent[recent.length - 1]; last.text = text; last.images = images; }
  const system = (settings.llm.systemPrompt || DEFAULT_PROMPT) + `\nCurrent local date and time: ${new Date().toLocaleString()}.`;
  try {
    const reply = await llm.runAgent(settings, {
      system, history: recent, tools: toolDefs(), signal,
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
