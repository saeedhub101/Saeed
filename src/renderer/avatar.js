import * as THREE from 'three';
import { Character } from '../shared/character.js';

const api = window.api;
const canvas = document.getElementById('c');
const micBtn = document.getElementById('mic');
const bubble = document.getElementById('bubble');

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight, false);

const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1.5, 3, 3);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.1, 50);
const ch = new Character(scene);
let cfg = await api.getConfig();

function applyZoom() {
  const z = Math.min(2.4, Math.max(0.6, cfg.zoom || 1));
  camera.position.set(0, 0.88 + (z - 1) * 0.25, 3.8 / z);
  camera.lookAt(0, 0.85 + (z - 1) * 0.3, 0);
}
applyZoom();

/* ---------- speech bubble ---------- */
let bubbleTimer = 0;
function say(text, ms) {
  bubble.textContent = text;
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  const talkFor = Math.min(8, Math.max(1.5, text.length * 0.06));
  if (ch.model) ch.command('talk', { duration: talkFor });
  bubbleTimer = setTimeout(hideBubble, ms || talkFor * 1000 + 1800);
}
function hideBubble() { bubble.hidden = true; ch.stopActions(); }
const headPos = new THREE.Vector3();
function placeBubble() {
  if (bubble.hidden) return;
  const head = ch.map.head;
  if (!head) return;
  head.getWorldPosition(headPos);
  headPos.y += 0.3;
  headPos.project(camera);
  const x = Math.min(innerWidth - 140, Math.max(140, (headPos.x * 0.5 + 0.5) * innerWidth));
  const y = Math.max(50, (-headPos.y * 0.5 + 0.5) * innerHeight);
  bubble.style.left = x + 'px';
  bubble.style.top = y + 'px';
}

/* ---------- model ---------- */
async function loadModel() {
  const buf = await api.readModel();
  if (!buf) {
    ch.unload();
    say('Open the tray icon and choose "Change character…".', 9000);
    return;
  }
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try { await ch.load(ab, cfg); }
  catch (e) { console.error(e); say('This GLB file could not be loaded.', 6000); }
}
await loadModel();

api.onConfig(async (c) => {
  const reload = c.modelPath !== cfg.modelPath || JSON.stringify(c.customRig) !== JSON.stringify(cfg.customRig);
  cfg = c;
  if (reload) await loadModel(); else ch.applyConfig(cfg);
  applyZoom();
});
api.onCommand((cmd, args) => {
  if (cmd === 'say') say((args && args.text) || '…');
  else ch.command(cmd, args);
});

/* ---------- microphone (phase 1: on/off + level meter) ---------- */
let stream = null, actx = null, analyser = null, meterTimer = 0, micOn = false;
async function micStart() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    actx = new AudioContext();
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    actx.createMediaStreamSource(stream).connect(analyser);
    micOn = true;
    micBtn.classList.add('on');
    const data = new Uint8Array(analyser.fftSize);
    meterTimer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let s = 0;
      for (const v of data) s += (v - 128) * (v - 128);
      micBtn.style.setProperty('--level', Math.min(1, Math.sqrt(s / data.length) / 40).toFixed(2));
    }, 80);
  } catch (e) {
    console.error(e);
    micStop();
    say('The microphone is not available. Check Windows privacy settings.', 6000);
  }
}
function micStop() {
  micOn = false;
  clearInterval(meterTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (actx) actx.close();
  stream = actx = analyser = null;
  micBtn.classList.remove('on');
  micBtn.style.setProperty('--level', 0);
}
micBtn.addEventListener('click', () => (micOn ? micStop() : micStart()));

/* ---------- dragging, zoom, click-through ---------- */
let dragging = false, drag = null, pointer = null, overUI = false;
canvas.addEventListener('pointerdown', async (e) => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  dragging = true;
  drag = { sx: e.screenX, sy: e.screenY, b: null };
  drag.b = await api.dragStart();
});
canvas.addEventListener('pointermove', (e) => {
  if (dragging && drag && drag.b) api.dragMove(drag.b.x + e.screenX - drag.sx, drag.b.y + e.screenY - drag.sy);
});
const endDrag = () => { dragging = false; drag = null; };
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('dblclick', () => ch.command('greet'));
let zoomSave = 0;
canvas.addEventListener('wheel', (e) => {
  cfg.zoom = Math.min(2.4, Math.max(0.6, (cfg.zoom || 1) * (e.deltaY < 0 ? 1.08 : 0.93)));
  applyZoom();
  clearTimeout(zoomSave);
  zoomSave = setTimeout(() => api.setConfig({ zoom: cfg.zoom }), 500);
}, { passive: true });
document.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  overUI = !!(e.target.closest && e.target.closest('#mic'));
});

// Mouse events pass through transparent pixels: we read the alpha under the cursor after each render.
const gl = renderer.getContext();
const px = new Uint8Array(4);
let ignoring = null;
const setIgnore = (v) => { if (v !== ignoring) { ignoring = v; api.setIgnoreMouse(v); } };
function hitTest() {
  if (dragging || overUI || !cfg.clickThrough) { setIgnore(false); return; }
  if (!pointer) return;
  const r = renderer.getPixelRatio();
  gl.readPixels(Math.floor(pointer.x * r), Math.floor((innerHeight - pointer.y) * r), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  setIgnore(px[3] < 12);
}
if (cfg.clickThrough) setIgnore(true);

/* ---------- render loop ---------- */
let running = true, last = performance.now(), acc = 0;
function frame(now) {
  if (!running) return;
  requestAnimationFrame(frame);
  acc += (now - last) / 1000;
  last = now;
  if (acc < 1 / (cfg.fps || 30) - 0.002) return;
  const dt = Math.min(acc, 0.1);
  acc = 0;
  ch.update(dt);
  renderer.render(scene, camera);
  hitTest();
  placeBubble();
}
requestAnimationFrame(frame);

// Tray "Hide me" / "Show me": stop rendering and the microphone while hidden.
api.onService((state) => {
  if (state === 'pause') { running = false; micStop(); hideBubble(); }
  else if (!running) { running = true; last = performance.now(); acc = 0; requestAnimationFrame(frame); }
});

// Entry point for the future brain (LLM / voice): window.avatar.command('happy')
window.avatar = { say, command: (c, a) => ch.command(c, a), mic: { start: micStart, stop: micStop } };
