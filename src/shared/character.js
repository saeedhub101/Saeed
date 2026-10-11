// The character: loads a GLB, maps its bones to canonical ids, applies the rest pose,
// and runs the motion engine (intents -> clips -> bone rotations).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { autoMap } from './schema.js';
import { builtinClips, sampleClip, INTENTS, EXPRESSIONS, BASE_VIEW, MOUTH, BLINK } from './clips.js';
import { buildRig } from './rigbuilder.js';
import { buildParts } from './accessories.js';
import { FaceRig } from './face.js';

export const TALL = 1.7; // every character is scaled to this height (world units)
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const _e = new THREE.Euler(), _R = new THREE.Quaternion(), _P = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const depthOf = (b) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };
const rand = (a, b) => a + Math.random() * (b - a);
const await_buf = (b) => (b instanceof ArrayBuffer ? b : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

function blendFrames(a, b, w) {
  const out = new Map();
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k), y = b.get(k);
    const r = [0, 1, 2].map((i) => (x ? x.r[i] : 0) * (1 - w) + (y ? y.r[i] : 0) * w);
    const p = (x && x.p) || (y && y.p)
      ? [0, 1, 2].map((i) => (x && x.p ? x.p[i] : 0) * (1 - w) + (y && y.p ? y.p[i] : 0) * w) : null;
    out.set(k, { r, p });
  }
  return out;
}

export class Character {
  constructor(scene) {
    this.scene = scene;
    this.pivot = new THREE.Group();
    scene.add(this.pivot);
    this.cfg = null;
    this.model = null;
    this.box = null;
    this.unit = 1;
    this.allBones = [];
    this.map = {};          // canonical id -> Bone
    this.order = [];        // [{id,b}] parents first
    this.bindQ = new Map(); this.bindP = new Map(); this.restQ = new Map();
    this.hipsRest = new THREE.Vector3();
    this.clips = { ...builtinClips() };
    this.mode = 'engine';   // 'engine' | 'rest' | 'preview'
    this.preview = null;    // { clip, t, ovr }
    this.base = 'idle'; this.baseT = 0;
    this.actions = []; this.lastClip = null;
    this.autoIdle = true; this.idleTimer = rand(6, 12);
    this.morphs = []; this.expr = {};
    this.helper = null;
    this.baseScale = 1; this.view = { scale: 1, y: 0 }; this.viewT = { scale: 1, y: 0 };
    this.prevBase = null; this.prevBaseT = 0; this.blend = 1;
    this.face = new FaceRig();
    this.mixer = null; this.glbAnims = {}; this.glbCfg = {}; this.glbActive = new Set(); this.glbHeld = new Set(); this.glbCache = {}; this.glbAsIntent = {}; this.glbTogether = {};
    this.acc = new Map(); this.restWorldQ = new Map(); this.accChain = Promise.resolve();
    this.hiddenByOutfit = {}; this.cfgHidden = new Set(); this.baseMeshes = [];
    this.eyesClosed = false;
    this.hasSkeleton = false; this.rigBuilt = false;
  }

  /* ---------- loading ---------- */
  async load(buffer, cfg) {
    this.unload();
    this.cfg = cfg;
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buffer, '', res, rej));
    const model = gltf.scene;
    this.model = model;
    this.pivot.add(model);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    this.box = box.clone();

    model.traverse((o) => { if (o.isSkinnedMesh) this.hasSkeleton = true; o.frustumCulled = false; });
    if (!this.hasSkeleton && cfg.customRig && cfg.customRig.bones && cfg.customRig.bones.length) {
      buildRig(model, cfg.customRig);
      this.hasSkeleton = true; this.rigBuilt = true;
    }

    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    this.unit = size.y || 1;
    model.position.set(-c.x, -box.min.y, -c.z);
    this.baseScale = TALL / this.unit;
    this.pivot.scale.setScalar(this.baseScale);

    model.traverse((o) => {
      if (o.isBone) { this.allBones.push(o); this.bindQ.set(o, o.quaternion.clone()); this.bindP.set(o, o.position.clone()); }
      if (o.isMesh) this.baseMeshes.push(o);
      if (o.morphTargetDictionary && o.morphTargetInfluences) this.morphs.push(o);
    });
    this.face.attach(this.morphs);
    this.glbAnims = {};
    for (const c of gltf.animations || []) this.glbAnims[c.name || `clip${Object.keys(this.glbAnims).length + 1}`] = c;
    this.mixer = Object.keys(this.glbAnims).length ? new THREE.AnimationMixer(model) : null;
    this.applyConfig(cfg);
  }

  unload() {
    this.clearAccessories();
    this.showSkeleton(false);
    if (this.model) {
      this.pivot.remove(this.model);
      this.model.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        const mats = o.material ? [].concat(o.material) : [];
        for (const m of mats) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); }
      });
    }
    if (this.mixer && this.model) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); }
    this.mixer = null; this.glbAnims = {}; this.glbActive.clear(); this.glbHeld.clear(); this.glbCache = {};
    this.face.attach([]);
    this.model = null; this.box = null; this.allBones = []; this.map = {}; this.order = [];
    this.bindQ.clear(); this.bindP.clear(); this.restQ.clear();
    this.morphs = []; this.expr = {}; this.actions = [];
    this.hasSkeleton = false; this.rigBuilt = false; this.baseMeshes = []; this.hiddenByOutfit = {};
    this.pivot.scale.setScalar(1);
    this.baseScale = 1; this.view = { scale: 1, y: 0 }; this.viewT = { scale: 1, y: 0 }; this.pivot.position.y = 0;
    this.base = 'idle'; this.prevBase = null; this.blend = 1; this.eyesClosed = false;
  }

  applyConfig(cfg) {
    this.cfg = cfg;
    if (!this.model) return;
    this.pivot.rotation.y = (cfg.modelYaw || 0) * D2R;
    this.cfgHidden = new Set(cfg.hiddenMeshes || []);
    this.applyHidden();
    this.clips = { ...builtinClips(), ...(cfg.clips || {}) };
    this.face.setConfig(cfg.face);
    this.glbCfg = cfg.glbClips || {}; this.glbCache = {}; this.glbAsIntent = {}; this.glbTogether = {};
    for (const [n, g] of Object.entries(this.glbCfg)) {
      if (!g.enabled || !this.glbAnims[n]) continue;
      for (const i of g.asIntent || []) (this.glbAsIntent[i] = this.glbAsIntent[i] || []).push(n);
      for (const i of g.together || []) (this.glbTogether[i] = this.glbTogether[i] || []).push(n);
    }
    const names = Object.keys(cfg.boneMap || {}).length ? cfg.boneMap : autoMap(this.allBones);
    const byName = new Map();
    for (const b of this.allBones) if (!byName.has(b.name)) byName.set(b.name, b);
    this.map = {};
    for (const [id, name] of Object.entries(names)) if (byName.has(name)) this.map[id] = byName.get(name);
    this.order = Object.entries(this.map).map(([id, b]) => ({ id, b, d: depthOf(b) })).sort((a, b) => a.d - b.d);
    this.applyRestPose();
  }

  /* ---------- pose math ---------- */
  // Rotates `b` by `deg` (Euler XYZ, model space), on top of `base` (its local rotation).
  // local = parentWorld^-1 * R * parentWorld * base   =>  world = R * parentWorld * base
  rotateIn(b, deg, base) {
    _e.set(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R, 'XYZ');
    _R.setFromEuler(_e);
    b.parent.getWorldQuaternion(_P);
    b.quaternion.copy(_P).invert().multiply(_R).multiply(_P).multiply(base);
  }

  applyRestPose() {
    if (!this.model) return;
    for (const b of this.allBones) { b.quaternion.copy(this.bindQ.get(b)); b.position.copy(this.bindP.get(b)); }
    const rp = this.cfg.restPose || {};
    for (const { id, b } of this.order) {
      const r = rp[id];
      if (r && (r[0] || r[1] || r[2])) this.rotateIn(b, r, this.bindQ.get(b));
    }
    for (const { b } of this.order) this.restQ.set(b, b.quaternion.clone());
    this.model.updateMatrixWorld(true);
    for (const { b } of this.order) this.restWorldQ.set(b, b.getWorldQuaternion(new THREE.Quaternion()));
    if (this.map.hips) { this.map.hips.getWorldPosition(this.hipsRest); this.pivot.worldToLocal(this.hipsRest); }
  }

  /** Points the arms down using the real bone directions (fixes T-pose rigs). Edits cfg.restPose. */
  autoArmsDown() {
    const rp = (this.cfg.restPose = this.cfg.restPose || {});
    for (const side of ['left', 'right']) {
      const s = side === 'left' ? 1 : -1;
      const steps = [[side + 'UpperArm', side + 'LowerArm', [0.1 * s, -1, 0]], [side + 'LowerArm', side + 'Hand', [0.06 * s, -1, 0.08]]];
      for (const [id, childId, target] of steps) {
        const b = this.map[id], c = this.map[childId];
        if (!b || !c) continue;
        rp[id] = [0, 0, 0];
        this.applyRestPose();
        b.getWorldPosition(_v);
        c.getWorldPosition(_v2).sub(_v).normalize();
        _q.setFromUnitVectors(_v2, new THREE.Vector3(...target).normalize());
        _e.setFromQuaternion(_q, 'XYZ');
        rp[id] = [+(_e.x * R2D).toFixed(2), +(_e.y * R2D).toFixed(2), +(_e.z * R2D).toFixed(2)];
        this.applyRestPose();
      }
    }
  }

  /** Warns when "left" is not on the character's left (+X when facing +Z). */
  checkSides() {
    const l = this.map.leftUpperArm, r = this.map.rightUpperArm;
    if (!l || !r) return null;
    this.model.updateMatrixWorld(true);
    return l.getWorldPosition(_v).x < r.getWorldPosition(_v2).x
      ? 'Left looks like it is on the right. Use "Swap left / right", or change which way the model faces.' : null;
  }

  pose(frame) {
    for (const { id, b } of this.order) {
      const f = frame.get(id);
      const base = this.restQ.get(b);
      if (f) this.rotateIn(b, f.r, base); else b.quaternion.copy(base);
      if (id === 'hips') {
        if (f && f.p) {
          _v.copy(this.hipsRest).add(_v2.set(f.p[0], f.p[1], f.p[2]).multiplyScalar(this.unit));
          this.pivot.updateWorldMatrix(true, false);
          this.pivot.localToWorld(_v);
          b.parent.updateWorldMatrix(true, false);
          b.position.copy(b.parent.worldToLocal(_v));
        } else b.position.copy(this.bindP.get(b));
      }
    }
  }

  /* ---------- engine ---------- */
  update(dt) {
    this.updateCore(dt);
    this.syncAccessories();
  }

  updateCore(dt) {
    if (!this.model) return;
    this.updateView(dt);
    this.face.reset();                              // shape keys back to the model's values
    if (this.mode === 'preview') {
      const p = this.preview;
      if (p && p.clip) { const f = sampleClip(p.clip, p.t, p.ovr); this.finalize(f, false); this.pose(f); }
    } else if (this.mode === 'engine') {
      const f = this.engineFrame(dt);
      this.finalize(f, true);
      this.pose(f);
    }
    if (this.mixer && this.glbActive.size) this.tickGlb(dt);   // animations from the GLB file
    this.face.update(dt);                           // speech, blinking, eyes, brows, expressions on top
  }

  engineFrame(dt) {
    this.baseT += dt;
    const ov = this.cfg.overrides || {};
    const baseClip = this.clips[this.base];
    let frame = baseClip ? sampleClip(baseClip, this.baseT, ov[this.base]) : new Map();
    if (this.prevBase && this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / 0.9);
      this.prevBaseT += dt;
      const pc = this.clips[this.prevBase];
      const old = pc ? sampleClip(pc, this.prevBaseT, ov[this.prevBase]) : new Map();
      frame = blendFrames(old, frame, this.blend * this.blend * (3 - 2 * this.blend));
      if (this.blend >= 1) this.prevBase = null;
    }
    const FADE_IN = 0.25, FADE_OUT = 0.3;
    for (const a of this.actions) {
      const clip = this.clips[a.name];
      a.t += dt;
      if (!clip) { a.dead = true; continue; }
      const end = a.until ?? clip.duration;
      if (!a.closing && a.t >= end - FADE_OUT) { a.closing = true; a.closeT = 0; }
      let w = Math.min(1, a.t / FADE_IN);
      if (a.closing) { a.closeT += dt; w *= Math.max(0, 1 - a.closeT / FADE_OUT); if (a.closeT >= FADE_OUT) a.dead = true; }
      const s = sampleClip(clip, a.t, ov[a.name]);
      for (const [bone, v] of s) {
        const cur = frame.get(bone);
        if (!cur) frame.set(bone, { r: v.r.map((x) => x * w), p: v.p ? v.p.map((x) => x * w) : null });
        else {
          cur.r = cur.r.map((x, i) => x + (v.r[i] - x) * w);
          if (cur.p || v.p) cur.p = (cur.p || [0, 0, 0]).map((x, i) => x + ((v.p || [0, 0, 0])[i] - x) * w);
        }
      }
    }
    this.actions = this.actions.filter((a) => !a.dead);
    if (!this.actions.length && this.autoIdle && this.base === 'idle') {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) { this.command('look'); this.idleTimer = rand(8, 16); }
    }
    return frame;
  }

  /** The brain sends an intent ("happy"); the engine decides what to do. Returns the chosen clip name. */
  command(name, args = {}) {
    if (!this.model) return null;
    const intent = { ...INTENTS, ...(this.cfg.intents || {}) }[name];
    if (intent && intent.base) this.setBase(intent.base);
    let clipName = null, glbName = null;
    if (intent) {
      const own = (intent.clips || []).filter((c) => this.clips[c]);
      const glb = this.glbAsIntent[name] || [];
      const opts = [...own, ...glb];
      const fresh = opts.filter((c) => c !== this.lastClip);
      const pool = fresh.length ? fresh : opts;
      const pick = pool[Math.floor(Math.random() * pool.length)] || null;
      if (pick && glb.includes(pick) && !own.includes(pick)) glbName = pick; else clipName = pick;
    } else if (this.clips[name]) clipName = name;
    else if (this.face.has(name)) { this.face.expression(name, 1, args.duration ?? 2.5); return name; }
    else if (this.glbAnims[name] && (this.glbCfg[name] || {}).enabled) { this.playGlb(name, { hold: !!args.hold }); return name; }
    if (intent && intent.expr) {
      const ex = Array.isArray(intent.expr) ? intent.expr[Math.floor(Math.random() * intent.expr.length)] : intent.expr;
      this.face.expression(ex, 1, intent.hold ?? 2.5);
    }
    for (const g of this.glbTogether[name] || []) this.playGlb(g);
    if (glbName) { this.lastClip = glbName; this.playGlb(glbName, { hold: !!args.hold }); this.idleTimer = rand(8, 16); return glbName; }
    if (!clipName) return intent && (intent.base || intent.expr || (this.glbTogether[name] || []).length) ? name : null;
    this.lastClip = clipName;
    for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; }
    const clip = this.clips[clipName];
    this.actions.push({ name: clipName, t: 0, closing: false, closeT: 0, until: args.hold ? Infinity : clip.loop ? (args.duration ?? 2) : undefined });
    this.idleTimer = rand(8, 16);
    return clipName;
  }

  stopActions() { this.stopGlb(); for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; } }

  setBase(name) {
    if (name === this.base || !this.clips[name]) return;
    this.prevBase = this.base; this.prevBaseT = this.baseT;
    this.base = name; this.baseT = 0; this.blend = 0;
    this.viewT = { ...(BASE_VIEW[name] || BASE_VIEW.idle) };
    this.eyesClosed = this.face.sleeping = name === 'sleep_idle';
  }

  /** m = { open: 0..1, vowel?: 'aa'|'ih'|'ou'|'ee'|'oh' }: loudness-based mouth movement used when no text is known. */
  setMouth(m) { this.face.setLive(m); }

  updateView(dt) {
    const t = this.mode === 'engine' ? this.viewT : BASE_VIEW.idle;
    const k = Math.min(1, dt * 3);
    this.view.scale += (t.scale - this.view.scale) * k;
    this.view.y += (t.y - this.view.y) * k;
    this.pivot.scale.setScalar(this.baseScale * this.view.scale);
    this.pivot.position.y = this.view.y;
  }

  // Adds the jaw (from the mouth level) and small eye movements on top of the clip frame.
  finalize(frame, engine) {
    const f = this.face, open = f.open * f.opts.jawBone;
    if (open > 0.002 && this.map.jaw) {
      const j = frame.get('jaw');
      frame.set('jaw', { r: [(j ? j.r[0] : 0) + open * 22, j ? j.r[1] : 0, j ? j.r[2] : 0], p: null });
    }
    if (engine && !f.sleeping && f.opts.eyes) {
      for (const id of ['leftEye', 'rightEye']) {
        if (!this.map[id]) continue;
        const e = frame.get(id);
        frame.set(id, { r: [(e ? e.r[0] : 0) - f.eye.y * 5, (e ? e.r[1] : 0) + f.eye.x * 8, 0], p: null });
      }
    }
  }

  /* ---------- accessories ---------- */
  // defs: [{ id, bone, parts | file, offset, rotation, scale }], state: { id: { on, offset, rot, scale } }
  setAccessories(defs, state, loadFile) {
    this.accChain = this.accChain.then(() => this._setAccessories(defs, state || {}, loadFile)).catch((e) => console.error(e));
    return this.accChain;
  }
  async _setAccessories(defs, state, loadFile) {
    const want = new Set();
    for (const d of defs) {
      const st = state[d.id];
      if (!st || !st.on) continue;
      want.add(d.id);
      if (d.type === 'outfit') {                 // clothes that share the character's skeleton
        if (!this.acc.get(d.id)) {
          const o = { outfit: true, meshes: [] };
          this.acc.set(d.id, o);
          try { o.meshes = await this._addOutfit(d, loadFile); } catch (e) { console.error(e); }
          this.hiddenByOutfit[d.id] = d.hide || [];
          this.applyHidden();
        }
        continue;
      }
      let a = this.acc.get(d.id);
      if (!a) {
        const holder = new THREE.Group(), inner = new THREE.Group();
        holder.add(inner); this.scene.add(holder);
        a = { holder, inner, bone: d.bone || 'head' };
        this.acc.set(d.id, a);
        if (d.file && loadFile) {
          try {
            const buf = await_buf(await loadFile(d));
            const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
            inner.add(gltf.scene);
          } catch (e) { console.error(e); }
        } else inner.add(buildParts(d));
      }
      a.bone = d.bone || 'head';
      const off = st.offset || d.offset || [0, 0, 0], rot = st.rot || d.rotation || [0, 0, 0];
      a.inner.position.set(off[0], off[1], off[2]);
      a.inner.rotation.set(rot[0] * D2R, rot[1] * D2R, rot[2] * D2R);
      a.inner.scale.setScalar(st.scale ?? d.scale ?? 1);
    }
    for (const [id, a] of [...this.acc]) if (!want.has(id)) this.dropAccessory(id, a);
  }
  // The outfit file must be made for the same skeleton (same bone names / same rest pose), for example exported from the same Blender file.
  async _addOutfit(d, loadFile) {
    const buf = await_buf(await loadFile(d));
    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(buf, '', res, rej));
    gltf.scene.updateMatrixWorld(true);
    const byName = new Map();
    for (const b of this.allBones) if (!byName.has(b.name)) byName.set(b.name, b);
    const out = [];
    gltf.scene.traverse((o) => {
      if (!o.isSkinnedMesh || !this.model) return;
      const src = o.skeleton;
      const canon = {};
      for (const [id, name] of Object.entries(autoMap(src.bones))) canon[name] = id;
      const pick = (ob) => byName.get(ob.name) || (canon[ob.name] && this.map[canon[ob.name]]) || null;
      const bones = src.bones.map((ob) => {
        let b = pick(ob);
        for (let p = ob.parent; !b && p; p = p.parent) b = pick(p);
        return b || this.map.hips || this.allBones[0];
      });
      const sm = new THREE.SkinnedMesh(o.geometry, o.material);
      sm.name = o.name; sm.frustumCulled = false;
      o.matrixWorld.decompose(sm.position, sm.quaternion, sm.scale);
      this.model.add(sm);
      sm.updateMatrixWorld(true);
      sm.bind(new THREE.Skeleton(bones, src.boneInverses.map((m) => m.clone())), o.bindMatrix.clone());
      out.push(sm);
    });
    return out;
  }

  // Meshes hidden by the user (Studio -> Accessories) or replaced by an outfit.
  applyHidden() {
    const hide = new Set(this.cfgHidden);
    for (const list of Object.values(this.hiddenByOutfit)) for (const n of list) hide.add(n);
    for (const m of this.baseMeshes) m.visible = !hide.has(m.name);
  }

  dropAccessory(id, a) {
    if (a.outfit) {
      for (const m of a.meshes) { if (this.model) this.model.remove(m); m.geometry.dispose(); [].concat(m.material).forEach((x) => x.dispose()); }
      delete this.hiddenByOutfit[id]; this.acc.delete(id); this.applyHidden();
      return;
    }
    this.scene.remove(a.holder);
    a.holder.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
    this.acc.delete(id);
  }
  clearAccessories() { for (const [id, a] of [...this.acc]) this.dropAccessory(id, a); }

  // Accessories follow their bone's rotation relative to the rest pose, so they stay upright on any rig.
  syncAccessories() {
    if (!this.acc.size) return;
    for (const a of this.acc.values()) {
      if (a.outfit) continue;
      const b = this.map[a.bone];
      if (!b || !this.model) { a.holder.visible = false; continue; }
      a.holder.visible = true;
      b.getWorldPosition(a.holder.position);
      b.getWorldQuaternion(_q);
      const r = this.restWorldQ.get(b);
      if (r) _q.multiply(_P.copy(r).invert());
      a.holder.quaternion.copy(_q);
      a.holder.scale.setScalar(this.view.scale);
    }
  }

  setExpression(name, value = 1, hold = 2) { this.face.expression(name, value, hold); }

  /* ---------- animations that come inside the GLB file ---------- */
  // target: 'morphs' keeps only the face (shape key) tracks, 'bones' only the body tracks, 'all' everything.
  glbClipFor(name) {
    const base = this.glbAnims[name];
    if (!base) return null;
    const target = (this.glbCfg[name] || {}).target || 'morphs';
    const key = `${name}|${target}`;
    if (!this.glbCache[key]) {
      const isMorph = (t) => /morphTargetInfluences/.test(t.name);
      const tracks = base.tracks.filter((t) => target === 'all' || (target === 'morphs' ? isMorph(t) : !isMorph(t)));
      this.glbCache[key] = new THREE.AnimationClip(name, base.duration, tracks);
    }
    return this.glbCache[key];
  }
  playGlb(name, { hold = false } = {}) {
    if (!this.mixer) return false;
    const clip = this.glbClipFor(name);
    if (!clip || !clip.tracks.length) return false;
    const cfg = this.glbCfg[name] || {};
    const act = this.mixer.clipAction(clip);
    const loop = hold || !!cfg.loop;
    act.reset(); act._fading = false;
    act.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    act.clampWhenFinished = true; act.timeScale = cfg.speed || 1; act.enabled = true;
    act.fadeIn(0.2).play();
    this.glbActive.add(act);
    if (hold) this.glbHeld.add(act);
    if (!loop) {
      const done = (e) => { if (e.action !== act) return; this.mixer.removeEventListener('finished', done); act.fadeOut(0.3); act._fading = true; };
      this.mixer.addEventListener('finished', done);
    }
    return true;
  }
  stopGlb(all = false) {
    for (const a of this.glbHeld) { a.fadeOut(0.25); a._fading = true; }
    this.glbHeld.clear();
    if (all) for (const a of this.glbActive) { a.fadeOut(0.25); a._fading = true; }
  }
  tickGlb(dt) {
    this.mixer.update(dt);
    for (const a of [...this.glbActive]) if (a._fading && a.getEffectiveWeight() < 0.001) { a.stop(); this.glbActive.delete(a); }
  }
  /** The shape-key values of a GLB clip at time t (default: the moment with the most movement). Used to make poses from animations. */
  glbMorphPose(name, t) {
    const base = this.glbAnims[name];
    if (!base) return [];
    const tracks = base.tracks.filter((x) => /morphTargetInfluences/.test(x.name));
    if (!tracks.length) return [];
    const mesh = (tr) => this.morphs.find((m) => tr.name.startsWith(m.name + '.'));
    const sample = (tt) => {
      const acc = new Map();
      for (const tr of tracks) {
        const m = mesh(tr);
        if (!m) continue;
        const n = Object.keys(m.morphTargetDictionary).length, vals = tr.createInterpolant().evaluate(tt);
        for (const [name2, i] of Object.entries(m.morphTargetDictionary)) acc.set(name2, Math.max(acc.get(name2) || 0, Math.abs(vals[i] ?? 0)));
        void n;
      }
      return acc;
    };
    let best = t, bestSum = -1;
    if (t == null) for (let k = 0; k <= 40; k++) { const tt = (base.duration * k) / 40; let s = 0; for (const v of sample(tt).values()) s += v; if (s > bestSum) { bestSum = s; best = tt; } }
    return [...sample(best).entries()].filter(([, v]) => v > 0.02).map(([n, w]) => ({ n, w: +Math.min(1, w).toFixed(2) }));
  }

  /* ---------- helpers for the studio */
  showSkeleton(on) {
    if (this.helper) { this.scene.remove(this.helper); this.helper.dispose?.(); this.helper = null; }
    if (on && this.model && this.allBones.length) {
      this.helper = new THREE.SkeletonHelper(this.model);
      this.helper.material.depthTest = false;
      this.helper.renderOrder = 998;
      this.scene.add(this.helper);
    }
  }

  /** Exports the character (at its bind pose) as a GLB ArrayBuffer. */
  async exportGLB() {
    for (const b of this.allBones) { b.quaternion.copy(this.bindQ.get(b)); b.position.copy(this.bindP.get(b)); }
    this.model.updateMatrixWorld(true);
    const buf = await new GLTFExporter().parseAsync(this.model, { binary: true });
    this.applyRestPose();
    return buf;
  }
}
