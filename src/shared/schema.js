// Canonical bone ids used by the motion engine, and auto-detection of
// bone names from common rigs (Mixamo, VRM, Rigify, Unreal, Biped...).

const cap = (s) => s[0].toUpperCase() + s.slice(1);
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

const BODY = [
  ['hips', 'Hips'], ['spine', 'Spine'], ['chest', 'Chest'], ['neck', 'Neck'], ['head', 'Head'],
  ['leftShoulder', 'Left shoulder'], ['leftUpperArm', 'Left upper arm'], ['leftLowerArm', 'Left forearm'], ['leftHand', 'Left hand'],
  ['rightShoulder', 'Right shoulder'], ['rightUpperArm', 'Right upper arm'], ['rightLowerArm', 'Right forearm'], ['rightHand', 'Right hand'],
  ['leftUpperLeg', 'Left thigh'], ['leftLowerLeg', 'Left shin'], ['leftFoot', 'Left foot'],
  ['rightUpperLeg', 'Right thigh'], ['rightLowerLeg', 'Right shin'], ['rightFoot', 'Right foot'],
].map(([id, label]) => ({ id, label, group: 'body' }));
const FACE = [['leftEye', 'Left eye'], ['rightEye', 'Right eye'], ['jaw', 'Jaw']].map(([id, label]) => ({ id, label, group: 'face' }));
const fingers = (side) => FINGERS.flatMap((f) => [1, 2, 3, 4].map((i) => ({
  id: `${side}${f}${i}`, label: `${cap(side)} ${f.toLowerCase()} ${i}`, group: side + 'Fingers',
})));

export const BONES = [...BODY, ...FACE, ...fingers('left'), ...fingers('right')];
export const GROUPS = [
  ['body', 'Body'], ['face', 'Face (eyes, jaw)'], ['leftFingers', 'Left hand fingers'], ['rightFingers', 'Right hand fingers'],
];
export const groupOf = (id) => BONES.find((b) => b.id === id)?.group || 'body';

const JUNK = ['mixamorig', 'jbip', 'bip01', 'bip', 'armature', 'def', 'org', 'mch', 'cc'];
const PARTS = {
  hips: /^(hips?|pelvis)$/,
  neck: /^neck\d*$/,
  head: /^head$/,
  jaw: /^(jaw|chin)$/,
  shoulder: /^(shoulder|clavicle|collar)\d*$/,
  upperarm: /^(upperarm|arm)\d*$/,
  lowerarm: /^(forearm|lowerarm)\d*$/,
  hand: /^(hand|wrist)$/,
  upperleg: /^(upleg|upperleg|thigh)\d*$/,
  lowerleg: /^(leg|lowerleg|calf|shin)\d*$/,
  foot: /^(foot|ankle)$/,
  eye: /^(eye|eyeball)$/,
};
const SIDED = { shoulder: 'Shoulder', upperarm: 'UpperArm', lowerarm: 'LowerArm', hand: 'Hand', upperleg: 'UpperLeg', lowerleg: 'LowerLeg', foot: 'Foot', eye: 'Eye' };
const SPINE = /^(spine|chest|upperchest|abdomen)\d*$/;
const FINGER = /^(?:hand|f)?(thumb|index|middle|ring|pinky|pink|little)0?([1-4])$/;

function parse(name) {
  let n = name.toLowerCase().replace(/^.*[:|]/, '');
  let side = null;
  if (n.includes('left')) { side = 'left'; n = n.replace(/left/g, ''); }
  else if (n.includes('right')) { side = 'right'; n = n.replace(/right/g, ''); }
  else {
    const m = n.match(/(^|[._\-\s])(l|r)($|[._\-\s])/);
    if (m) { side = m[2] === 'l' ? 'left' : 'right'; n = n.replace(m[0], ' '); }
  }
  n = n.replace(/(^|[._\-\s])c(?=[._\-\s])/, ' '); // VRM centre bones: J_Bip_C_Hips
  n = n.replace(/[^a-z0-9]/g, '');
  for (const j of JUNK) if (n.startsWith(j) && n.length > j.length) { n = n.slice(j.length); break; }
  return { side, part: n };
}

const depth = (b) => { let d = 0; for (let p = b.parent; p; p = p.parent) d++; return d; };

/** bones: THREE.Bone[]  ->  { canonicalId: boneName } */
export function autoMap(bones) {
  const map = {};
  const spines = [];
  const sorted = [...bones].sort((a, b) => depth(a) - depth(b));
  for (const b of sorted) {
    const { side, part } = parse(b.name);
    if (!side && SPINE.test(part)) { spines.push(b); continue; }
    const fm = FINGER.exec(part);
    if (fm) {
      if (side) {
        const f = fm[1] === 'little' || fm[1] === 'pink' ? 'Pinky' : cap(fm[1]);
        const id = `${side}${f}${fm[2]}`;
        if (!map[id]) map[id] = b.name;
      }
      continue;
    }
    for (const [key, re] of Object.entries(PARTS)) {
      if (!re.test(part)) continue;
      let id = null;
      if (SIDED[key]) { if (side) id = side + SIDED[key]; }
      else if (!side) id = key;
      if (id && !map[id]) map[id] = b.name;
      break;
    }
  }
  if (spines[0]) map.spine = spines[0].name;
  if (spines.length > 1) map.chest = spines[spines.length - 1].name;
  return map;
}
