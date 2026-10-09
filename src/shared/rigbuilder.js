// Builds a simple skeleton for a mesh that has none, and skins the mesh to it.
import * as THREE from 'three';

export const RIG_TEMPLATES = { full: 'Full body', upper: 'Upper body', arms: 'Arms only', head: 'Head and neck', empty: 'Empty' };

/** Joint positions as fractions of the model height (T-pose, facing +Z, left = +X). */
export function makeTemplate(kind, box, yaw = 0) {
  const H = box.max.y - box.min.y;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, y0 = box.min.y;
  const sx = yaw === 180 ? -1 : 1;
  const P = (x, y, z = 0) => [+(cx + sx * x * H).toFixed(4), +(y0 + y * H).toFixed(4), +(cz + z * H).toFixed(4)];
  const B = (name, parent, pos) => ({ name, parent, pos });
  const body = [B('hips', null, P(0, 0.53)), B('spine', 'hips', P(0, 0.6)), B('chest', 'spine', P(0, 0.7)), B('neck', 'chest', P(0, 0.82)), B('head', 'neck', P(0, 0.88))];
  const arm = (s) => { const k = s > 0 ? 'left' : 'right'; return [
    B(k + 'Shoulder', 'chest', P(0.03 * s, 0.8)), B(k + 'UpperArm', k + 'Shoulder', P(0.1 * s, 0.8)),
    B(k + 'LowerArm', k + 'UpperArm', P(0.29 * s, 0.8)), B(k + 'Hand', k + 'LowerArm', P(0.46 * s, 0.8))]; };
  const leg = (s) => { const k = s > 0 ? 'left' : 'right'; return [
    B(k + 'UpperLeg', 'hips', P(0.05 * s, 0.5)), B(k + 'LowerLeg', k + 'UpperLeg', P(0.05 * s, 0.27)), B(k + 'Foot', k + 'LowerLeg', P(0.05 * s, 0.05))]; };
  if (kind === 'full') return [...body, ...arm(1), ...arm(-1), ...leg(1), ...leg(-1)];
  if (kind === 'upper') return [...body, ...arm(1), ...arm(-1)];
  if (kind === 'arms') return [B('chest', null, P(0, 0.7)), ...arm(1), ...arm(-1)];
  if (kind === 'head') return [B('neck', null, P(0, 0.82)), B('head', 'neck', P(0, 0.88))];
  return [];
}

/** Five fingers x 4 bones for one hand, laid out from the wrist (T-pose). dirX is +1 / -1: the way the fingers point along X. */
export function makeFingers(side, wrist, H, dirX) {
  const spec = { Thumb: [0.012, 0.016, 0.02], Index: [0.03, 0.022, 0.012], Middle: [0.032, 0.024, 0.004], Ring: [0.03, 0.022, -0.004], Pinky: [0.026, 0.017, -0.012] };
  const out = [];
  for (const [f, [x0, len, z]] of Object.entries(spec)) {
    let parent = side + 'Hand';
    for (let j = 1; j <= 4; j++) {
      const name = `${side}${f}${j}`;
      const dz = f === 'Thumb' ? 0.006 * (j - 1) : 0, dy = f === 'Thumb' ? 0.003 * H * (j - 1) : 0;
      out.push({ name, parent, pos: [+(wrist[0] + dirX * (x0 + (j - 1) * len) * H).toFixed(4), +(wrist[1] - dy).toFixed(4), +(wrist[2] + (z + dz) * H).toFixed(4)] });
      parent = name;
    }
  }
  return out;
}

/** Eyes and jaw, placed on the head of a model sized by `box`. */
export function makeFace(box, yaw = 0) {
  const H = box.max.y - box.min.y;
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2, y0 = box.min.y;
  const sx = yaw === 180 ? -1 : 1;
  const P = (x, y, z) => [+(cx + sx * x * H).toFixed(4), +(y0 + y * H).toFixed(4), +(cz + z * H).toFixed(4)];
  return [
    { name: 'leftEye', parent: 'head', pos: P(0.018, 0.935, 0.045) },
    { name: 'rightEye', parent: 'head', pos: P(-0.018, 0.935, 0.045) },
    { name: 'jaw', parent: 'head', pos: P(0, 0.905, 0.02) },
  ];
}

function distSeg(x, y, z, s) {
  const abx = s.bx - s.ax, aby = s.by - s.ay, abz = s.bz - s.az;
  const apx = x - s.ax, apy = y - s.ay, apz = z - s.az;
  let t = (apx * abx + apy * aby + apz * abz) / s.len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Capsule-style weights: each bone influences vertices near its segment. Vertices
// far from every bone stay on the static root, so partial rigs (e.g. only arms) work.
function skin(geometry, segs, radius) {
  const pos = geometry.attributes.position, n = pos.count;
  const idx = new Uint16Array(n * 4), wt = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
    let list = [], sum = 0;
    for (const s of segs) {
      const d = distSeg(x, y, z, s);
      if (d < s.rad) { const w = (1 - d / s.rad) ** 2; list.push([s.index, w]); sum += w; }
    }
    const rootW = Math.max(0, 1 - sum);
    if (rootW > 0) list.push([0, rootW]);
    list.sort((a, b) => b[1] - a[1]);
    list = list.slice(0, 4);
    const total = list.reduce((a, e) => a + e[1], 0) || 1;
    for (let i = 0; i < 4; i++) {
      idx[v * 4 + i] = list[i] ? list[i][0] : 0;
      wt[v * 4 + i] = list[i] ? list[i][1] / total : 0;
    }
    if (!list.length) wt[v * 4] = 1;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wt, 4));
}

/** rig = { bones: [{name,parent,pos:[x,y,z]}], radius: fraction of height }. Positions are in model units. */
export function buildRig(model, rig) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const H = box.max.y - box.min.y || 1;
  const radius = (rig.radius ?? 0.12) * H;

  const root = new THREE.Bone();
  root.name = 'root';
  root.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const nodes = new Map([['root', root]]);
  const where = new Map([['root', root.position.clone()]]);

  const pending = [...rig.bones];
  for (let guard = 0; pending.length && guard < 100; guard++) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const d = pending[i], parent = d.parent || 'root';
      if (!nodes.has(parent)) continue;
      const b = new THREE.Bone();
      b.name = d.name;
      const p = new THREE.Vector3(...d.pos);
      b.position.copy(p).sub(where.get(parent));
      nodes.get(parent).add(b);
      nodes.set(d.name, b);
      where.set(d.name, p);
      pending.splice(i, 1);
    }
  }
  const list = [...nodes.values()];
  const segs = [];
  list.forEach((b, index) => {
    if (index === 0) return;
    const a = where.get(b.name);
    const child = list.find((c) => c.parent === b);
    let e;
    if (child) e = where.get(child.name);
    else {
      const pp = where.get(b.parent.name);
      e = a.clone().add(a.clone().sub(pp).multiplyScalar(0.5));
      if (e.distanceTo(a) < 0.02 * H) e.y -= 0.02 * H;
    }
    const len2 = Math.max(1e-8, e.distanceToSquared(a));
    segs.push({ index, ax: a.x, ay: a.y, az: a.z, bx: e.x, by: e.y, bz: e.z, len2, rad: Math.min(radius, Math.max(0.025 * H, Math.sqrt(len2) * 1.6)) });
  });

  const meshes = [];
  model.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) meshes.push(o); });
  model.add(root);
  model.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const skeleton = new THREE.Skeleton(list);
  const skinned = [];
  for (const m of meshes) {
    const g = m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    skin(g, segs, radius);
    const sm = new THREE.SkinnedMesh(g, m.material);
    sm.name = m.name;
    sm.frustumCulled = false;
    m.parent.remove(m);
    model.add(sm);
    skinned.push(sm);
  }
  model.updateMatrixWorld(true);
  for (const sm of skinned) sm.bind(skeleton);
  return skeleton;
}
