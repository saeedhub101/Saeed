// Procedurally generated motions (data, not code) + sampling + the intent table.
//
// Rotation convention (IMPORTANT): every rotation is in *model space*, in degrees,
// applied on top of the rest pose. The character faces +Z, +Y is up, and the
// character's LEFT side is +X. The rest pose is "standing, arms down".
//   x: positive tilts the top forward (nod). For a hanging arm, negative raises it forward.
//   y: positive turns to the character's left.
//   z: positive raises the LEFT arm sideways / tilts head to the right. Negative raises the RIGHT arm.
// If a rig looks wrong, fix it per bone in the studio (Fix motions tab).

const C = (name, duration, loop, tracks) => ({
  name, duration, loop,
  tracks: Object.entries(tracks).map(([bone, ks]) => ({
    bone,
    keys: ks.map((k) => (k.length > 4 ? { t: k[0], r: [k[1], k[2], k[3]], p: k[4] } : { t: k[0], r: [k[1], k[2], k[3]] })),
  })),
});

const BUILTIN = {
  idle: C('idle', 6, true, {
    chest: [[0, 0, 0, 0], [3, 1.5, 0, 0], [6, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [1.5, 0, 1.5, 0], [3, 0, 0, 0], [4.5, 0, -1.5, 0], [6, 0, 0, 0]],
    head: [[0, 0, 0, 0], [2, -1, 2, 0], [4, 1, -2, 0], [6, 0, 0, 0]],
    leftUpperArm: [[0, 0, 0, 0], [3, 0, 0, 1.5], [6, 0, 0, 0]],
    rightUpperArm: [[0, 0, 0, 0], [3, 0, 0, -1.5], [6, 0, 0, 0]],
    hips: [[0, 0, 0, 0, [0, 0, 0]], [3, 0, 0, 0, [0, 0.004, 0]], [6, 0, 0, 0, [0, 0, 0]]],
  }),
  talk: C('talk', 1.6, true, {
    head: [[0, 0, 0, 0], [0.4, 4, 3, 0], [0.8, -1, -3, 1], [1.2, 3, 2, 0], [1.6, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.8, 1.5, 0, 0], [1.6, 0, 0, 0]],
    leftUpperArm: [[0, 0, 0, 0], [0.5, -10, 0, 4], [1.6, 0, 0, 0]],
    leftLowerArm: [[0, 0, 0, 0], [0.5, -28, 0, 0], [1.0, -10, 0, 0], [1.6, 0, 0, 0]],
    rightUpperArm: [[0, 0, 0, 0], [0.5, -8, 0, -4], [1.6, 0, 0, 0]],
    rightLowerArm: [[0, 0, 0, 0], [0.4, -10, 0, 0], [1.1, -30, 0, 0], [1.6, 0, 0, 0]],
  }),
  wave: C('wave', 2.6, false, {
    rightUpperArm: [[0, 0, 0, 0], [0.45, 0, 0, -125], [2.1, 0, 0, -125], [2.6, 0, 0, 0]],
    rightLowerArm: [[0, 0, 0, 0], [0.45, 0, 0, -45], [0.75, 0, 0, -20], [1.05, 0, 0, -70], [1.35, 0, 0, -20], [1.65, 0, 0, -70], [1.95, 0, 0, -25], [2.1, 0, 0, -45], [2.6, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.5, 0, 6, 3], [2.1, 0, 6, 3], [2.6, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.5, 0, 3, 2], [2.1, 0, 3, 2], [2.6, 0, 0, 0]],
  }),
  nod: C('nod', 1.2, false, {
    head: [[0, 0, 0, 0], [0.2, 16, 0, 0], [0.45, 2, 0, 0], [0.7, 14, 0, 0], [1.0, 0, 0, 0], [1.2, 0, 0, 0]],
  }),
  shake: C('shake', 1.2, false, {
    head: [[0, 0, 0, 0], [0.2, 0, 22, 0], [0.5, 0, -22, 0], [0.8, 0, 18, 0], [1.0, 0, -12, 0], [1.2, 0, 0, 0]],
  }),
  cheer: C('cheer', 2.2, false, {
    leftUpperArm: [[0, 0, 0, 0], [0.4, 0, 0, 160], [0.7, 0, 0, 150], [1.0, 0, 0, 165], [1.3, 0, 0, 150], [1.6, 0, 0, 160], [2.2, 0, 0, 0]],
    rightUpperArm: [[0, 0, 0, 0], [0.4, 0, 0, -160], [0.7, 0, 0, -150], [1.0, 0, 0, -165], [1.3, 0, 0, -150], [1.6, 0, 0, -160], [2.2, 0, 0, 0]],
    leftLowerArm: [[0, 0, 0, 0], [0.4, -10, 0, 0], [1.6, -10, 0, 0], [2.2, 0, 0, 0]],
    rightLowerArm: [[0, 0, 0, 0], [0.4, -10, 0, 0], [1.6, -10, 0, 0], [2.2, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.4, -6, 0, 0], [1.6, -6, 0, 0], [2.2, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.4, -10, 0, 0], [1.6, -10, 0, 0], [2.2, 0, 0, 0]],
    hips: [[0, 0, 0, 0, [0, 0, 0]], [0.3, 0, 0, 0, [0, 0.025, 0]], [0.6, 0, 0, 0, [0, 0, 0]], [0.9, 0, 0, 0, [0, 0.025, 0]],
      [1.2, 0, 0, 0, [0, 0, 0]], [1.5, 0, 0, 0, [0, 0.025, 0]], [1.8, 0, 0, 0, [0, 0, 0]], [2.2, 0, 0, 0, [0, 0, 0]]],
  }),
  bow: C('bow', 2.4, false, {
    spine: [[0, 0, 0, 0], [0.8, 20, 0, 0], [1.5, 20, 0, 0], [2.4, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.8, 15, 0, 0], [1.5, 15, 0, 0], [2.4, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.8, 10, 0, 0], [1.5, 10, 0, 0], [2.4, 0, 0, 0]],
  }),
  think: C('think', 3.2, false, {
    rightUpperArm: [[0, 0, 0, 0], [0.6, -50, 0, -8], [2.6, -50, 0, -8], [3.2, 0, 0, 0]],
    rightLowerArm: [[0, 0, 0, 0], [0.6, -105, 0, 0], [2.6, -105, 0, 0], [3.2, 0, 0, 0]],
    head: [[0, 0, 0, 0], [0.6, 5, 12, -6], [1.6, 3, 18, -6], [2.6, 5, 12, -6], [3.2, 0, 0, 0]],
  }),
  sad: C('sad', 3.6, false, {
    head: [[0, 0, 0, 0], [0.8, 18, 0, 0], [2.8, 18, 0, 0], [3.6, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.8, 10, 0, 0], [2.8, 10, 0, 0], [3.6, 0, 0, 0]],
    chest: [[0, 0, 0, 0], [0.8, 8, 0, 0], [2.8, 8, 0, 0], [3.6, 0, 0, 0]],
  }),
  idle_look: C('idle_look', 3.4, false, {
    head: [[0, 0, 0, 0], [0.7, 0, 32, 0], [1.4, 0, 32, 0], [2.3, 0, -28, 0], [2.9, 0, -28, 0], [3.4, 0, 0, 0]],
    spine: [[0, 0, 0, 0], [0.7, 0, 8, 0], [1.4, 0, 8, 0], [2.3, 0, -7, 0], [2.9, 0, -7, 0], [3.4, 0, 0, 0]],
  }),
};

export const builtinClips = () => BUILTIN; // never mutate: copy with structuredClone first

// An intent is what the brain sends ("happy"). The engine picks the clip by itself.
export const INTENTS = {
  happy: { clips: ['cheer', 'wave'], expr: 'smile' },
  greet: { clips: ['wave', 'bow'] },
  hello: { clips: ['wave'] },
  yes: { clips: ['nod'] },
  no: { clips: ['shake'] },
  think: { clips: ['think'] },
  sad: { clips: ['sad'], expr: 'sad' },
  thanks: { clips: ['bow'] },
  bow: { clips: ['bow'] },
  talk: { clips: ['talk'] },
  look: { clips: ['idle_look'] },
};

// Face morph targets are matched by name (only if the GLB has them).
export const EXPRESSIONS = {
  smile: /smile|happy|joy/i,
  sad: /sad|frown|sorrow/i,
  surprised: /surpris|shock/i,
};

const lerp = (a, b, u) => a + (b - a) * u;

export function sampleTrack(tr, t, loop, dur) {
  const k = tr.keys;
  if (!k.length) return null;
  if (loop && dur > 0) t = ((t % dur) + dur) % dur;
  const copy = (key) => ({ r: key.r.slice(), p: key.p ? key.p.slice() : null });
  if (t <= k[0].t) return copy(k[0]);
  const last = k[k.length - 1];
  if (t >= last.t) return copy(last);
  let i = 0;
  while (k[i + 1].t <= t) i++;
  const a = k[i], b = k[i + 1];
  let u = (t - a.t) / (b.t - a.t);
  u = u * u * (3 - 2 * u);
  const r = [0, 1, 2].map((j) => lerp(a.r[j], b.r[j], u));
  const p = a.p || b.p ? [0, 1, 2].map((j) => lerp((a.p || [0, 0, 0])[j], (b.p || [0, 0, 0])[j], u)) : null;
  return { r, p };
}

// Axis fix for one bone of one clip: out[i] = sign[i] * in[swz[i]] * scale + offset[i]
export function applyOverride(r, o) {
  if (!o) return r;
  const s = o.swz || [0, 1, 2], g = o.sign || [1, 1, 1], k = o.scale ?? 1, off = o.offset || [0, 0, 0];
  return [0, 1, 2].map((i) => g[i] * r[s[i]] * k + off[i]);
}

export function sampleClip(clip, t, ovr) {
  const out = new Map();
  for (const tr of clip.tracks) {
    const s = sampleTrack(tr, t, clip.loop, clip.duration);
    if (!s) continue;
    s.r = applyOverride(s.r, ovr && ovr[tr.bone]);
    out.set(tr.bone, s);
  }
  return out;
}
