// The character: loads a GLB, maps its bones to canonical ids, applies the rest pose,
// and runs the motion engine (intents -> clips -> bone rotations).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { autoMap } from './schema.js';
import { builtinClips, sampleClip, INTENTS, EXPRESSIONS, BASE_VIEW, MOUTH, BLINK } from './clips.js';
import { buildRig } from './rigbuilder.js';
import { buildParts } from './accessories.js';

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
    this.mouth = { open: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }; this.mouthT = { ...this.mouth }; this.mouthWas = false;
    this.faceIdx = {};
    this.acc = new Map(); this.restWorldQ = new Map(); this.accChain = Promise.resolve();
    this.eye = { x: 0, y: 0, tx: 0, ty: 0, timer: 1 };
    this.blinkT = 0; this.blinkNext = 3; this.eyesClosed = false;
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
      if (o.morphTargetDictionary && o.morphTargetInfluences) this.morphs.push(o);
    });
    this.indexMorphs();
    this.applyConfig(cfg);
  }

  indexMorphs() {
    this.faceIdx = {};
    const add = (key, mesh, i) => (this.faceIdx[key] ||= []).push([mesh, i]);
    for (const m of this.morphs) for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
      for (const k of Object.keys(MOUTH)) if (MOUTH[k].test(name)) add(k, m, i);
      if (BLINK.test(name)) add('blink', m, i);
    }
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
    this.model = null; this.box = null; this.allBones = []; this.map = {}; this.order = [];
    this.bindQ.clear(); this.bindP.clear(); this.restQ.clear();
    this.morphs = []; this.expr = {}; this.actions = [];
    this.hasSkeleton = false; this.rigBuilt = false;
    this.pivot.scale.setScalar(1);
    this.baseScale = 1; this.view = { scale: 1, y: 0 }; this.viewT = { scale: 1, y: 0 }; this.pivot.position.y = 0;
    this.base = 'idle'; this.prevBase = null; this.blend = 1; this.faceIdx = {}; this.eyesClosed = false;
  }

  applyConfig(cfg) {
    this.cfg = cfg;
    if (!this.model) return;
    this.pivot.rotation.y = (cfg.modelYaw || 0) * D2R;
    this.clips = { ...builtinClips(), ...(cfg.clips || {}) };
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
    this.updateExpr(dt);
    this.updateFace(dt);
    this.updateView(dt);
    if (this.mode === 'rest') return;
    if (this.mode === 'preview') {
      const p = this.preview;
      if (p && p.clip) { const f = sampleClip(p.clip, p.t, p.ovr); this.finalize(f, false); this.pose(f); }
      return;
    }
    const f = this.engineFrame(dt);
    this.finalize(f, true);
    this.pose(f);
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
    let clipName = null;
    if (intent && intent.base) this.setBase(intent.base);
    if (intent) {
      const opts = (intent.clips || []).filter((c) => this.clips[c]);
      const fresh = opts.filter((c) => c !== this.lastClip);
      const pool = fresh.length ? fresh : opts;
      clipName = pool[Math.floor(Math.random() * pool.length)] || null;
    } else if (this.clips[name]) clipName = name;
    if (!clipName) return intent && intent.base ? intent.base : null;
    this.lastClip = clipName;
    for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; }
    const clip = this.clips[clipName];
    this.actions.push({ name: clipName, t: 0, closing: false, closeT: 0, until: args.hold ? Infinity : clip.loop ? (args.duration ?? 2) : undefined });
    if (intent && intent.expr) this.setExpression(intent.expr, 1, clip.duration);
    this.idleTimer = rand(8, 16);
    return clipName;
  }

  stopActions() { for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; } }

  setBase(name) {
    if (name === this.base || !this.clips[name]) return;
    this.prevBase = this.base; this.prevBaseT = this.baseT;
    this.base = name; this.baseT = 0; this.blend = 0;
    this.viewT = { ...(BASE_VIEW[name] || BASE_VIEW.idle) };
    this.eyesClosed = name === 'sleep_idle';
  }

  /** m = { open: 0..1, vowel?: 'aa'|'ih'|'ou'|'ee'|'oh' } — drives the jaw bone and the mouth shape keys. */
  setMouth(m) {
    for (const k of Object.keys(this.mouthT)) this.mouthT[k] = 0;
    this.mouthT.open = m.open || 0;
    if (m.vowel && m.vowel in this.mouthT) this.mouthT[m.vowel] = m.open || 0;
  }

  updateView(dt) {
    const t = this.mode === 'engine' ? this.viewT : BASE_VIEW.idle;
    const k = Math.min(1, dt * 3);
    this.view.scale += (t.scale - this.view.scale) * k;
    this.view.y += (t.y - this.view.y) * k;
    this.pivot.scale.setScalar(this.baseScale * this.view.scale);
    this.pivot.position.y = this.view.y;
  }

  updateFace(dt) {
    const k = Math.min(1, dt * 20);
    for (const key of Object.keys(this.mouth)) this.mouth[key] += (this.mouthT[key] - this.mouth[key]) * k;
    const active = Object.values(this.mouth).some((v) => v > 0.002);
    if (active || this.mouthWas) {
      for (const key of Object.keys(this.mouth)) for (const [m, i] of this.faceIdx[key] || []) m.morphTargetInfluences[i] = Math.min(1, this.mouth[key]);
    }
    this.mouthWas = active;
    this.blinkNext -= dt;
    if (this.blinkNext <= 0) { this.blinkT = 0.16; this.blinkNext = rand(2.5, 6); }
    let blink = this.eyesClosed ? 1 : 0;
    if (this.blinkT > 0) { this.blinkT -= dt; blink = Math.max(blink, Math.sin((Math.max(0, this.blinkT) / 0.16) * Math.PI)); }
    for (const [m, i] of this.faceIdx.blink || []) m.morphTargetInfluences[i] = blink;
    this.eye.timer -= dt;
    if (this.eye.timer <= 0) { this.eye.tx = rand(-4, 4); this.eye.ty = rand(-6, 6); this.eye.timer = rand(1.2, 4); }
    const e = Math.min(1, dt * 10);
    this.eye.x += (this.eye.tx - this.eye.x) * e; this.eye.y += (this.eye.ty - this.eye.y) * e;
  }

  // Adds the jaw (from the mouth level) and small eye movements on top of the clip frame.
  finalize(frame, engine) {
    const open = this.mouth.open;
    if (open > 0.002 && this.map.jaw) {
      const j = frame.get('jaw');
      frame.set('jaw', { r: [(j ? j.r[0] : 0) + open * 22, j ? j.r[1] : 0, j ? j.r[2] : 0], p: null });
    }
    if (engine && !this.eyesClosed) {
      for (const id of ['leftEye', 'rightEye']) {
        if (!this.map[id]) continue;
        const e = frame.get(id);
        frame.set(id, { r: [(e ? e.r[0] : 0) + this.eye.x, (e ? e.r[1] : 0) + this.eye.y, 0], p: null });
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
  dropAccessory(id, a) {
    this.scene.remove(a.holder);
    a.holder.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) [].concat(o.material).forEach((m) => m.dispose()); });
    this.acc.delete(id);
  }
  clearAccessories() { for (const [id, a] of [...this.acc]) this.dropAccessory(id, a); }

  // Accessories follow their bone's rotation relative to the rest pose, so they stay upright on any rig.
  syncAccessories() {
    if (!this.acc.size) return;
    for (const a of this.acc.values()) {
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

  /* ---------- expressions (morph targets, only if the GLB has them) ---------- */
  setExpression(name, value = 1, hold = 2) {
    const s = this.expr[name] || (this.expr[name] = { cur: 0, target: 0, hold: 0 });
    s.target = value; s.hold = hold;
  }
  updateExpr(dt) {
    for (const [name, s] of Object.entries(this.expr)) {
      if (s.hold > 0) { s.hold -= dt; if (s.hold <= 0) s.target = 0; }
      s.cur += (s.target - s.cur) * Math.min(1, dt * 6);
      const re = EXPRESSIONS[name];
      if (!re) continue;
      for (const m of this.morphs) for (const [key, i] of Object.entries(m.morphTargetDictionary)) if (re.test(key)) m.morphTargetInfluences[i] = s.cur;
    }
  }

  /* ---------- helpers for the studio ---------- */
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
