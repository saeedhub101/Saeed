import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Character } from '../shared/character.js';
import { BONES, autoMap } from '../shared/schema.js';
import { builtinClips, sampleTrack, INTENTS } from '../shared/clips.js';
import { RIG_TEMPLATES, makeTemplate } from '../shared/rigbuilder.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const round = (v) => Math.round(v * 1000) / 1000;

/* ============ tiny DOM helper ============ */
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') e.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') e.checked = !!v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  if (value !== undefined) e.value = value;
  return e;
}
function slider(label, val, min, max, step, onInput) {
  const rng = h('input', { type: 'range', min, max, step, value: val });
  const num = h('input', { type: 'number', min, max, step, value: round(val) });
  rng.addEventListener('input', () => { num.value = round(+rng.value); onInput(+rng.value); });
  num.addEventListener('change', () => { rng.value = num.value; onInput(+num.value); });
  const row = h('label', { class: 'slider' }, h('span', { class: 'lbl' }, label), rng, num);
  row.set = (v) => { rng.value = v; num.value = round(v); };
  return row;
}
const notice = (text, ...extra) => h('div', { class: 'notice' }, text, ...extra);
let toastTimer;
function flash(msg) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/* ============ state ============ */
let cfg = await api.getConfig();
cfg.clips ||= {}; cfg.overrides ||= {}; cfg.restPose ||= {}; cfg.boneMap ||= {};
let tab = new URLSearchParams(location.search).get('tab') || 'bones';
let sel = 'head';        // selected canonical bone
let ui = {};             // live element refs of the current panel
let markTarget = null;   // bone shown with a marker in the viewport

let saveTimer; const pending = {};
function save(patch) {
  Object.assign(cfg, patch); Object.assign(pending, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { api.setConfig({ ...pending }); for (const k in pending) delete pending[k]; }, 250);
}

/* ============ viewport ============ */
const renderer = new THREE.WebGLRenderer({ canvas: $('c'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x778899, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(2, 4, 3); scene.add(sun);
scene.add(new THREE.GridHelper(4, 16, 0x3a4252, 0x2a303b));
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
camera.position.set(0, 1.1, 4.2);
const controls = new OrbitControls(camera, $('c'));
controls.target.set(0, 0.9, 0); controls.enableDamping = true; controls.update();
new ResizeObserver(() => {
  const r = $('view').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix();
}).observe($('view'));
const marker = new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), new THREE.MeshBasicMaterial({ color: 0x8fb4ff, depthTest: false }));
marker.renderOrder = 999; marker.visible = false; scene.add(marker);

const ch = new Character(scene);

/* ============ model loading ============ */
const toAB = (b) => (b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
function flush() {
  clearTimeout(saveTimer);
  if (Object.keys(pending).length) { api.setConfig({ ...pending }); for (const k in pending) delete pending[k]; }
}
async function reloadModel() {
  flush();
  $('status').textContent = 'Loading…';
  const buf = await api.readModel();
  if (!buf) { ch.unload(); $('status').textContent = 'No character yet'; setTab(tab); return; }
  try {
    await ch.load(toAB(buf), cfg);
    ch.showSkeleton($('chkSkel').checked);
    $('status').textContent = ch.allBones.length ? `${ch.allBones.length} bones` : 'No skeleton in this model';
  } catch (e) { console.error(e); ch.unload(); $('status').textContent = 'This file could not be read'; }
  setTab(tab);
}

/* ============ tabs ============ */
const TABS = [['bones', 'Bones'], ['pose', 'Pose'], ['fix', 'Fix motions'], ['create', 'Create motion'], ['rig', 'Rig builder'], ['test', 'Test']];
function setTab(t) {
  tab = t;
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === t);
  ch.mode = t === 'fix' || t === 'create' ? 'preview' : t === 'test' ? 'engine' : 'rest';
  if (ch.mode === 'rest') ch.applyRestPose();
  if (ch.mode === 'engine') ch.actions = [];
  markTarget = null;
  renderPanel();
  drawDraft();
}
function renderPanel() {
  const p = $('panel'), st = p.scrollTop;
  ui = {};
  p.replaceChildren(ch.model ? PANELS[tab]() : notice('Choose a character (.glb) to begin.',
    h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: () => api.pickModel() }, 'Choose character…'))));
  p.scrollTop = st;
}
for (const [id, label] of TABS) $('tabs').append(h('button', { 'data-tab': id, onclick: () => setTab(id) }, label));

/* ============ shared widgets ============ */
const mappedBones = () => BONES.filter((b) => ch.map[b.id]);
function chips(ids, current, onPick) {
  return h('div', { class: 'list' }, ids.map((id) => h('button', { class: id === current ? 'on' : '', onclick: () => onPick(id) },
    BONES.find((b) => b.id === id)?.label || id)));
}
const effectiveMap = () => (Object.keys(cfg.boneMap).length ? cfg.boneMap : autoMap(ch.allBones));
const markName = (n) => { markTarget = ch.allBones.find((b) => b.name === n) || null; };

/* ============ Bones tab ============ */
function panelBones() {
  if (!ch.allBones.length) return notice('This model has no skeleton. Use the Rig builder tab to create one.');
  const names = [...new Set(ch.allBones.map((b) => b.name))];
  const eff = effectiveMap();
  const setMap = (m) => { cfg.boneMap = { __manual: true, ...m }; save({ boneMap: cfg.boneMap }); ch.applyConfig(cfg); renderPanel(); };
  const rows = BONES.map(({ id, label }) => {
    const cur = eff[id] || '';
    return h('div', { class: 'row' + (cur ? '' : ' dim'), onmouseenter: () => markName(cur), onmouseleave: () => (markTarget = null) },
      h('span', { class: 'lbl' }, label),
      h('select', { class: 'grow', value: cur, onchange: (e) => { const m = { ...eff }; if (e.target.value) m[id] = e.target.value; else delete m[id]; setMap(m); } },
        h('option', { value: '' }, '— none —'), names.map((n) => h('option', { value: n }, n))));
  });
  const tree = h('div', { class: 'tree' });
  (function walk(o, d) {
    if (o.isBone) { tree.append(h('div', { style: `padding-left:${d * 12 + 4}px`, onclick: () => { markTarget = o; } }, o.name)); d++; }
    for (const c of o.children) walk(c, d);
  })(ch.model, 0);
  const warn = ch.checkSides();
  return h('div', {},
    h('h3', {}, 'Match this model\'s bones to the program\'s bones'),
    h('p', { class: 'muted' }, `${Object.keys(ch.map).length} of ${BONES.length} matched. You only need the bones you want to animate.`),
    warn && h('p', { class: 'warn' }, warn),
    h('div', { class: 'btns' },
      h('button', { class: 'primary btn', onclick: () => setMap(autoMap(ch.allBones)) }, 'Auto-detect'),
      h('button', { onclick: () => setMap({}) }, 'Clear all'),
      h('button', { onclick: () => {
        const m = { ...eff };
        for (const { id } of BONES) if (id.startsWith('left')) {
          const rid = 'right' + id.slice(4), a = m[id], b = m[rid];
          if (b) m[id] = b; else delete m[id];
          if (a) m[rid] = a; else delete m[rid];
        }
        setMap(m);
      } }, 'Swap left / right')),
    rows,
    h('details', {}, h('summary', {}, `Skeleton in the file (${ch.allBones.length} bones) — click a name to find it`), tree));
}

/* ============ Pose tab ============ */
function panelPose() {
  const bones = mappedBones();
  if (!bones.length) return notice('Match some bones first (Bones tab).');
  if (!bones.find((b) => b.id === sel)) sel = bones[0].id;
  const rp = cfg.restPose;
  const apply = () => { ch.applyRestPose(); save({ restPose: rp }); };
  const cur = rp[sel] || [0, 0, 0];
  markTarget = ch.map[sel];
  const mirror = (from) => {
    for (const b of BONES) {
      if (!b.id.startsWith(from)) continue;
      const to = from === 'left' ? 'right' + b.id.slice(4) : 'left' + b.id.slice(5);
      const r = rp[b.id];
      if (r) rp[to] = [r[0], -r[1], -r[2]]; else delete rp[to];
    }
    apply(); renderPanel();
  };
  return h('div', {},
    h('h3', {}, 'Neutral pose'),
    h('p', { class: 'muted' }, 'Motions are built on this pose: standing, facing front, arms down. Rotations are in model space, so the same numbers work on any rig.'),
    h('div', { class: 'btns' },
      h('button', { class: 'primary btn', onclick: () => { ch.autoArmsDown(); save({ restPose: rp }); renderPanel(); } }, 'Arms down (fix T-pose)'),
      h('button', { onclick: () => mirror('left') }, 'Copy left → right'),
      h('button', { onclick: () => mirror('right') }, 'Copy right → left'),
      h('button', { class: 'danger', onclick: () => { cfg.restPose = {}; save({ restPose: cfg.restPose }); ch.applyConfig(cfg); renderPanel(); } }, 'Reset all')),
    h('h3', {}, 'Bone'),
    chips(bones.map((b) => b.id), sel, (id) => { sel = id; renderPanel(); }),
    ['Tilt forward / back (X)', 'Turn left / right (Y)', 'Tilt sideways (Z)'].map((l, i) =>
      slider(l, cur[i], -180, 180, 1, (v) => { const a = rp[sel] ? [...rp[sel]] : [0, 0, 0]; a[i] = v; rp[sel] = a; apply(); })),
    h('div', { class: 'btns' }, h('button', { onclick: () => { delete rp[sel]; apply(); renderPanel(); } }, 'Reset this bone')));
}

/* ============ Test tab ============ */
function panelTest() {
  const custom = Object.keys(ch.clips).filter((c) => !(c in builtinClips()));
  const run = (name, args) => { ch.command(name, args); api.sendCommand(name, args); };
  const say = h('input', { type: 'text', class: 'grow', value: 'Hello! I am ready.' });
  return h('div', {},
    h('h3', {}, 'Intents'),
    h('p', { class: 'muted' }, 'The brain only sends an intent such as happy. The engine decides the movement. These also play on the desktop character.'),
    h('div', { class: 'btns' }, Object.keys({ ...INTENTS, ...cfg.intents }).map((n) => h('button', { onclick: () => run(n) }, n))),
    custom.length ? [h('h3', {}, 'Your motions'), h('div', { class: 'btns' }, custom.map((n) => h('button', { onclick: () => run(n) }, n)))] : null,
    h('h3', {}, 'Speech bubble'),
    h('div', { class: 'row' }, say, h('button', { class: 'btn', onclick: () => { api.sendCommand('say', { text: say.value }); ch.command('talk', { duration: 2.5 }); } }, 'Say')),
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: ch.autoIdle, onchange: (e) => (ch.autoIdle = e.target.checked) }), 'Idle looks around by itself'));
}

/* ============ Motion preview shared by Fix + Create ============ */
const fx = { clip: 'wave', bone: null, t: 0, playing: true, speed: 1, loop: true };
const cr = { clip: null, bone: 'head', t: 0, playing: false, speed: 1, loop: true };

function tickMotion(st, useOverrides, dt) {
  const clip = ch.clips[st.clip];
  if (!clip) { ch.preview = null; return; }
  if (st.playing) {
    st.t += dt * st.speed;
    if (st.t > clip.duration) {
      if (st.loop) st.t %= clip.duration || 1;
      else { st.t = clip.duration; st.playing = false; if (ui.play) ui.play.textContent = 'Play'; }
    }
    if (ui.timeEl) ui.timeEl.value = st.t;
    if (st === cr) syncSliders();
  }
  ch.preview = { clip, t: st.t, ovr: useOverrides ? cfg.overrides[clip.name] : null };
}

function transport(st) {
  const clip = ch.clips[st.clip];
  const play = h('button', { class: 'btn', onclick: () => {
    st.playing = !st.playing;
    if (st.playing && !st.loop && st.t >= ch.clips[st.clip].duration - 0.01) st.t = 0;
    play.textContent = st.playing ? 'Pause' : 'Play';
  } }, st.playing ? 'Pause' : 'Play');
  const time = h('input', { type: 'range', class: 'grow', min: 0, max: clip.duration, step: 0.01, value: st.t, oninput: (e) => {
    st.t = +e.target.value; st.playing = false; play.textContent = 'Play';
    if (st === cr) syncSliders();
  } });
  ui.timeEl = time; ui.play = play;
  return h('div', { class: 'transport' }, play, time,
    h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: st.loop, onchange: (e) => (st.loop = e.target.checked) }), 'Loop'),
    h('select', { value: st.speed, onchange: (e) => (st.speed = +e.target.value) }, [0.25, 0.5, 1, 2].map((s) => h('option', { value: s }, s + '×'))));
}

function clipSelect(st, onChange) {
  return h('select', { class: 'grow', value: st.clip, onchange: (e) => { st.clip = e.target.value; st.t = 0; onChange(); } },
    Object.keys(ch.clips).map((n) => h('option', { value: n }, n)));
}

/* ============ Fix motions tab (axis fixes per bone) ============ */
const DEF = { swz: [0, 1, 2], sign: [1, 1, 1], scale: 1, offset: [0, 0, 0] };
const getO = (c, b) => ({ ...structuredClone(DEF), ...structuredClone(cfg.overrides[c]?.[b] || {}) });
function setO(c, b, o) {
  cfg.overrides[c] ||= {};
  if (JSON.stringify(o) === JSON.stringify(DEF)) delete cfg.overrides[c][b]; else cfg.overrides[c][b] = o;
  if (!Object.keys(cfg.overrides[c]).length) delete cfg.overrides[c];
  save({ overrides: cfg.overrides });
}

function panelFix() {
  const names = Object.keys(ch.clips);
  if (!ch.clips[fx.clip]) fx.clip = names[0];
  const clip = ch.clips[fx.clip];
  if (!clip.tracks.find((t) => t.bone === fx.bone)) fx.bone = clip.tracks[0]?.bone || null;
  markTarget = fx.bone ? ch.map[fx.bone] : null;
  const AX = ['x', 'y', 'z'];
  const body = [];
  if (fx.bone) {
    const o = getO(fx.clip, fx.bone);
    const commit = (n) => { setO(fx.clip, fx.bone, n); renderPanel(); };
    const swap = (a, b) => { const n = structuredClone(o); [n.swz[a], n.swz[b]] = [n.swz[b], n.swz[a]]; [n.sign[a], n.sign[b]] = [n.sign[b], n.sign[a]]; commit(n); };
    body.push(
      h('h3', {}, `${BONES.find((b) => b.id === fx.bone)?.label || fx.bone}: axis fix`),
      h('p', { class: 'muted' }, 'If the bone moves the wrong way, change which axis feeds each axis, or flip its sign. The preview updates live.'),
      [0, 1, 2].map((i) => h('div', { class: 'row' },
        h('span', { class: 'lbl' }, `${AX[i].toUpperCase()} takes the motion of`),
        h('select', { value: o.swz[i], onchange: (e) => { const n = structuredClone(o); n.swz[i] = +e.target.value; commit(n); } }, AX.map((a, j) => h('option', { value: j }, a.toUpperCase()))),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: o.sign[i] < 0, onchange: (e) => { const n = structuredClone(o); n.sign[i] = e.target.checked ? -1 : 1; commit(n); } }), 'flip'))),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Strength'),
        h('input', { type: 'number', step: 0.1, value: o.scale, onchange: (e) => { const n = structuredClone(o); n.scale = +e.target.value; commit(n); } })),
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Extra rotation (°)'),
        [0, 1, 2].map((i) => h('input', { type: 'number', step: 1, value: o.offset[i], onchange: (e) => { const n = structuredClone(o); n.offset[i] = +e.target.value; commit(n); } }))),
      h('div', { class: 'btns' },
        h('button', { onclick: () => swap(0, 2) }, 'Swap X ↔ Z'), h('button', { onclick: () => swap(0, 1) }, 'Swap X ↔ Y'), h('button', { onclick: () => swap(1, 2) }, 'Swap Y ↔ Z'),
        h('button', { onclick: () => commit({ ...structuredClone(o), sign: o.sign.map((s) => -s) }) }, 'Flip all'),
        h('button', { onclick: () => commit(structuredClone(DEF)) }, 'Reset this bone')),
      h('div', { class: 'btns' },
        h('button', { onclick: () => { for (const t of clip.tracks) setO(fx.clip, t.bone, structuredClone(o)); renderPanel(); } }, 'Use these settings on every bone of this motion'),
        h('button', { class: 'danger', onclick: () => { delete cfg.overrides[fx.clip]; save({ overrides: cfg.overrides }); renderPanel(); } }, 'Reset whole motion')),
      h('div', { class: 'btns' }, h('button', { class: 'primary btn', onclick: () => { cr.clip = fx.clip; setTab('create'); } }, 'Edit the keyframes of this motion…')));
  }
  return h('div', {},
    h('h3', {}, 'Fix a generated motion'),
    h('div', { class: 'row' }, clipSelect(fx, renderPanel)),
    transport(fx),
    h('h3', {}, 'Bones used by this motion'),
    h('div', { class: 'list' }, clip.tracks.map((t) => h('button', {
      class: t.bone === fx.bone ? 'on' : ch.map[t.bone] ? '' : 'off', title: ch.map[t.bone] ? '' : 'Not matched to a bone in this model',
      onclick: () => { fx.bone = t.bone; renderPanel(); } }, BONES.find((b) => b.id === t.bone)?.label || t.bone))),
    body);
}

/* ============ Create motion tab (keyframes + generator) ============ */
const gen = { axis: 0, amp: 20, cycles: 2, phase: 0, off: 0 };
const commitClips = () => save({ clips: cfg.clips });
function editable() {
  if (!cfg.clips[cr.clip]) { cfg.clips[cr.clip] = structuredClone(ch.clips[cr.clip]); ch.clips[cr.clip] = cfg.clips[cr.clip]; }
  return cfg.clips[cr.clip];
}
function valuesAt(clip, bone) {
  const tr = clip.tracks.find((t) => t.bone === bone);
  return (tr && sampleTrack(tr, cr.t, false, clip.duration)) || { r: [0, 0, 0], p: null };
}
function setKey(clip, bone, t, r, p) {
  let tr = clip.tracks.find((x) => x.bone === bone);
  if (!tr) { tr = { bone, keys: [] }; clip.tracks.push(tr); }
  let k = tr.keys.find((x) => Math.abs(x.t - t) < 0.02);
  if (!k) { k = { t: +t.toFixed(3) }; tr.keys.push(k); }
  k.r = r.map(round);
  if (p) k.p = p.map(round);
  tr.keys.sort((a, b) => a.t - b.t);
  commitClips();
}
function syncSliders() {
  if (!ui.sl) return;
  const v = valuesAt(ch.clips[cr.clip], cr.bone);
  ui.sl.forEach((s, i) => s.set(i < 3 ? v.r[i] : (v.p || [0, 0, 0])[i - 3]));
}
function drawKeys() {
  const box = ui.keys; if (!box) return;
  const clip = ch.clips[cr.clip];
  const tr = clip.tracks.find((t) => t.bone === cr.bone);
  const edit = (i, fn) => { const c = editable(); const t = c.tracks.find((x) => x.bone === cr.bone); fn(t.keys[i], t); t.keys.sort((a, b) => a.t - b.t); commitClips(); drawKeys(); };
  box.replaceChildren(...(tr && tr.keys.length ? tr.keys.map((k, i) => h('div', { class: 'krow' },
    h('input', { type: 'number', step: 0.05, min: 0, value: k.t, title: 'time (s)', onchange: (e) => edit(i, (kk) => (kk.t = Math.max(0, +e.target.value))) }),
    [0, 1, 2].map((j) => h('input', { type: 'number', step: 1, value: k.r[j], title: 'XYZ °'[j] || '', onchange: (e) => edit(i, (kk) => (kk.r[j] = +e.target.value)) })),
    h('button', { class: 'x', title: 'Go to this key', onclick: () => { cr.t = k.t; cr.playing = false; if (ui.timeEl) ui.timeEl.value = k.t; if (ui.play) ui.play.textContent = 'Play'; syncSliders(); } }, '↦'),
    h('button', { class: 'x', title: 'Delete key', onclick: () => edit(i, (kk, t) => { t.keys.splice(i, 1); if (!t.keys.length) editable().tracks.splice(editable().tracks.indexOf(t), 1); }) }, '×')))
    : [h('p', { class: 'muted' }, 'No keys for this bone yet. Move a slider or use the generator.')]));
}

function panelCreate() {
  const names = Object.keys(ch.clips);
  if (!cr.clip || !ch.clips[cr.clip]) cr.clip = names.includes('wave') ? 'wave' : names[0];
  const clip = ch.clips[cr.clip];
  const bones = mappedBones();
  if (!bones.find((b) => b.id === cr.bone)) cr.bone = bones[0]?.id;
  markTarget = ch.map[cr.bone] || null;
  const isBuiltin = cr.clip in builtinClips();
  const nameIn = h('input', { type: 'text', placeholder: 'my_motion', class: 'grow' });
  const create = (copy) => {
    const n = nameIn.value.trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(n) || ch.clips[n]) return flash('Use a new name: letters, digits and _ only.');
    cfg.clips[n] = copy ? { ...structuredClone(ch.clips[cr.clip]), name: n } : { name: n, duration: 2, loop: false, tracks: [] };
    ch.clips[n] = cfg.clips[n]; cr.clip = n; cr.t = 0; commitClips(); renderPanel();
  };
  const v0 = valuesAt(clip, cr.bone);
  ui.sl = [];
  const mk = (label, i, val, min, max, step) => {
    const s = slider(label, val, min, max, step, (v) => {
      const c = editable(); const cur = valuesAt(c, cr.bone);
      if (i < 3) cur.r[i] = v; else { cur.p = cur.p || [0, 0, 0]; cur.p[i - 3] = v; }
      setKey(c, cr.bone, cr.t, cur.r, cur.p); drawKeys();
    });
    ui.sl.push(s); return s;
  };
  const sliders = [mk('Tilt forward / back (X)', 0, v0.r[0], -180, 180, 1), mk('Turn left / right (Y)', 1, v0.r[1], -180, 180, 1), mk('Tilt sideways (Z)', 2, v0.r[2], -180, 180, 1)];
  if (cr.bone === 'hips') sliders.push(mk('Move right (body height %)', 3, (v0.p || [0, 0, 0])[0], -0.3, 0.3, 0.005), mk('Move up', 4, (v0.p || [0, 0, 0])[1], -0.3, 0.3, 0.005), mk('Move forward', 5, (v0.p || [0, 0, 0])[2], -0.3, 0.3, 0.005));
  ui.keys = h('div', {});
  const out = h('div', {},
    h('h3', {}, 'Motion'),
    h('div', { class: 'row' }, clipSelect(cr, renderPanel),
      (isBuiltin ? !!cfg.clips[cr.clip] : true) && h('button', { class: 'danger btn', onclick: () => {
        delete cfg.clips[cr.clip];
        if (isBuiltin) ch.clips[cr.clip] = builtinClips()[cr.clip]; else { delete ch.clips[cr.clip]; cr.clip = null; }
        commitClips(); renderPanel();
      } }, isBuiltin ? 'Restore original' : 'Delete')),
    h('div', { class: 'row' }, nameIn, h('button', { class: 'btn', onclick: () => create(false) }, 'New empty'), h('button', { class: 'btn', onclick: () => create(true) }, 'Duplicate')),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Length (seconds)'),
      h('input', { type: 'number', step: 0.1, min: 0.2, value: clip.duration, onchange: (e) => { editable().duration = Math.max(0.2, +e.target.value); commitClips(); renderPanel(); } }),
      h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: clip.loop, onchange: (e) => { editable().loop = e.target.checked; commitClips(); } }), 'Repeats')),
    transport(cr),
    h('p', { class: 'muted' }, 'This preview shows the raw keys; axis fixes from the other tab are not applied here.'),
    h('h3', {}, 'Bone'),
    chips(bones.map((b) => b.id), cr.bone, (id) => { cr.bone = id; renderPanel(); }),
    sliders,
    h('h3', {}, 'Keys of this bone'),
    ui.keys,
    h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => { const c = editable(); c.tracks = c.tracks.filter((t) => t.bone !== cr.bone); commitClips(); renderPanel(); } }, 'Clear this bone')),
    h('h3', {}, 'Generate a swing'),
    h('p', { class: 'muted' }, 'Fills this bone with a smooth back-and-forth motion on one axis. Other axes keep their current values.'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Axis'), h('select', { value: gen.axis, onchange: (e) => (gen.axis = +e.target.value) }, ['X', 'Y', 'Z'].map((a, i) => h('option', { value: i }, a)))),
    [['Amplitude (°)', 'amp', 1], ['Swings', 'cycles', 0.5], ['Start offset (0–1)', 'phase', 0.05], ['Centre (°)', 'off', 1]].map(([l, k, st]) =>
      h('div', { class: 'row' }, h('span', { class: 'lbl' }, l), h('input', { type: 'number', step: st, value: gen[k], onchange: (e) => (gen[k] = +e.target.value) }))),
    h('div', { class: 'btns' }, h('button', { class: 'primary btn', onclick: () => {
      const c = editable();
      let tr = c.tracks.find((t) => t.bone === cr.bone);
      if (!tr) { tr = { bone: cr.bone, keys: [] }; c.tracks.push(tr); }
      const old = tr.keys.slice();
      const N = Math.max(4, Math.round(gen.cycles * 12));
      tr.keys = [];
      for (let i = 0; i <= N; i++) {
        const t = (c.duration * i) / N;
        const r = old.length ? sampleTrack({ keys: old }, t, false, c.duration).r : [0, 0, 0];
        r[gen.axis] = round(gen.off + gen.amp * Math.sin(2 * Math.PI * ((gen.cycles * i) / N + gen.phase)));
        tr.keys.push({ t: +t.toFixed(3), r });
      }
      commitClips(); drawKeys(); syncSliders();
    } }, 'Generate on this bone')));
  queueMicrotask(drawKeys);
  return out;
}

/* ============ Rig builder tab ============ */
let draft = null;      // { bones: [{name,parent,pos}], radius }
let rigGroup = null;
function drawDraft() {
  if (rigGroup) { rigGroup.parent?.remove(rigGroup); rigGroup = null; }
  if (tab !== 'rig' || !draft || !ch.model || ch.hasSkeleton || !ch.box) return;
  rigGroup = new THREE.Group();
  const R = (ch.box.max.y - ch.box.min.y) * 0.012;
  const mat = new THREE.MeshBasicMaterial({ color: 0xffb454, depthTest: false });
  const lmat = new THREE.LineBasicMaterial({ color: 0xffb454, depthTest: false });
  const pts = new Map(draft.bones.map((b) => [b.name, new THREE.Vector3(...b.pos)]));
  for (const b of draft.bones) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(R, 10, 8), mat);
    m.position.copy(pts.get(b.name)); m.renderOrder = 999; rigGroup.add(m);
    const p = pts.get(b.parent);
    if (p) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p, pts.get(b.name)]), lmat); l.renderOrder = 999; rigGroup.add(l); }
  }
  ch.model.add(rigGroup);
}

async function exportRigged() {
  try {
    const buf = await ch.exportGLB();
    const p = await api.saveModel(buf, 'character-rigged.glb');
    if (!p) return;
    save({ modelPath: p, customRig: null });
    await reloadModel();
    flash('Saved. The new file is now your character.');
  } catch (e) { console.error(e); flash('Export failed: ' + e.message); }
}

function buildRigNow() {
  const names = draft.bones.map((b) => b.name);
  if (!names.length) return flash('Add at least one bone.');
  if (names.some((n) => !n || n === 'root') || new Set(names).size !== names.length) return flash('Bone names must be unique, not empty, and not "root".');
  save({ customRig: structuredClone(draft) });
  reloadModel();
}

function panelRig() {
  if (ch.hasSkeleton && !ch.rigBuilt) return notice('This model already has a skeleton, so there is nothing to build. This tab is for models that have none.');
  if (ch.rigBuilt) {
    return h('div', {},
      h('h3', {}, 'Skeleton built by this program'),
      h('p', { class: 'muted' }, `${cfg.customRig.bones.length} bones are bound to the mesh. Export a GLB to keep the rig inside the file.`),
      h('div', { class: 'btns' },
        h('button', { class: 'primary btn', onclick: exportRigged }, 'Export GLB with this rig…'),
        h('button', { onclick: () => { draft = structuredClone(cfg.customRig); save({ customRig: null }); reloadModel(); } }, 'Edit bones again'),
        h('button', { class: 'danger', onclick: () => { save({ customRig: null }); reloadModel(); } }, 'Remove rig')));
  }
  if (!draft) draft = { bones: [], radius: 0.12 };
  const kind = h('select', {}, Object.entries(RIG_TEMPLATES).map(([k, l]) => h('option', { value: k }, l)));
  const rename = (i, name) => {
    const old = draft.bones[i].name;
    for (const b of draft.bones) if (b.parent === old) b.parent = name;
    draft.bones[i].name = name; renderPanel(); drawDraft();
  };
  const rows = draft.bones.map((b, i) => h('div', { class: 'rigrow' },
    h('input', { type: 'text', value: b.name, onchange: (e) => rename(i, e.target.value.trim()) }),
    h('select', { value: b.parent || '', onchange: (e) => { b.parent = e.target.value || null; drawDraft(); } },
      h('option', { value: '' }, 'root'), draft.bones.filter((_, j) => j !== i).map((o) => h('option', { value: o.name }, o.name))),
    [0, 1, 2].map((k) => h('input', { type: 'number', step: 0.01, value: round(b.pos[k]), onchange: (e) => { b.pos[k] = +e.target.value; drawDraft(); } })),
    h('button', { class: 'x', title: 'Delete bone', onclick: () => {
      draft.bones.splice(i, 1);
      for (const o of draft.bones) if (o.parent === b.name) o.parent = b.parent;
      renderPanel(); drawDraft();
    } }, '×')));
  return h('div', {},
    h('h3', {}, 'Add bones to a model that has none'),
    h('p', { class: 'muted' }, 'Pick a template sized to the model, then move each joint (orange dots). You can build only the bones you need, for example just the arms. Bone names like leftUpperArm are matched automatically.'),
    h('div', { class: 'row' }, kind, h('button', { class: 'btn', onclick: () => { draft.bones = makeTemplate(kind.value, ch.box, cfg.modelYaw); renderPanel(); drawDraft(); } }, 'Generate')),
    h('h3', {}, 'Bones  (name · parent · x y z in model units)'),
    rows.length ? rows : h('p', { class: 'muted' }, 'No bones yet.'),
    h('div', { class: 'btns' }, h('button', { onclick: () => {
      const last = draft.bones[draft.bones.length - 1];
      const c = last ? last.pos : [(ch.box.min.x + ch.box.max.x) / 2, (ch.box.min.y + ch.box.max.y) / 2, (ch.box.min.z + ch.box.max.z) / 2];
      draft.bones.push({ name: 'bone' + (draft.bones.length + 1), parent: last ? last.name : null, pos: c.map(round) });
      renderPanel(); drawDraft();
    } }, 'Add bone')),
    slider('Influence radius (% of height)', draft.radius * 100, 3, 40, 1, (v) => { draft.radius = v / 100; }),
    h('p', { class: 'muted' }, 'Each bone moves the mesh around it. Parts far from every bone stay still. A larger radius makes softer, wider bends.'),
    h('div', { class: 'btns' }, h('button', { class: 'primary btn', onclick: buildRigNow }, 'Build skeleton')));
}

/* ============ boot ============ */
const PANELS = { bones: panelBones, pose: panelPose, fix: panelFix, create: panelCreate, rig: panelRig, test: panelTest };

$('btnModel').onclick = () => api.pickModel();
$('yaw').value = String(cfg.modelYaw || 0);
$('yaw').onchange = (e) => { save({ modelYaw: +e.target.value }); ch.applyConfig(cfg); renderPanel(); drawDraft(); };
$('chkSkel').onchange = (e) => ch.showSkeleton(e.target.checked);

api.onConfig((c) => {
  const reload = c.modelPath !== cfg.modelPath || JSON.stringify(c.customRig) !== JSON.stringify(cfg.customRig);
  cfg = c; cfg.clips ||= {}; cfg.overrides ||= {}; cfg.restPose ||= {}; cfg.boneMap ||= {};
  $('yaw').value = String(cfg.modelYaw || 0);
  if (reload) reloadModel(); else { ch.applyConfig(cfg); renderPanel(); }
});
api.onStudioTab((t) => setTab(t));

let last = performance.now();
(function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (tab === 'fix') tickMotion(fx, true, dt); else if (tab === 'create') tickMotion(cr, false, dt);
  ch.update(dt);
  if (markTarget) { markTarget.getWorldPosition(marker.position); marker.visible = true; } else marker.visible = false;
  controls.update();
  renderer.render(scene, camera);
})(performance.now());

await reloadModel();
