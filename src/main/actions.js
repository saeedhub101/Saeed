'use strict';
// Things Saeed can do on the PC, plus a small rule-based router for simple commands
// (so "what time is it" or "open Excel" work instantly, offline and without spending tokens).
const { shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const perms = require('./permissions');
const core = require('./tools-core');

// Returns a reason when opening is not allowed (Permissions → "Open apps, files and folders").
const mayOpen = (what) => perms.checkCap({ addon: 'core', addonName: 'Saeed', cap: 'apps.open', detail: `Open ${what}` });

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const isArabic = (s) => /[\u0600-\u06FF]/.test(s);

function launch(cmd, args = []) {
  if (process.platform !== 'win32') return Promise.resolve('Only available on Windows.');
  return new Promise((resolve) => {
    const p = spawn('cmd.exe', ['/c', 'start', '', cmd, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', (e) => resolve(String(e.message)));
    p.unref();
    setTimeout(() => resolve(''), 300);
  });
}
const folder = (p) => async () => (await shell.openPath(p)) || '';

const BUILTIN = [
  { id: 'Excel', names: ['excel', 'اكسل', 'اكسيل'], run: () => launch('excel') },
  { id: 'Word', names: ['word', 'وورد', 'ورد'], run: () => launch('winword') },
  { id: 'PowerPoint', names: ['powerpoint', 'power point', 'بوربوينت', 'باوربوينت'], run: () => launch('powerpnt') },
  { id: 'Notepad', names: ['notepad', 'المفكره', 'نوت باد'], run: () => launch('notepad') },
  { id: 'Calculator', names: ['calculator', 'calc', 'الحاسبه', 'اله حاسبه'], run: () => launch('calc') },
  { id: 'My Computer', names: ['my computer', 'this pc', 'computer', 'جهاز الكمبيوتر', 'جهازي', 'حاسوبي', 'هذا الكمبيوتر', 'الكمبيوتر'],
    run: () => launch('explorer.exe', ['shell:MyComputerFolder']) },
  { id: 'Downloads', names: ['downloads', 'التنزيلات', 'التحميلات'], run: folder(path.join(os.homedir(), 'Downloads')) },
  { id: 'Documents', names: ['documents', 'المستندات', 'مستنداتي'], run: folder(path.join(os.homedir(), 'Documents')) },
  { id: 'Desktop', names: ['desktop', 'سطح المكتب'], run: folder(path.join(os.homedir(), 'Desktop')) },
].map((b) => ({ ...b, names: b.names.map(norm) }));

function userItems(settings) {
  return (settings.launcher || []).filter((x) => x.path && x.names).map((x) => ({
    id: x.names.split(',')[0].trim(), names: x.names.split(',').map(norm).filter(Boolean),
    run: async () => (await shell.openPath(x.path)) || '',
  }));
}

// Opens a file by name (or full path) wherever it is: Desktop, Documents, Downloads first, then wider if asked.
async function openByName(name, settings) {
  const isPath = /^[A-Za-z]:[\\/]|^\\\\|^~?[\\/]/.test(name);
  if (isPath) { const msg = await core.run('open_path', { path: name }, { settings }); return { ok: /^Opened/.test(msg), msg, path: name }; }
  let list;
  try { list = await core.findFiles({ name: path.parse(name).name, ext: path.extname(name).slice(1) || undefined, limit: 12 }); } catch (e) { return { ok: false, msg: e.message }; }
  const files = list.filter((x) => x.type === 'file');
  const hit = files.find((x) => path.basename(x.path).toLowerCase() === name.toLowerCase()) || files[0] || list[0];
  if (!hit) return { ok: false, msg: `I could not find "${name}" on the Desktop, Documents or Downloads.` };
  const msg = await core.run('open_path', { path: hit.path }, { settings });
  return { ok: /^Opened/.test(msg), msg, path: hit.path };
}

/** Opens an app from the list, or any file / folder by name or path. */
async function openItem(query, settings) {
  const q = norm(query);
  if (!q) return 'No name was given.';
  const all = [...userItems(settings), ...BUILTIN];
  const hit = all.find((i) => i.names.includes(q)) || all.find((i) => i.names.some((n) => n && (q.includes(n) || n.includes(q))));
  if (!hit) { const r = await openByName(String(query).trim(), settings); return r.msg; }
  const why = await mayOpen(hit.id);
  if (why) return 'Denied: ' + why;
  const err = await hit.run();
  return err ? `Could not open ${hit.id}: ${err}` : `Opened ${hit.id}.`;
}

function timeText(ar) {
  const d = new Date();
  return ar
    ? `الساعة الآن ${d.toLocaleTimeString('ar-JO', { hour: 'numeric', minute: '2-digit' })}`
    : `It is ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.`;
}

const OPEN_RE = /^(?:(?:please|من فضلك|لو سمحت)\s+)?(?:open|launch|start|run|افتح|افتحي|شغل|شغلي)\s+(.+)$/;
const TIME_RE = /(كم الساعه|الساعه كم|كم الوقت|what time|time is it|current time|what is the time)/;
const POSTURES = [
  ['sleep', /^(?:go to sleep|sleep|نم|اذهب للنوم|ارقد)$/],
  ['lie', /^(?:lie down|lay down|استلق|استلقي|تمدد|اضطجع)$/],
  ['sit', /^(?:sit down|sit|اجلس|اقعد)$/],
  ['stand', /^(?:stand up|stand|wake up|قف|انهض|استيقظ|قم)$/],
];

/** Returns { reply, intent? } for simple commands, or null to let the brain answer. */
async function route(text, settings) {
  const ar = isArabic(text);
  const t = norm(text);
  // Basic social greetings must work without starting the paid/cloud brain.
  // Keep this exact-match only so normal conversation still goes to the selected LLM.
  const greetings = /^(?:hello|hi|hey|hiya|hello there|hey there|good morning|good afternoon|good evening|how are you|how are you doing|whats up|what's up|سلام|مرحبا|اهلا|اهلين|السلام عليكم|وعليكم السلام|صباح الخير|مساء الخير|كيف حالك|كيفك|شلونك)$/;
  if (greetings.test(t)) {
    if (ar) return { reply: /^(?:السلام عليكم|سلام)$/.test(t) ? 'وعليكم السلام! أنا جاهز لمساعدتك. ماذا تريد أن نفعل؟' : 'أهلاً! أنا جاهز لمساعدتك. ماذا تريد أن نفعل؟', intent: 'greet' };
    return { reply: 'Hello! I am here and ready to help. What would you like to do?', intent: 'greet' };
  }
  if (TIME_RE.test(t)) return { reply: timeText(ar) };
  if (t.length < 30) for (const [intent, re] of POSTURES) if (re.test(t)) return { reply: ar ? 'حاضر.' : 'Okay.', intent };
  const m = OPEN_RE.exec(t);
  if (m) {
    const all = [...userItems(settings), ...BUILTIN];
    const target = m[1].replace(/^(?:ملف|برنامج|تطبيق|the|file|app|program)\s+/, '');
    const hit = all.find((i) => i.names.includes(target)) || all.find((i) => i.names.some((n) => n && target.includes(n)));
    if (hit) {
      if (await mayOpen(hit.id)) return { reply: ar ? `ليس لدي إذن لفتح ${hit.id}.` : `I am not allowed to open ${hit.id}. You can change this in Permissions.` };
      const err = await hit.run();
      if (err) return { reply: ar ? `لم أستطع فتح ${hit.id}.` : `I could not open ${hit.id}.` };
      return { reply: ar ? `فتحت ${hit.id}.` : `Opening ${hit.id}.` };
    }
    const fm = /([^\s\\/:*?"<>|]+\.[A-Za-z0-9]{2,5})(?=\s|$)/.exec(text);   // "open test.xlsx"
    if (fm) {
      const r = await openByName(fm[1], settings);
      if (r.ok) return { reply: ar ? `فتحت ${path.basename(r.path)}.` : `Opened ${path.basename(r.path)}.` };
      return { reply: r.msg };
    }
  }
  return null;
}

module.exports = { route, openItem, timeText, isArabic, norm };
