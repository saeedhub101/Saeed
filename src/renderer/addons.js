import { h, toast, debounce, fmtBytes, fmtEta } from './ui.js';
import { applyI18n } from './i18n.js';
const api = window.api;
const root = document.getElementById('root');
let creating = false;
const packSpec = { name: '', kind: 'attach', file: '', bone: 'head', slot: 'top', hide: '' };
let tab = 'installed', installed = await api.addonsList(), store = null, storeErr = '', storeNotes = [], cat = 'all', showSources = false, linkOpen = false;
const CATS = [['all', 'All'], ['files', 'Files and Office'], ['web', 'Web and browser'], ['data', 'Data'], ['voice', 'Voice'], ['brain', 'Brains'], ['look', 'Look'], ['other', 'Other']];
const bars = {};

for (const b of document.querySelectorAll('#tabs2 button')) {
  b.onclick = () => { tab = b.dataset.t; for (const x of document.querySelectorAll('#tabs2 button')) x.classList.toggle('on', x === b); if (tab === 'store' && !store) loadStore(); render(); };
}
document.getElementById('pack').onclick = () => { tab = 'installed'; creating = !creating; for (const x of document.querySelectorAll('#tabs2 button')) x.classList.toggle('on', x.dataset.t === 'installed'); render(); };
document.getElementById('link').onclick = () => { tab = 'store'; linkOpen = !linkOpen; for (const x of document.querySelectorAll('#tabs2 button')) x.classList.toggle('on', x.dataset.t === 'store'); if (!store) loadStore(); render(); };
document.getElementById('zip').onclick = async () => {
  const r = await api.addonsInstallZip();
  if (r.ok) toast(`${r.addon} installed.`); else if (r.error !== 'Cancelled.') toast(r.error);
};
api.onAddonsChanged(async () => { installed = await api.addonsList(); if (store) markStore(); if (!document.activeElement || document.activeElement === document.body || tab === 'store') render(); });
api.onAddonsProgress((p) => {
  const b = bars[p.id];
  if (!b) return;
  b.bar.style.width = (p.total ? Math.min(100, (p.transferred / p.total) * 100) : 50) + '%';
  b.text.textContent = `${fmtBytes(p.transferred)}${p.total ? ' of ' + fmtBytes(p.total) : ''}  ·  ${fmtBytes(p.bps)}/s  ${fmtEta(p.eta)}`;
});

async function loadStore() {
  storeErr = ''; storeNotes = []; store = null; render();
  const r = await api.addonsRegistry();
  if (r.ok) { store = r.list; storeNotes = r.errors || []; } else storeErr = r.error;
  render();
}
function markStore() {
  for (const e of store) { const i = installed.find((a) => a.id === e.id); e.installed = !!i; e.installedVersion = i ? i.version : null; }
}

const chip = (p) => h('span', { class: 'chip ' + (/write|system|desktop/.test(p) ? (/system|desktop/.test(p) ? 'system' : 'write') : '') }, p);

function settingsForm(a) {
  if (!a.settingsDef.length) return null;
  const values = { ...a.settings };
  const save = debounce(() => api.addonsSaveSettings(a.id, values), 300);
  return h('div', { class: 'form' }, a.settingsDef.map((f) => {
    let el;
    if (f.type === 'select') el = h('select', { value: values[f.key] }, (f.options || []).map((o) => h('option', { value: Array.isArray(o) ? o[0] : o }, Array.isArray(o) ? o[1] : o)));
    else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', checked: !!values[f.key] });
    else el = h('input', { type: f.type === 'number' ? 'number' : 'text', value: values[f.key] ?? '', class: 'grow' });
    el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
      values[f.key] = el.type === 'checkbox' ? el.checked : f.type === 'number' ? Number(el.value) : el.value; save();
    });
    return h('div', { class: 'row' }, h('span', { class: 'lbl' }, f.label || f.key), el);
  }));
}

function installedCard(a) {
  const provides = Object.keys(a.provides || {}).map((k) => `${k.toUpperCase()} provider`);
  if (a.accessories) provides.push(`${a.accessories} accessories`);
  return h('div', { class: 'card' },
    h('div', { class: 'top' },
      h('div', { class: 'grow' }, h('h4', {}, a.name, ' ', h('span', { class: 'meta' }, `v${a.version}${a.author ? ' · ' + a.author : ''}`)), h('div', { class: 'meta' }, a.description)),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: a.enabled, onchange: (e) => api.addonsToggle(a.id, e.target.checked) }), 'On')),
    h('div', { class: 'chips' }, (a.permissions || []).map(chip), provides.map((p) => h('span', { class: 'chip' }, p)),
      a.tools.length ? h('span', { class: 'chip' }, `${a.tools.length} tools`) : null),
    h('div', { class: 'meta' }, h('span', { class: 'dot' + (a.running ? ' on' : '') }), a.running ? 'running now (stops by itself when idle)' : 'stopped — starts only when needed'),
    settingsForm(a),
    h('div', { class: 'btns' },
      a.running ? h('button', { onclick: () => api.addonsStop(a.id) }, 'Stop now') : null,
      h('button', { class: 'danger', onclick: async () => { if (confirm(`Remove "${a.name}"?`)) { await api.addonsRemove(a.id); toast('Removed.'); } } }, 'Remove')));
}

function storeCard(e) {
  const b = h('div', { class: 'bar', hidden: true }, h('div', {}));
  const t = h('div', { class: 'meta' });
  bars[e.id] = { bar: b.firstChild, text: t };
  const label = e.update ? `Update to ${e.version}` : e.installed ? 'Installed' : e.source === 'included' ? 'Add' : 'Install';
  const go = h('button', { class: 'btn' + (e.installed && !e.update ? '' : ' primary'), disabled: e.installed && !e.update, onclick: async () => {
    go.disabled = true; b.hidden = false; t.textContent = 'starting…';
    const r = await api.addonsInstall(e);
    b.hidden = true; t.textContent = '';
    if (r.ok) toast(`${e.name} installed.`); else { go.disabled = false; if (r.error !== 'Cancelled.') toast(r.error); }
  } }, label);
  return h('div', { class: 'card' },
    h('div', { class: 'top' }, h('div', { class: 'grow' }, h('h4', {}, e.name, ' ', h('span', { class: 'meta' }, `v${e.version}${e.author ? ' · ' + e.author : ''}${e.size ? ' · ' + fmtBytes(e.size) : ''}${e.source === 'included' ? ' · included with Saeed' : ''}`)), h('div', { class: 'meta' }, e.description)), go),
    h('div', { class: 'chips' }, (e.permissions || []).map(chip)), b, t);
}

// Makes an add-on from the user's own GLB: a hat, a bag, or clothes made for the same skeleton.
function packCard() {
  const S = packSpec;
  const field = (label, ...els) => h('div', { class: 'row' }, h('span', { class: 'lbl' }, label), ...els);
  const txt = (k, ph) => h('input', { type: 'text', class: 'grow', value: S[k], placeholder: ph || '', oninput: (e) => { S[k] = e.target.value; } });
  const BONES = ['head', 'neck', 'chest', 'hips', 'leftShoulder', 'rightShoulder', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot'];
  return h('div', { class: 'card' }, h('h4', {}, 'New accessory pack'),
    h('div', { class: 'meta' }, 'Turn a .glb file into an accessory or an outfit. Attach: the part follows one bone (hat, flag, bag). Outfit: clothes skinned to the same skeleton as the character (same bone names), they bend with the body.'),
    field('Name', txt('name', 'Blue jacket')),
    field('Kind', h('select', { value: S.kind, onchange: (e) => { S.kind = e.target.value; render(); } },
      h('option', { value: 'attach' }, 'Attach to a bone'), h('option', { value: 'outfit' }, 'Outfit (same skeleton)'))),
    field('GLB file', h('input', { type: 'text', class: 'grow', value: S.file, readonly: true }), h('button', { class: 'btn', onclick: async () => { const f = await api.pickFile(['glb']); if (f) { S.file = f; if (!S.name) S.name = f.split(/[\\/]/).pop().replace(/\.glb$/i, ''); render(); } } }, 'Browse…')),
    S.kind === 'attach'
      ? field('Bone', h('select', { value: S.bone, onchange: (e) => { S.bone = e.target.value; } }, BONES.map((b) => h('option', { value: b }, b))))
      : [field('Slot', txt('slot', 'top, bottom, shoes, full')), field('Hide body meshes', txt('hide', 'Body_Shirt, Body_Arms'))],
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', onclick: async () => {
        const r = await api.addonsCreatePack({ ...S });
        if (r.ok) { toast('Created. Turn it on in the tray menu or Studio → Accessories.'); creating = false; S.name = ''; S.file = ''; render(); } else toast(r.error);
      } }, 'Create'),
      h('button', { class: 'btn', onclick: () => { creating = false; render(); } }, 'Cancel')));
}

function linkCard() {
  const url = h('input', { type: 'text', class: 'grow', placeholder: 'https://…/addon.zip   or   https://…/clothes.glb' });
  const bar = h('div', { class: 'bar', hidden: true }, h('div', {})), txt = h('div', { class: 'meta' });
  bars.link = { bar: bar.firstChild, text: txt };
  return h('div', { class: 'card' }, h('h4', {}, 'Install from a link'),
    h('div', { class: 'meta' }, 'Paste a direct link to an add-on (.zip) from any website, or to a 3D file (.glb) for an accessory or outfit. Only use links you trust.'),
    h('div', { class: 'row' }, url, h('button', { class: 'btn primary', onclick: async () => {
      bar.hidden = false; txt.textContent = 'downloading…';
      const r = await api.addonsInstallUrl(url.value.trim());
      bar.hidden = true; txt.textContent = '';
      if (!r.ok) { if (r.error !== 'Cancelled.') toast(r.error); return; }
      if (r.glb) { packSpec.file = r.glb; packSpec.name = packSpec.name || 'New item'; creating = true; tab = 'installed'; linkOpen = false; for (const x of document.querySelectorAll('#tabs2 button')) x.classList.toggle('on', x.dataset.t === 'installed'); render(); toast('Downloaded. Choose how to use it.'); }
      else { toast(`${r.addon} installed.`); linkOpen = false; render(); }
    } }, 'Download')), bar, txt);
}
function sourcesCard() {
  const list = [];
  return h('div', { class: 'card' }, h('h4', {}, 'Sources of add-ons'),
    h('div', { class: 'meta' }, 'Each source is a link to a registry.json. Saeed always shows the add-ons included with the app, plus your GitHub repository (Settings → Updates) and these extra sources.'),
    h('textarea', { rows: 4, class: 'grow', placeholder: 'My company | https://example.com/addons/registry.json', oninput: (e) => { list.length = 0; for (const line of e.target.value.split('\n')) { const [a, b] = line.includes('|') ? line.split('|') : ['', line]; if (b && b.trim()) list.push({ name: a.trim(), url: b.trim() }); } } }),
    h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: async () => { await api.addonsSetSources(list); toast('Sources saved.'); loadStore(); } }, 'Save sources')));
}

function render() {
  const y = window.scrollY;
  if (tab === 'installed') {
    root.replaceChildren(...(creating ? [packCard()] : []), ...(installed.length ? installed.map(installedCard) : [h('div', { class: 'empty' }, 'No add-ons installed yet. Open the Store tab, or install one from a file.')]));
  } else {
    const shown = store ? store.filter((e) => cat === 'all' || e.category === cat) : [];
    root.replaceChildren(
      linkOpen ? linkCard() : null,
      showSources ? sourcesCard() : null,
      h('div', { class: 'btns' }, h('button', { class: 'btn', onclick: loadStore }, 'Refresh list'), h('button', { class: 'btn', onclick: () => { showSources = !showSources; render(); } }, 'Sources…')),
      h('div', { class: 'chips' }, CATS.map(([id, label]) => h('button', { class: 'chip catbtn' + (cat === id ? ' on' : ''), onclick: () => { cat = id; render(); } }, label))),
      storeErr ? h('p', { class: 'warn' }, storeErr) : null,
      ...storeNotes.map((n) => h('p', { class: 'meta' }, 'Could not read a source: ' + n)),
      !store && !storeErr ? h('div', { class: 'empty' }, 'Loading the list…') : null,
      ...(store ? (shown.length ? shown.map(storeCard) : [h('div', { class: 'empty' }, 'Nothing in this category.')]) : []));
  }
  window.scrollTo(0, y);
}
render();
applyI18n();
