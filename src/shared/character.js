// The character: loads a GLB, maps its bones to canonical ids, applies the rest pose,
// and runs the motion engine (intents -> clips -> bone rotations).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { autoMap } from './schema.js';
import { builtinClips, sampleClip, INTENTS, EXPRESSIONS } from './clips.js';
import { buildRig } from './rigbuilder.js';

export const TALL = 1.7; // every character is scaled to this height (world units)
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const _e = new THREE.Euler(), _R = new THREE.Quaternion(), _P = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const depthOf = (b) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };
const rand = (a, b) => a + Math.random() * (b - a);

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
    this.pivot.scale.setScalar(TALL / this.unit);

    model.traverse((o) => {
      if (o.isBone) { this.allBones.push(o); this.bindQ.set(o, o.quaternion.clone()); this.bindP.set(o, o.position.clone()); }
      if (o.morphTargetDictionary && o.morphTargetInfluences) this.morphs.push(o);
    });
    this.applyConfig(cfg);
  }

  unload() {
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
    if (this.map.hips) this.map.hips.getWorldPosition(this.hipsRest);
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
          b.parent.updateWorldMatrix(true, false);
          _v.copy(this.hipsRest).add(_v2.set(f.p[0], f.p[1], f.p[2]).multiplyScalar(TALL));
          b.position.copy(b.parent.worldToLocal(_v));
        } else b.position.copy(this.bindP.get(b));
      }
    }
  }

  /* ---------- engine ---------- */
  update(dt) {
    if (!this.model) return;
    this.updateExpr(dt);
    if (this.mode === 'rest') return;
    if (this.mode === 'preview') {
      const p = this.preview;
      if (p && p.clip) this.pose(sampleClip(p.clip, p.t, p.ovr));
      return;
    }
    this.pose(this.engineFrame(dt));
  }

  engineFrame(dt) {
    this.baseT += dt;
    const ov = this.cfg.overrides || {};
    const baseClip = this.clips[this.base];
    const frame = baseClip ? sampleClip(baseClip, this.baseT, ov[this.base]) : new Map();
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
    if (!this.actions.length && this.autoIdle) {
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
    if (intent) {
      const opts = (intent.clips || []).filter((c) => this.clips[c]);
      const fresh = opts.filter((c) => c !== this.lastClip);
      const pool = fresh.length ? fresh : opts;
      clipName = pool[Math.floor(Math.random() * pool.length)] || null;
    } else if (this.clips[name]) clipName = name;
    if (!clipName) return null;
    this.lastClip = clipName;
    for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; }
    const clip = this.clips[clipName];
    this.actions.push({ name: clipName, t: 0, closing: false, closeT: 0, until: clip.loop ? (args.duration ?? 2) : undefined });
    if (intent && intent.expr) this.setExpression(intent.expr, 1, clip.duration);
    this.idleTimer = rand(8, 16);
    return clipName;
  }

  stopActions() { for (const a of this.actions) if (!a.closing) { a.closing = true; a.closeT = 0; } }

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
