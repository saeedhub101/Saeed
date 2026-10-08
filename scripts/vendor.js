// Copies the three.js files the app needs into src/vendor/three.
// Why: electron-builder strips every "examples" folder from node_modules when it
// packs the installer, which removes GLTFLoader and breaks the packaged app.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const three = path.join(root, 'node_modules', 'three');
if (!fs.existsSync(three)) { console.log('[vendor] three is not installed, skipping'); process.exit(0); }

const out = path.join(root, 'src', 'vendor', 'three');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'addons'), { recursive: true });
fs.copyFileSync(path.join(three, 'build', 'three.module.js'), path.join(out, 'three.module.js'));
for (const dir of ['loaders', 'exporters', 'controls', 'utils']) {
  fs.cpSync(path.join(three, 'examples', 'jsm', dir), path.join(out, 'addons', dir), { recursive: true });
}
console.log('[vendor] three.js copied to src/vendor/three');
