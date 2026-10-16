import { h, debounce, toast } from './ui.js';
import { applyI18n } from './i18n.js';
import { Voice } from './voice.js';

const api = window.api;
let cfg = await api.getConfig();
let S = cfg.settings;
const save = debounce(() => api.setConfig({ settings: S }), 300);
const root = document.getElementById('root');

/* ---------- small binders ---------- */
const evName = (el) => (el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input');
function bind(obj, key, el, conv) {
  el.addEventListener(evName(el), () => { obj[key] = el.type === 'checkbox' ? el.checked : conv ? conv(el.value) : el.value; save(); });
  return el;
}
const T = (o, k, ph = '') => bind(o, k, h('input', { type: 'text', value: o[k] ?? '', placeholder: ph, class: 'grow' }));
const C = (o, k) => bind(o, k, h('input', { type: 'checkbox', checked: o[k] }));
const SEL = (o, k, opts, rerender, conv) => {
  const el = bind(o, k, h('select', { value: o[k] }, opts.map(([v, l]) => h('option', { value: v }, l))), conv);
  if (rerender) el.addEventListener('change', render);
  return el;
};
const row = (label, ...c) => h('div', { class: 'row' }, h('span', { class: 'lbl' }, label), ...c);
const section = (title, ...kids) => h('section', { class: 'box' }, h('h3', {}, title), ...kids);
const note = (t) => h('p', { class: 'muted' }, t);

function range(label, o, k, min, max, step, onChange) {
  const rng = h('input', { type: 'range', min, max, step, value: o[k], class: 'grow' });
  const num = h('input', { type: 'number', min, max, step, value: o[k] });
  const set = (v) => { o[k] = v; rng.value = v; num.value = v; save(); if (onChange) onChange(); };
  rng.addEventListener('input', () => set(+rng.value));
  num.addEventListener('change', () => set(+num.value));
  return h('label', { class: 'slider' }, h('span', { class: 'lbl' }, label), rng, num);
}

function keyField(name, label) {
  const inp = h('input', { type: 'password', class: 'grow', placeholder: 'paste the key here' });
  const st = h('span', { class: 'muted' }, '');
  const refresh = async () => { st.textContent = (await api.hasSecret(name)) ? 'saved ✓' : 'not set'; };
  refresh();
  return row(label, inp,
    h('button', { class: 'btn', onclick: async () => { if (!inp.value.trim()) return; await api.setSecret(name, inp.value.trim()); inp.value = ''; refresh(); toast('Key saved (encrypted on this PC).'); } }, 'Save key'),
    h('button', { class: 'btn danger', onclick: async () => { await api.setSecret(name, ''); refresh(); } }, 'Remove'), st);
}

/* ---------- sections ---------- */
let voices = [];
const loadVoices = () => { voices = speechSynthesis.getVoices(); };
loadVoices();
speechSynthesis.addEventListener('voiceschanged', () => { loadVoices(); if (!document.activeElement || document.activeElement === document.body) render(); });

let addonList = await api.addonsList();
api.onAddonsChanged(async () => { addonList = await api.addonsList(); if (!document.activeElement || document.activeElement === document.body) render(); });
const addonOpts = (kind, current) => {
  const o = addonList.filter((a) => a.enabled && a.provides && a.provides[kind]).map((a) => [`addon:${a.id}`, `${a.provides[kind].label || a.name} (add-on)`]);
  if (current.startsWith('addon:') && !o.some(([v]) => v === current)) o.push([current, `${current.slice(6)} (not installed)`]);
  return o;
};
const sttOptions = () => [['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['custom', 'OpenAI-compatible (Groq…)'], ...addonOpts('stt', S.stt.provider)];
const ttsOptions = () => [['system', 'Windows voice (offline)'], ['openai', 'OpenAI'], ['elevenlabs', 'ElevenLabs'], ['custom', 'OpenAI-compatible'], ...addonOpts('tts', S.tts.provider)];
const openAddons = () => h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => api.openWindow('addons') }, 'Open Add-ons'));

function sttSection() {
  const c = S.stt;
  const kids = [
    row('Provider', SEL(c, 'provider', sttOptions(), true)),
    row('Language', SEL(c, 'language', [['auto', 'Automatic'], ['ar', 'Arabic'], ['en', 'English']])),
  ];
  if (c.provider.startsWith('addon:')) {
    kids.push(note('Recognition runs inside an add-on (for example local Whisper, offline). Choose its model in the Add-ons window. The add-on starts when you speak and stops when idle.'), openAddons());
  } else if (c.provider === 'elevenlabs') {
    kids.push(row('Model', T(c.elevenlabs, 'model')), keyField('elevenlabs', 'ElevenLabs key'));
  } else {
    const p = c[c.provider];
    kids.push(row('Base URL', T(p, 'baseUrl')), row('Model', T(p, 'model')), keyField(c.provider, 'API key'));
  }
  return section('Speech to text (hearing you)', ...kids);
}

function llmSection() {
  const c = S.llm;
  const out = h('div', { class: 'out muted' });
  const kids = [row('Provider', SEL(c, 'provider', [['anthropic', 'Claude (Anthropic)'], ['openai', 'OpenAI'], ['custom', 'OpenAI-compatible (Ollama, Groq, OpenRouter…)'], ...addonOpts('llm', S.llm.provider)], true))];
  if (c.provider.startsWith('addon:')) {
    kids.push(note('This brain runs inside an add-on (for example a local Qwen or Llama model). Its options are in the Add-ons window. Small local models are fast and private but cannot use tools as well as Claude.'), openAddons());
  } else if (c.provider === 'anthropic') {
    const dl = h('datalist', { id: 'claude-models' }, ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-5'].map((m) => h('option', { value: m })));
    const model = T(c.anthropic, 'model'); model.setAttribute('list', 'claude-models');
    kids.push(row('Model', model, dl), keyField('anthropic', 'Anthropic key'), note('Haiku answers fastest, which feels best in voice conversation. Sonnet is smarter.'));
  } else {
    const p = c[c.provider];
    const model = T(p, 'model');
    if (c.provider === 'openai') {
      const dl = h('datalist', { id: 'openai-models' }, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.1', 'gpt-5', 'gpt-5-mini'].map((m) => h('option', { value: m })));
      model.setAttribute('list', 'openai-models');
      kids.push(
        row('Base URL', T(p, 'baseUrl')),
        row('Model', model, dl),
        row('Reasoning effort', SEL(c, 'reasoningEffort', [['low', 'Low — faster'], ['medium', 'Medium'], ['high', 'High — strongest reasoning']])),
        note('High reasoning is sent only to supported GPT-5 models. Model usage is billed by your provider.'),
        keyField(c.provider, 'API key'));
    } else {
      kids.push(row('Base URL', T(p, 'baseUrl')), row('Model', model), keyField(c.provider, 'API key'));
    }
  }
  kids.push(
    row('Remembered turns', bind(c, 'maxTurns', h('input', { type: 'number', min: 2, max: 40, value: c.maxTurns }), Number)),
    h('div', {}, h('div', { class: 'muted' }, 'Personality / instructions (leave empty for the default)'),
      bind(c, 'systemPrompt', h('textarea', { rows: 5, value: c.systemPrompt, dir: 'auto' }))),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => {
      out.textContent = 'asking…';
      const r = await api.testLlm();
      out.textContent = r.ok ? '✓ ' + r.text : '✗ ' + r.error;
    } }, 'Test the brain')), out);
  return section('Brain (language model)', ...kids);
}

function ttsSection() {
  const c = S.tts;
  const text = h('input', { type: 'text', class: 'grow', value: 'مرحبا، أنا سعيد. Hello, I am Saeed.' });
  const out = h('div', { class: 'out muted' });
  const kids = [row('Provider', SEL(c, 'provider', ttsOptions(), true))];
  if (c.provider === 'system') {
    const opts = [['', 'Automatic by language'], ...voices.map((v) => [v.name, `${v.name} (${v.lang})`])];
    kids.push(row('Voice', SEL(c.system, 'voice', opts)), range('Speed', c.system, 'rate', 0.5, 2, 0.05), range('Pitch', c.system, 'pitch', 0.5, 2, 0.05),
      note('Arabic voices must be installed in Windows (Settings → Time & language → Speech).'));
  } else if (c.provider === 'elevenlabs') {
    kids.push(row('Voice id', T(c.elevenlabs, 'voiceId', 'copy it from your ElevenLabs voices')), row('Model', T(c.elevenlabs, 'model')), keyField('elevenlabs', 'ElevenLabs key'));
  } else if (c.provider.startsWith('addon:')) {
    kids.push(note('This voice comes from an add-on. Its options are in the Add-ons window.'), openAddons());
  } else {
    const p = c[c.provider];
    kids.push(row('Base URL', T(p, 'baseUrl')), row('Model', T(p, 'model')), row('Voice', T(p, 'voice')), keyField(c.provider, 'API key'));
  }
  kids.push(row('Test sentence', text), h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => {
    out.textContent = '';
    if (c.provider === 'system') {
      const u = new SpeechSynthesisUtterance(text.value);
      const v = voices.find((x) => x.name === c.system.voice);
      if (v) u.voice = v; else u.lang = /[\u0600-\u06FF]/.test(text.value) ? 'ar-SA' : 'en-US';
      u.rate = c.system.rate; u.pitch = c.system.pitch; u.volume = S.audio.volume;
      speechSynthesis.cancel(); speechSynthesis.speak(u); return;
    }
    out.textContent = 'generating…';
    const r = await api.testTts(text.value);
    if (!r.ok) { out.textContent = '✗ ' + r.error; return; }
    out.textContent = '';
    const a = new Audio(URL.createObjectURL(new Blob([r.bytes], { type: r.mime })));
    a.volume = S.audio.volume; a.play();
  } }, 'Play test sentence')), out);
  return section('Voice (speaking)', ...kids);
}

let testVoice = null;
function audioSection() {
  const a = S.audio;
  const fill = h('div', { class: 'fill' });
  const mMic = h('div', { class: 'mark' }), mStop = h('div', { class: 'mark stop' });
  const heard = h('div', { class: 'out muted' });
  const MAXV = 0.4;
  const place = () => { mMic.style.left = Math.min(100, (a.micRms / MAXV) * 100) + '%'; mStop.style.left = Math.min(100, (a.interruptRms / MAXV) * 100) + '%'; };
  place();
  const toggle = h('button', { class: 'btn' }, testVoice && testVoice.on ? 'Stop microphone test' : 'Start microphone test');
  toggle.onclick = async () => {
    if (testVoice && testVoice.on) { testVoice.stop(); testVoice = null; toggle.textContent = 'Start microphone test'; fill.style.width = '0'; return; }
    testVoice = new Voice(() => S, {
      onLevel: (rms) => { fill.style.width = Math.min(100, (rms / MAXV) * 100) + '%'; },
      onUtterance: async (f32) => { heard.textContent = 'transcribing…'; const r = await api.testStt(f32); heard.textContent = r.ok ? 'You said: ' + r.text : '✗ ' + r.error; },
    });
    try { await testVoice.start(); toggle.textContent = 'Stop microphone test'; } catch (e) { heard.textContent = '✗ ' + e.message; testVoice = null; }
  };
  return section('Sound levels',
    range('Output volume', a, 'volume', 0, 1, 0.05),
    range('Listen when my voice is above (RMS)', a, 'micRms', 0.005, 0.4, 0.005, place),
    range('Stop talking when my voice is above (RMS)', a, 'interruptRms', 0.01, 0.8, 0.01, place),
    range('How long I must be loud to interrupt (ms)', a, 'interruptMs', 50, 600, 10),
    range('Silence that ends my sentence (ms)', a, 'silenceMs', 300, 2500, 50),
    range('Ignore sounds shorter than (ms)', a, 'minSpeechMs', 100, 1500, 50),
    range('Microphone gain', a, 'micGain', 0.5, 4, 0.1),
    h('div', { class: 'muted' }, 'Test: the blue bar is your voice. Orange line = starts listening, red line = interrupts Saeed. Speak normally and place the lines.'),
    h('div', { class: 'meter' }, fill, mMic, mStop),
    h('div', { class: 'btns' }, toggle), heard,
    row('Mute (words appear in the bubble)', C(a, 'muted')),
    row('Always show the bubble', C(a, 'bubbleAlways')),
    note('With speakers, use a high interrupt level or headphones: Saeed\'s own voice can reach the microphone.'));
}

const times = h('div', { class: 'times' });
const showTimes = (t) => times.replaceChildren(...(t ? Object.entries(t).map(([n, v]) => h('div', {}, `${n} ${v}`)) : [h('span', { class: 'muted' }, 'No times yet.')]));
api.prayerToday().then(showTimes);
function prayerSection() {
  const p = S.prayer;
  const info = h('div', { class: 'out muted' });
  return section('Prayer times and adhan',
    row('Enable', C(p, 'enabled')),
    row('City', T(p, 'city')), row('Country', T(p, 'country')),
    row('Calculation method', SEL(p, 'method', [[23, 'Jordan — Ministry of Awqaf'], [4, 'Umm al-Qura (Makkah)'], [3, 'Muslim World League'], [5, 'Egyptian General Authority'], [2, 'ISNA'], [8, 'Gulf region'], [9, 'Kuwait'], [10, 'Qatar'], [13, 'Turkey (Diyanet)'], [1, 'Karachi']], false, Number)),
    row('Adhan audio file', T(p, 'adhanFile', 'choose an mp3 / wav file'), h('button', { class: 'btn', onclick: async () => { const f = await api.pickFile(['mp3', 'wav', 'ogg', 'm4a', 'aac']); if (f) { p.adhanFile = f; save(); render(); } } }, 'Browse…')),
    range('Adhan volume', p, 'adhanVolume', 0, 1, 0.05),
    row('Muezzin pose (hands by the face)', C(p, 'pose')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => { info.textContent = 'asking the server…'; const r = await api.prayerRefresh(); info.textContent = r.ok ? 'Updated.' : '✗ ' + r.error; if (r.ok) showTimes(r.times); } }, 'Get this month\'s times'),
      h('button', { class: 'btn', onclick: () => api.prayerTest() }, 'Test adhan now')),
    h('div', { class: 'muted' }, 'Today'), times, info,
    note('Times are requested once a month (Aladhan service) and saved on this PC. Compare them with your local mosque. Without an audio file Saeed announces the prayer by voice. The adhan plays only while the character is shown.'));
}

function launcherSection() {
  const list = S.launcher;
  return section('Quick launch (files and folders Saeed may open)',
    note('Say "open payroll" and Saeed opens the item whose names include it. Separate names with commas. Only items in this list and the built-in apps can be opened.'),
    ...list.map((it, i) => h('div', { class: 'row' },
      bind(it, 'names', h('input', { type: 'text', value: it.names, placeholder: 'payroll, الرواتب', style: 'width:200px' })),
      T(it, 'path', 'C:\\Users\\…\\file.xlsx'),
      h('button', { class: 'btn', onclick: async () => { const f = await api.pickFile(); if (f) { it.path = f; save(); render(); } } }, 'Browse…'),
      h('button', { class: 'x', onclick: () => { list.splice(i, 1); save(); render(); } }, '×'))),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { list.push({ names: '', path: '' }); render(); } }, 'Add item')),
    row('Answer simple commands without the brain', C(S.commands, 'local')),
    note('Time, open Excel / Word / My Computer, sit / sleep / stand are handled on this PC instantly, without the internet.'));
}

/* ---------- live conversation, agent, updates, performance ---------- */
function realtimeSection() {
  const r = S.realtime;
  const kids = [row('Provider', SEL(r, 'provider', [['off', 'Off (step-by-step: speech → brain → voice)'], ['openai', 'OpenAI Realtime'], ['custom', 'Custom (any compatible server)']], true))];
  if (r.provider === 'openai') {
    const p = r.openai;
    const dl = h('datalist', { id: 'rt-voices' }, ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'].map((v) => h('option', { value: v })));
    const voice = T(p, 'voice'); voice.setAttribute('list', 'rt-voices');
    kids.push(row('Model', T(p, 'model')), row('Voice', voice, dl),
      row('Protocol', SEL(p, 'protocol', [['ga', 'Current (GA)'], ['beta', 'Older (beta)']])),
      row('Transcribe my speech with', T(p, 'transcribeModel', 'gpt-4o-mini-transcribe')),
      keyField('openai', 'OpenAI key'));
  } else if (r.provider === 'custom') {
    const p = r.custom;
    kids.push(row('Address (wss://…)', T(p, 'url', 'wss://example.com/v1/realtime')), row('Model', T(p, 'model')), row('Voice', T(p, 'voice')),
      row('Protocol', SEL(p, 'protocol', [['ga', 'Current OpenAI style'], ['beta', 'Older OpenAI style']])),
      row('Transcribe my speech with', T(p, 'transcribeModel')),
      row('Audio sample rate', bind(p, 'sampleRate', h('input', { type: 'number', step: 1000, value: p.sampleRate }), Number)),
      row('Key header name', T(p, 'authHeader')), row('Key prefix', T(p, 'authPrefix')),
      h('div', {}, h('div', { class: 'muted' }, 'Extra headers (JSON, optional)'), bind(p, 'headers', h('textarea', { rows: 2, value: p.headers, placeholder: '{"X-Org": "123"}' }))),
      keyField('realtime-custom', 'Provider key'));
  }
  if (r.provider !== 'off') {
    kids.push(h('div', {}, h('div', { class: 'muted' }, 'Instructions for the live voice (leave empty to use the Brain personality)'), bind(r, 'instructions', h('textarea', { rows: 3, value: r.instructions, dir: 'auto' }))),
      note('With a provider selected, the microphone button starts a live conversation: the server hears you and answers with its own voice, with very little delay. Your "stop talking" level still lets you interrupt. Typing in the chat keeps using the Brain. The connection closes when you turn the microphone off or hide Saeed.'));
  }
  return section('Live conversation (realtime)', ...kids);
}

function agentSection() {
  const g = S.agent;
  return section('Agent, permissions and add-ons',
    note('What Saeed may read, change, delete or open, and where, is controlled in the Permissions window. Each kind of action can be Ask, Allow or Deny, and every folder can have its own rule, including Windows system folders.'),
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => api.openWindow('permissions') }, 'Open Permissions'), h('button', { class: 'btn', onclick: () => api.openWindow('addons') }, 'Open Add-ons')),
    row('Stop an idle add-on after (seconds)', bind(g, 'addonIdleSeconds', h('input', { type: 'number', min: 10, max: 3600, value: g.addonIdleSeconds }), Number)),
    row('Steps allowed per request', bind(g, 'maxSteps', h('input', { type: 'number', min: 3, max: 100, value: g.maxSteps }), Number)),
    note('Working inside another program takes many small steps (look, click, check). Raise this for long tasks. Add-ons are programs: install only add-ons you trust.'));
}

function proceduresSection() {
  const list = S.procedures;
  return section('Procedures (how to work in your company systems)',
    note('Describe a task once: which program, which screens, which fields, in what order, and what to check. When a request contains one of the keywords, Saeed receives this text and follows it. Example: keywords "insurance, policy, بوليصة"; text "Open InsureSys, menu Policies → New, fill Name, Date, Plan, check the premium, then ask me before pressing Issue."'),
    ...list.map((p, i) => h('div', { class: 'box' },
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Name'), T(p, 'name'), h('button', { class: 'x', title: 'Remove', onclick: () => { list.splice(i, 1); save(); render(); } }, '×')),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Keywords'), T(p, 'keywords', 'separated by commas')),
      bind(p, 'text', h('textarea', { rows: 6, value: p.text, dir: 'auto', placeholder: 'Steps…' })))),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { list.push({ name: '', keywords: '', text: '' }); render(); } }, 'Add a procedure')));
}

let uiLangs = await api.uiLanguages();
function languageSection() {
  return section('Language',
    row('Interface language', SEL(S.ui, 'language', uiLangs.map((l) => [l.code, l.name]), true)),
    note(uiLangs.length > 1 ? 'More languages appear here when you install a language add-on (Add-ons → Store → category Language). Some windows reload to apply the change.' : 'Install a language add-on (Add-ons → Store → category Language) to add more interface languages.'));
}

let userSecretNames = await api.secretNames('user:');
function webSection() {
  const w = S.web;
  const nameIn = h('input', { type: 'text', placeholder: 'NAME (letters, digits, _)', style: 'width:170px' });
  const valIn = h('input', { type: 'password', class: 'grow', placeholder: 'secret value' });
  return section('Web, search and saved secrets',
    note('Saeed can search the internet and read pages in the background, without opening a browser. Search works with no key (DuckDuckGo); Brave or Tavily give more reliable results.'),
    row('Search with', SEL(w, 'search', [['duckduckgo', 'DuckDuckGo (no key)'], ['brave', 'Brave Search (key)'], ['tavily', 'Tavily (key, with a short answer)']], true)),
    w.search === 'brave' ? keyField('brave', 'Brave key') : null, w.search === 'tavily' ? keyField('tavily', 'Tavily key') : null,
    row('Results per search', bind(w, 'maxResults', h('input', { type: 'number', min: 1, max: 10, value: w.maxResults }), Number)),
    h('h3', {}, 'Saved secrets for web services and add-ons'),
    note('Tokens, passwords and API keys that Saeed may use without seeing them. In a request he writes {{secret:NAME}} and the value is filled in privately. They are encrypted on this PC.'),
    ...userSecretNames.map((n) => h('div', { class: 'row' }, h('span', { class: 'lbl' }, n.replace(/^user:/, '')), h('span', { class: 'muted grow' }, '••••••••'),
      h('button', { class: 'x', title: 'Remove', onclick: async () => { await api.setSecret(n, ''); userSecretNames = await api.secretNames('user:'); render(); } }, '×'))),
    h('div', { class: 'row' }, nameIn, valIn, h('button', { class: 'btn', onclick: async () => {
      const n = nameIn.value.trim().replace(/[^A-Za-z0-9_]/g, '');
      if (!n || !valIn.value) return toast('Give a name and a value.');
      await api.setSecret('user:' + n, valIn.value); userSecretNames = await api.secretNames('user:'); render();
    } }, 'Save')));
}

let skillList = await api.skillsList();
function skillsSection() {
  const fmt = (t) => new Date(t).toLocaleDateString();
  return section('Skills Saeed learned',
    note('When Saeed completes a multi-step task in a program or system, he can save how he did it (learn_skill) and reuse it next time, instead of starting from scratch. This is separate from what he remembers about you and from the Procedures you write.'),
    skillList.length ? skillList.map((s, i) => h('div', { class: 'box' },
      h('div', { class: 'row' }, h('strong', { class: 'grow' }, s.name + (s.app ? ' — ' + s.app : '')),
        h('span', { class: 'muted' }, `used ${s.uses || 0}×${s.failures ? ', failed ' + s.failures + '×' : ''} · ${fmt(s.updatedAt)}`),
        h('button', { class: 'x', title: 'Forget', onclick: async () => { await api.skillsRemove(i); skillList = await api.skillsList(); render(); } }, '×')),
      h('div', { class: 'muted' }, s.keywords),
      h('div', { dir: 'auto', style: 'white-space:pre-wrap' }, s.steps),
      s.verify ? h('div', { class: 'muted' }, 'Verify: ' + s.verify) : null))
      : h('p', { class: 'muted' }, 'Nothing learned yet. It builds up as Saeed completes tasks in your programs.'));
}

let facts = await api.memoryList();
function memorySection() {
  const inp = h('input', { type: 'text', class: 'grow', placeholder: 'Something Saeed should always know…', dir: 'auto' });
  return section('What Saeed remembers',
    row('Use long-term memory', C(S.memory, 'enabled')),
    note('Saeed also remembers things by himself when you tell him a lasting preference or fact. You can add or remove them here.'),
    ...facts.map((f, i) => h('div', { class: 'row' }, h('span', { class: 'grow', dir: 'auto' }, f), h('button', { class: 'x', onclick: async () => { await api.memoryRemove(i); facts = await api.memoryList(); render(); } }, '×'))),
    h('div', { class: 'row' }, inp, h('button', { class: 'btn', onclick: async () => { if (inp.value.trim()) { await api.memoryAdd(inp.value); facts = await api.memoryList(); render(); } } }, 'Add')));
}

function updatesSection() {
  const u = S.updates;
  return section('Updates',
    row('GitHub repository', T(u, 'repo', 'owner/name')),
    row('Check automatically once a day', C(u, 'autoCheck')),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: () => { api.openWindow('update'); api.updateAction('check'); } }, 'Check for updates now')),
    note('The same repository is used for the add-on list. Updates come from its releases.'));
}

let metricsTimer = 0;
function performanceSection() {
  const out = h('div', { class: 'out' });
  const paint = async () => {
    const m = await api.metrics();
    const total = m.processes.reduce((a, p) => a + p.memMB, 0);
    out.textContent = m.processes.map((p) => `${p.type.padEnd(10)} ${String(p.memMB).padStart(5)} MB   ${String(p.cpu).padStart(4)} % CPU`).join('\n')
      + `\n${'total'.padEnd(10)} ${String(total).padStart(5)} MB\nwindows open: ${m.windows.join(' · ')}\nadd-ons running: ${m.addons.length ? m.addons.join(', ') : 'none'}`;
  };
  paint();
  metricsTimer = setInterval(() => { if (!document.hidden) paint(); }, 2000);
  return section('Performance',
    range('Frame rate while Saeed is idle', S.performance, 'idleFps', 5, 30, 1),
    note('Saeed draws at full speed while something happens and slows down while he only stands there. Add-ons and models start when needed and stop when idle; nothing runs while he is hidden.'),
    h('div', { class: 'muted' }, 'What is running now'), out);
}

/* ---------- page ---------- */
function render() {
  const y = window.scrollY;
  clearInterval(metricsTimer);
  root.replaceChildren(languageSection(), audioSection(), sttSection(), llmSection(), ttsSection(), realtimeSection(), prayerSection(), launcherSection(), agentSection(), webSection(), memorySection(), skillsSection(), proceduresSection(), updatesSection(), performanceSection());
  window.scrollTo(0, y);
}
render();

api.onConfig((c) => {
  cfg = c; S = c.settings;
  if (!document.activeElement || document.activeElement === document.body) render();
});
applyI18n();
