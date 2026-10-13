import { h, toast, debounce } from './ui.js';
import { applyI18n } from './i18n.js';

const api = window.api;
let cfg = await api.getConfig();
const info = await api.permInfo();
let P = cfg.settings.permissions;
const root = document.getElementById('root');
const save = debounce(() => api.permSet(P), 250);

const MODES = [['ask', 'Ask', 'ask'], ['allow', 'Allow', 'allow'], ['deny', 'Deny', 'deny']];
function seg(options, value, onPick) {
  return h('div', { class: 'seg' }, options.map(([v, label, cls]) => h('button', { class: (v === value ? 'on ' : '') + cls, onclick: () => onPick(v) }, label)));
}
const section = (title, ...kids) => h('section', { class: 'box' }, h('h3', {}, title), ...kids);
const note = (t) => h('p', { class: 'muted' }, t);
const set = (fn) => { fn(); save(); render(); };
let newMode = 'allow';
const shortCap = (cap) => (info.caps[cap] ? info.caps[cap].label : cap);

function capsSection() {
  return section('What Saeed may do',
    note('Ask: a window asks you each time (you can pick "Always allow"). Allow: he does it without asking. Deny: he cannot.'),
    ...Object.entries(info.caps).map(([id, c]) => h('div', { class: 'cap' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 't' }, c.label), h('div', { class: 'muted' }, c.desc)),
      seg(MODES, P.caps[id] || 'ask', (v) => set(() => { P.caps[id] = v; })))));
}

function placesSection() {
  const pathIn = h('input', { type: 'text', class: 'grow', placeholder: 'C:\\Windows\\System32   or   D:\\  or  %APPDATA%' });
  const add = (p) => { if (p && !P.locations.some((r) => r.path.toLowerCase() === p.toLowerCase())) P.locations.push({ path: p, mode: newMode }); };
  return section('Where',
    note('Each folder can have its own rule; the most specific folder wins (allow D:\\Work, deny D:\\Work\\Private). The action permission above and the folder rule both count: if either says Deny it is denied, if either says Ask you are asked. To let Saeed work in Windows system folders, set their rule to Ask or Allow here.'),
    h('div', { class: 'cap' }, h('div', { style: 'flex:1' }, h('div', { class: 't' }, 'Places that are not in the list'), h('div', { class: 'muted' }, 'Any other folder or drive.')),
      seg(MODES, P.defaultLocation, (v) => set(() => { P.defaultLocation = v; }))),
    ...P.locations.map((r, i) => h('div', { class: 'row' },
      h('input', { type: 'text', class: 'grow', value: r.path, onchange: (e) => { r.path = e.target.value.trim(); save(); } }),
      seg(MODES, r.mode, (v) => set(() => { r.mode = v; })),
      h('button', { class: 'x', title: 'Remove rule', onclick: () => set(() => { P.locations.splice(i, 1); }) }, '×'))),
    h('h3', {}, 'Add a place'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'New rules are'), seg(MODES, newMode, (v) => { newMode = v; render(); })),
    h('div', { class: 'row' }, pathIn, h('button', { class: 'btn', onclick: () => set(() => add(pathIn.value.trim())) }, 'Add')),
    h('div', { class: 'btns' },
      h('button', { class: 'btn', onclick: async () => { const f = await api.pickFile('dir'); if (f) set(() => add(f)); } }, 'Choose a folder…'),
      h('button', { class: 'btn', onclick: () => set(() => { for (const p of ['%SystemRoot%', '%ProgramFiles%', '%ProgramFiles(x86)%', '%ProgramData%', '%APPDATA%', '%LOCALAPPDATA%']) add(p); }) }, 'Windows system folders'),
      h('button', { class: 'btn', onclick: () => set(() => add('C:\\')) }, 'Whole drive C:\\')));
}

function grantsSection() {
  const rows = [];
  for (const [addon, caps] of Object.entries(P.grants)) {
    for (const cap of Object.keys(caps)) {
      rows.push(h('div', { class: 'grant' }, h('span', { style: 'flex:1' }, `${addon} — ${shortCap(cap)}`),
        h('button', { class: 'btn', onclick: () => set(() => { delete P.grants[addon][cap]; if (!Object.keys(P.grants[addon]).length) delete P.grants[addon]; }) }, 'Revoke')));
    }
  }
  return section('Always allowed', note('Choices you made with "Always allow". Revoke one to be asked again.'), ...(rows.length ? rows : [h('div', { class: 'muted' }, 'Nothing yet.')]));
}

function testSection() {
  const p = h('input', { type: 'text', class: 'grow', placeholder: 'C:\\Windows\\notepad.exe' });
  const a = h('select', {}, [['read', 'read'], ['write', 'create / change'], ['delete', 'delete (Recycle Bin)'], ['delete-permanent', 'delete permanently']].map(([v, l]) => h('option', { value: v }, l)));
  const out = h('div', { class: 'res', hidden: true });
  return section('Try a path',
    note('See what would happen without doing anything.'),
    h('div', { class: 'row' }, p, a, h('button', { class: 'btn', onclick: async () => {
      const r = await api.permExplain(p.value.trim(), a.value);
      out.hidden = false;
      if (r.error) { out.className = 'res deny'; out.textContent = r.error; return; }
      out.className = 'res ' + r.decision;
      out.textContent = `${r.decision.toUpperCase()}\n${r.why}\nAction permission: ${r.capMode}   Folder rule: ${r.locMode || '—'}${r.rule ? '  (' + r.rule + ')' : ''}\n${r.real}`;
    } }, 'Check')), out);
}

function dangerSection() {
  return h('section', { class: 'box danger-zone' }, h('h3', {}, 'Danger zone'),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: P.dangerous, onchange: (e) => set(() => { P.dangerous = e.target.checked; }) }),
      ' Allow deleting a whole drive, the Windows folder or your user folder'),
    note('Off by default, even when deleting is allowed. Turn on only if you really want Saeed to be able to do this.'));
}

const logBody = h('tbody', {});
async function paintLog() {
  const rows = await api.permLog();
  logBody.replaceChildren(...rows.map((e) => h('tr', {},
    h('td', {}, new Date(e.t).toLocaleString()), h('td', {}, e.addon || ''), h('td', {}, shortCap(e.cap)),
    h('td', {}, e.path || ''), h('td', { class: e.decision }, `${e.decision}${e.how ? ' (' + e.how + ')' : ''}`))));
}
function logSection() {
  paintLog();
  return section('Activity',
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: paintLog }, 'Refresh'),
      h('button', { class: 'btn danger', onclick: async () => { await api.permClearLog(); paintLog(); } }, 'Clear')),
    h('table', { class: 'log' }, logBody));
}

let timer = 0;
function render() {
  const y = window.scrollY;
  clearInterval(timer);
  root.replaceChildren(capsSection(), placesSection(), grantsSection(), testSection(), dangerSection(), logSection(),
    h('div', { class: 'btns' }, h('button', { class: 'btn danger', onclick: () => { if (confirm('Reset all permissions to the safe defaults?')) set(() => { P = structuredClone(info.defaults); }); } }, 'Reset all to defaults')));
  timer = setInterval(() => { if (!document.hidden) paintLog(); }, 4000);
  window.scrollTo(0, y);
}
render();

api.onConfig((c) => {
  cfg = c; P = c.settings.permissions;
  const el = document.activeElement;
  if (!el || el === document.body || el.tagName === 'BUTTON') render();
});
applyI18n();
