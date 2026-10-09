// Builds simple accessories (hats, flags, flowers...) from primitive parts described in an add-on manifest.
// Units are metres on a character that is 1.7 m tall, so they do not depend on the rig's scale.
import * as THREE from 'three';

const GEO = {
  cone: (s) => new THREE.ConeGeometry(s[0], s[1], 28),                                   // [radius, height]
  cylinder: (s) => (s.length === 2 ? new THREE.CylinderGeometry(s[0], s[0], s[1], 28) : new THREE.CylinderGeometry(s[0], s[1], s[2], 28)),
  sphere: (s) => new THREE.SphereGeometry(s[0], 28, 18),                                 // [radius]
  box: (s) => new THREE.BoxGeometry(s[0], s[1], s[2]),
  plane: (s) => new THREE.PlaneGeometry(s[0], s[1]),
  torus: (s) => new THREE.TorusGeometry(s[0], s[1], 14, 36),                             // [radius, tube]
};

export function buildParts(def) {
  const g = new THREE.Group();
  for (const p of def.parts || []) {
    const make = GEO[p.shape];
    if (!make) continue;
    const mat = new THREE.MeshStandardMaterial({ color: p.color || '#cccccc', roughness: 0.7, metalness: p.metalness || 0, side: p.shape === 'plane' ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(make(p.size || [0.1, 0.1, 0.1]), mat);
    mesh.position.set(...(p.position || [0, 0, 0]));
    mesh.rotation.set(...(p.rotation || [0, 0, 0]).map((d) => (d * Math.PI) / 180));
    if (p.scale) mesh.scale.set(...p.scale);
    g.add(mesh);
  }
  return g;
}
