// The face: mouth shapes (visemes), blinking, brows, eyes and expressions driven by the model's shape keys (morph targets).
// Speech lip-sync is text-driven: letters become mouth shapes laid over the real audio duration and shaped by the audio loudness.
const rand = (a, b) => a + Math.random() * (b - a);

export const VISEMES = ['A', 'E', 'I', 'O', 'U', 'M', 'F', 'TH', 'S', 'SH', 'CH', 'J', 'R', 'L', 'N', 'D', 'T', 'K', 'G', 'KH', 'H', 'Q', 'AYN', 'W', 'Y'];
// When a mouth shape is not mapped, the nearest mapped one is used.
export const VIS_FALLBACK = { CH: ['SH'], J: ['SH', 'CH'], T: ['D'], N: ['D', 'L'], G: ['K'], Q: ['K'], KH: ['K', 'H'], H: ['A'], AYN: ['A'], Y: ['I'], W: ['U'], TH: ['D', 'S'], SH: ['S'], S: ['I'], R: ['E'], L: ['D'], D: ['I'], K: ['E'], F: ['M'] };
const OPEN = { A: 0.9, E: 0.55, I: 0.35, O: 0.65, U: 0.35, M: 0, F: 0.15, TH: 0.2, S: 0.2, SH: 0.25, CH: 0.25, J: 0.25, R: 0.3, L: 0.3, N: 0.2, D: 0.25, T: 0.25, K: 0.3, G: 0.3, KH: 0.35, H: 0.45, Q: 0.3, AYN: 0.55, W: 0.3, Y: 0.3 };
const LIVE_VOWEL = { aa: 'A', ee: 'E', ih: 'I', oh: 'O', ou: 'U' };

export const ROLES = [
  ['blink', 'Blink (both eyes)'], ['blinkL', 'Blink left'], ['blinkR', 'Blink right'], ['winkL', 'Wink left'], ['winkR', 'Wink right'],
  ['browUp', 'Brows up'], ['browDown', 'Brows down'], ['lookLeft', 'Look left'], ['lookRight', 'Look right'], ['lookUp', 'Look up'], ['lookDown', 'Look down'],
  ['jawOpen', 'Jaw open'], ['tongueOut', 'Tongue out'], ['cheekPuff', 'Cheeks puffed'],
  ['smile', 'Smile'], ['sad', 'Sad'], ['angry', 'Angry'], ['surprised', 'Surprised'], ['worried', 'Worried'], ['laugh', 'Laugh'], ['kiss', 'Kiss'],
];

export const DEFAULT_OPTS = { lipSync: 'text', lipGain: 1, jawBone: 0.7, jawMorph: 0.6, blink: true, blinkEvery: 4, eyes: true, eyeAmount: 1, micro: true, brows: true, exprGain: 1 };

/* ---------- finding shape keys by name ---------- */
const VIS_ALIASES = {
  A: ['a', 'aa', 'ah', 'ae'], E: ['e', 'ee', 'eh'], I: ['i', 'ih', 'iy', 'ii'], O: ['o', 'oh', 'ow'], U: ['u', 'ou', 'uw', 'oo'],
  F: ['f', 'ff', 'fv', 'v'], TH: ['th', 'dh'], M: ['m', 'pp', 'mbp', 'mb', 'p', 'b'], S: ['s', 'ss', 'z'], SH: ['sh', 'zh'], CH: ['ch', 'jh'], J: ['j'],
  R: ['r', 'rr'], L: ['l', 'll'], N: ['n', 'nn'], D: ['d', 'dd'], T: ['t', 'tt'], K: ['k', 'kk', 'c'], G: ['g', 'gg', 'gh'], KH: ['kh', 'x'],
  H: ['h', 'hh'], Q: ['q'], AYN: ['ayn', 'ain', 'ayin'], W: ['w', 'ww'], Y: ['y'],
};
const ROLE_RE = {
  blinkL: /blink.*left|blinkl$|lefteye.*clos|eyeclosel$/, blinkR: /blink.*right|blinkr$|righteye.*clos|eyecloser$/,
  blink: /^(eye)?blink$|eyesclosed|^eyeclose$|blinkboth/,
  winkL: /wink.*(l|left)$/, winkR: /wink.*(r|right)$/,
  browUp: /browinnerup|brow.*up|browraise|raisebrow/, browDown: /browdown|brow.*down|browlower|lowerbrow/,
  jawOpen: /jawopen|^mouthopen$/, tongueOut: /tongue/, cheekPuff: /cheekpuff/,
  smile: /^(mouth)?smile$|^happy$|^joy$/, sad: /^sad$|frown/, angry: /angry|anger/, surprised: /surpris|shock/,
};
const visKey = (n) => String(n).toLowerCase().replace(/^(viseme_|vrc\.v_|fcl_mth_|mth_|mouth_|blendshape\d*\.|face_)/, '').replace(/[^a-z0-9]/g, '');

export function autoFace(names) {
  const visemes = {}, roles = {};
  for (const n of names) {
    const k = visKey(n);
    for (const [v, al] of Object.entries(VIS_ALIASES)) if (al.includes(k) && !visemes[v]) { visemes[v] = [{ n, w: 1 }]; break; }
    const raw = String(n).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [r, re] of Object.entries(ROLE_RE)) if (re.test(raw) && !roles[r]) roles[r] = [{ n, w: 1 }];
  }
  return { visemes, roles, options: {} };
}

/* ---------- text -> mouth shapes ---------- */
const AR = { 'ب': 'M', 'ت': 'T', 'ث': 'TH', 'ج': 'J', 'ح': 'H', 'خ': 'KH', 'د': 'D', 'ذ': 'TH', 'ر': 'R', 'ز': 'S', 'س': 'S', 'ش': 'SH', 'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'TH',
  'ع': 'AYN', 'غ': 'G', 'ف': 'F', 'ق': 'Q', 'ك': 'K', 'ل': 'L', 'م': 'M', 'ن': 'N', 'ه': 'H', 'ا': 'A', 'أ': 'A', 'إ': 'I', 'آ': 'A', 'ى': 'A', 'ة': 'A', 'ئ': 'I', 'ؤ': 'U', 'و': 'U', 'ي': 'I', 'ء': null };
const AR_LONG = new Set(['ا', 'أ', 'إ', 'آ', 'ى', 'و', 'ي']);
const AR_DIA = { '\u064E': 'A', '\u064F': 'U', '\u0650': 'I', '\u064B': 'A', '\u064C': 'U', '\u064D': 'I' };
const EN_DIG = [['th', 'TH'], ['sh', 'SH'], ['ch', 'CH'], ['ph', 'F'], ['ee', 'I'], ['ea', 'I'], ['oo', 'U'], ['ou', 'O'], ['ow', 'O'], ['ai', 'E'], ['ay', 'E'], ['oa', 'O'], ['ng', 'N'], ['kh', 'KH'], ['gh', 'G'], ['qu', 'K']];
const EN = { a: 'A', e: 'E', i: 'I', o: 'O', u: 'U', b: 'M', p: 'M', m: 'M', f: 'F', v: 'F', s: 'S', z: 'S', c: 'K', k: 'K', q: 'K', g: 'G', j: 'J', x: 'K', r: 'R', l: 'L', n: 'N', d: 'D', t: 'T', w: 'W', y: 'Y', h: 'H' };
const VOWEL = new Set(['A', 'E', 'I', 'O', 'U']);

export function phonemize(text) {
  const s = String(text).replace(/\s+/g, ' ');
  const out = [];
  const push = (v, w, ci, mark) => out.push({ v, w, ci, mark });
  for (let i = 0; i < s.length; i++) {
    const c = s[i], lc = c.toLowerCase();
    if (c === ' ') { push(null, 0.7, i); continue; }
    if (c === '.' ) { push(null, 2.2, i); continue; }
    if (c === ',' || c === '،' || c === ';' || c === '؛' || c === ':') { push(null, 1.5, i); continue; }
    if (c === '?' || c === '؟') { push(null, 2.4, i, '?'); continue; }
    if (c === '!') { push(null, 2.4, i, '!'); continue; }
    if (AR_DIA[c]) { push(AR_DIA[c], 0.9, i); continue; }
    if (c === '\u0651') { if (out.length) out[out.length - 1].w += 0.5; continue; }
    if (c in AR) {
      const v = AR[c];
      push(v, VOWEL.has(v) || AR_LONG.has(c) ? 1.7 : 0.9, i);
      const n = s[i + 1];
      if (v && !VOWEL.has(v) && n && n in AR && !AR_LONG.has(n) && !AR_DIA[n]) push('A', 0.6, i);   // the short vowel that is not written
      continue;
    }
    const two = s.substr(i, 2).toLowerCase(), dg = EN_DIG.find(([k]) => k === two);
    if (dg) { push(dg[1], VOWEL.has(dg[1]) ? 1.7 : 1.0, i); i++; continue; }
    if (lc in EN) { push(EN[lc], VOWEL.has(EN[lc]) ? 1.7 : 0.9, i); continue; }
  }
  return out;
}

/* ---------- the rig ---------- */
export class FaceRig {
  constructor() {
    this.meshes = []; this.idx = new Map(); this.defaults = [];
    this.face = null; this.opts = { ...DEFAULT_OPTS };
    this.visRes = {}; this.roleRes = {};
    this.vis = {}; this.open = 0;
    this.speech = null; this.live = { open: 0, vowel: null }; this.markIdx = -1;
    this.expr = {}; this.pulses = {}; this.manual = {};
    this.eye = { x: 0, y: 0, tx: 0, ty: 0, timer: 1 }; this.eyeHold = null;
    this.blinkT = 0; this.blinkNext = 3; this.sleeping = false; this.listening = false;
    this.microT = 8; this.testVis = null;
  }

  attach(meshes) {
    this.meshes = meshes || []; this.idx = new Map();
    for (const m of this.meshes) for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
      if (!this.idx.has(name)) this.idx.set(name, []);
      this.idx.get(name).push([m, i]);
    }
    this.defaults = this.meshes.map((m) => m.morphTargetInfluences.slice());
    this.setConfig(this.face);
  }
  names() { return [...this.idx.keys()]; }

  setConfig(face) {
    this.face = face || autoFace(this.names());
    this.opts = { ...DEFAULT_OPTS, ...(this.face.options || {}) };
    const res = (list) => (list || []).flatMap(({ n, w }) => (this.idx.get(n) || []).map(([m, i]) => [m, i, w ?? 1]));
    this.visRes = {};
    for (const v of VISEMES) {
      let list = this.face.visemes && this.face.visemes[v];
      if (!(list && list.length)) for (const fb of VIS_FALLBACK[v] || []) if (this.face.visemes && this.face.visemes[fb] && this.face.visemes[fb].length) { list = this.face.visemes[fb]; break; }
      this.visRes[v] = res(list);
    }
    this.roleRes = {};
    for (const [k, list] of Object.entries(this.face.roles || {})) this.roleRes[k] = res(list);
  }

  has(name) { return !!(this.roleRes[name] && this.roleRes[name].length); }
  expression(name, value = 1, hold = 2.5) { const s = (this.expr[name] = this.expr[name] || { cur: 0, target: 0, hold: 0 }); s.target = value; s.hold = hold; }
  pulse(name, v) { this.pulses[name] = Math.max(this.pulses[name] || 0, v); }
  lookAt(x, y, secs = 1.5) { this.eyeHold = { x, y, until: performance.now() / 1000 + secs }; }
  setLive(m) { this.live = m || { open: 0, vowel: null }; }
  testViseme(v, secs = 1.2) { this.testVis = { v, until: performance.now() / 1000 + secs }; }
  stopSpeech() { this.speech = null; }

  // text: what is being said. o: { duration (seconds of real speech), lead, env (loudness 50 per second), estimated, delay }
  speakText(text, o = {}) {
    const items = phonemize(text);
    if (!items.length) return;
    const total = items.reduce((a, x) => a + x.w, 0);
    const dur = o.duration || Math.max(0.4, String(text).length * 0.065);
    let t = 0;
    const track = items.map((it) => { const d = (dur * it.w) / total; const r = { v: it.v, mark: it.mark, ci: it.ci, t0: t, t1: t + d }; t += d; return r; });
    this.speech = { track, start: performance.now() / 1000 + (o.delay || 0), dur, env: o.env || null, lead: o.lead || 0, i: 0, estimated: !!o.estimated };
    this.markIdx = -1;
  }
  seekChar(ci) {
    const s = this.speech;
    if (!s) return;
    const it = s.track.find((x) => x.ci >= ci) || s.track[s.track.length - 1];
    s.start = performance.now() / 1000 - it.t0; s.i = 0;
  }

  // Start of every frame: back to the model's own values (the animation mixer then writes on top).
  reset() {
    for (let k = 0; k < this.meshes.length; k++) {
      const m = this.meshes[k].morphTargetInfluences, d = this.defaults[k];
      for (let i = 0; i < d.length; i++) m[i] = d[i];
    }
  }

  // After the animation mixer: adds speech, blinking, eyes, brows and expressions.
  update(dt) {
    const now = performance.now() / 1000, o = this.opts;
    const add = (m, i, v) => { const k = m.morphTargetInfluences; k[i] = Math.min(1, k[i] + v); };
    const apply = (list, val) => { if (list && val > 0.003) for (const [m, i, w] of list) add(m, i, val * w); };

    // mouth shapes
    const T = {}; let open = 0;
    const sp = this.speech;
    if (this.testVis && now < this.testVis.until) { T[this.testVis.v] = 1; open = OPEN[this.testVis.v] || 0.5; }
    else if (sp && o.lipSync !== 'audio') {
      const t = now - sp.start;
      if (!sp.estimated && t > sp.dur + 0.25) this.speech = null;
      else if (t >= 0) {
        const tr = sp.track;
        let i = sp.i;
        while (i < tr.length - 1 && t >= tr[i].t1) i++;
        sp.i = i;
        const it = tr[i];
        if (it && t < it.t1 + 0.05) {
          if (it.mark && this.markIdx !== i) { this.markIdx = i; if (o.brows) this.pulse('browUp', it.mark === '?' ? 0.8 : 1); }
          let e = 1;
          if (sp.env) { const k = Math.floor((t + sp.lead) * 50); e = Math.min(1, (sp.env[k] ?? 0) * 1.6); }
          if (it.v) { T[it.v] = e; open = (OPEN[it.v] ?? 0.4) * e; }
        }
      }
    } else if (this.live.open > 0.02) { T[LIVE_VOWEL[this.live.vowel] || 'A'] = this.live.open; open = this.live.open * 0.8; }
    for (const v of VISEMES) { const cur = this.vis[v] || 0, tg = T[v] || 0; this.vis[v] = cur + (tg - cur) * Math.min(1, dt * (tg > cur ? 28 : 18)); }
    this.open += (open - this.open) * Math.min(1, dt * 24);
    for (const v of VISEMES) apply(this.visRes[v], this.vis[v] * o.lipGain);
    apply(this.roleRes.jawOpen, this.open * o.jawMorph);

    // blinking
    this.blinkNext -= dt;
    if (o.blink && this.blinkNext <= 0) { this.blinkT = 0.17; this.blinkNext = rand(o.blinkEvery * 0.5, o.blinkEvery * 1.5); if (Math.random() < 0.12) this.blinkNext = 0.3; }
    let b = this.sleeping ? 1 : 0;
    if (this.blinkT > 0) { this.blinkT -= dt; b = Math.max(b, Math.sin((Math.max(0, this.blinkT) / 0.17) * Math.PI)); }
    if (b > 0.003) {
      if (this.roleRes.blink && this.roleRes.blink.length) apply(this.roleRes.blink, b);
      else { apply(this.roleRes.blinkL, b); apply(this.roleRes.blinkR, b); }
    }

    // expressions, brows
    for (const [name, s] of Object.entries(this.expr)) {
      if (s.hold > 0) { s.hold -= dt; if (s.hold <= 0) s.target = 0; }
      s.cur += (s.target - s.cur) * Math.min(1, dt * 7);
      apply(this.roleRes[name], s.cur * o.exprGain);
    }
    for (const k of Object.keys(this.pulses)) { this.pulses[k] *= Math.exp(-dt * 3); if (this.pulses[k] < 0.01) delete this.pulses[k]; }
    let brow = this.pulses.browUp || 0;
    if (this.listening && o.brows) brow = Math.max(brow, 0.25);
    apply(this.roleRes.browUp, brow * o.exprGain);

    // small unplanned expressions so the face is never frozen
    this.microT -= dt;
    if (this.microT <= 0) {
      if (o.micro && !this.speech && !this.listening) { const r = Math.random(); if (r < 0.5) this.expression('smile', 0.18 + Math.random() * 0.15, 1.8); else if (r < 0.8) this.pulse('browUp', 0.45); }
      this.microT = rand(7, 16);
    }

    // eyes: x > 0 looks to the character's left, y > 0 up
    this.eye.timer -= dt;
    if (this.eyeHold && now > this.eyeHold.until) this.eyeHold = null;
    if (this.eye.timer <= 0) {
      const k = Math.random() < 0.25 ? 0.2 : 1;
      this.eye.tx = rand(-0.7, 0.7) * o.eyeAmount * k; this.eye.ty = rand(-0.5, 0.4) * o.eyeAmount * k; this.eye.timer = rand(1.2, 4.2);
    }
    const tx = this.eyeHold ? this.eyeHold.x : o.eyes ? this.eye.tx : 0, ty = this.eyeHold ? this.eyeHold.y : o.eyes ? this.eye.ty : 0;
    const e = Math.min(1, dt * 12);
    this.eye.x += (tx - this.eye.x) * e; this.eye.y += (ty - this.eye.y) * e;
    apply(this.roleRes.lookLeft, Math.max(0, this.eye.x)); apply(this.roleRes.lookRight, Math.max(0, -this.eye.x));
    apply(this.roleRes.lookUp, Math.max(0, this.eye.y)); apply(this.roleRes.lookDown, Math.max(0, -this.eye.y));

    // sliders of the Studio's Face tab (these set the value directly)
    for (const [n, v] of Object.entries(this.manual)) if (v > 0) for (const [m, i] of this.idx.get(n) || []) m.morphTargetInfluences[i] = v;
  }
}
