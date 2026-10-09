import * as THREE from 'three';
import { Character } from '../shared/character.js';
import { Voice, resample } from './voice.js';

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
function showBubble(text, ms) {
  bubble.textContent = text;
  bubble.dir = 'auto';
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(hideBubble, ms);
}
function hideBubble() { bubble.hidden = true; clearTimeout(bubbleTimer); }
function say(text, ms) {
  const talkFor = Math.min(8, Math.max(1.5, text.length * 0.06));
  showBubble(text, ms || talkFor * 1000 + 1800);
  if (ch.model) ch.command('talk', { duration: talkFor });
}
const headPos = new THREE.Vector3();
function placeBubble() {
  if (bubble.hidden) return;
  const head = ch.map.head;
  if (!head) return;
  head.getWorldPosition(headPos);
  headPos.y += 0.3;
  headPos.project(camera);
  bubble.style.left = Math.min(innerWidth - 140, Math.max(140, (headPos.x * 0.5 + 0.5) * innerWidth)) + 'px';
  bubble.style.top = Math.max(50, (-headPos.y * 0.5 + 0.5) * innerHeight) + 'px';
}

/* ---------- model ---------- */
async function loadModel() {
  const buf = await api.readModel();
  if (!buf) { ch.unload(); say('Open the tray icon and choose "Change character…".', 9000); return; }
  const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  try { await ch.load(ab, cfg); }
  catch (e) { console.error(e); say('This GLB file could not be loaded.', 6000); }
  applyAcc();
}

/* ---------- accessories (from add-ons) ---------- */
let accList = [];
const applyAcc = () => ch.setAccessories(accList, cfg.accessories, (d) => api.addonFile(d.addon, d.file));
async function loadAcc() { accList = await api.accessoriesList(); applyAcc(); }
api.onAddonsChanged(loadAcc);
await loadModel();
loadAcc();

api.onConfig(async (c) => {
  const reload = c.modelPath !== cfg.modelPath || JSON.stringify(c.customRig) !== JSON.stringify(cfg.customRig);
  cfg = c;
  if (reload) await loadModel(); else { ch.applyConfig(cfg); applyAcc(); }
  applyZoom();
  voice.setVolume();
});
api.onCommand((cmd, args) => {
  if (cmd === 'say') say((args && args.text) || '…');
  else ch.command(cmd, args);
});

/* ---------- voice: microphone, speaking, lip-sync ---------- */
let rtRate = 24000, rtBuf = [], rtLen = 0, lastActive = performance.now();
const markActive = () => { lastActive = performance.now(); };
const voice = new Voice(() => cfg.settings, {
  onRaw: (data, rate, gain) => {
    const r = resample(data, rate, rtRate, gain);
    const pcm = new Int16Array(r.length);
    for (let i = 0; i < r.length; i++) pcm[i] = Math.max(-1, Math.min(1, r[i])) * 32767;
    rtBuf.push(pcm); rtLen += pcm.length;
    if (rtLen >= rtRate / 10) {
      const all = new Int16Array(rtLen); let k = 0;
      for (const p of rtBuf) { all.set(p, k); k += p.length; }
      rtBuf = []; rtLen = 0;
      api.rtAudio(all.buffer);
    }
  },
  onLevel: (rms) => micBtn.style.setProperty('--level', Math.min(1, rms * 6).toFixed(2)),
  onHearing: (on) => { markActive(); if (on) ch.command('listen', { hold: true }); else ch.stopActions(); },
  onUtterance: (f32) => api.sendUtterance(f32),
  onInterrupt: () => { if (voice.live) api.rtInterrupt(); else api.interrupt(); ch.stopActions(); hideBubble(); },
  onSpeaking: (on, kind) => {
    markActive();
    if (on && voice.live) return;
    if (on) { if (kind !== 'adhan') ch.command('talk', { hold: true }); }
    else { ch.stopActions(); ch.setMouth({ open: 0 }); if (cfg.settings.audio.bubbleAlways) setTimeout(hideBubble, 1500); }
  },
  onMouth: (m) => ch.setMouth(m),
  onError: (msg) => showBubble(msg, 5000),
});

async function micOn() {
  try {
    if (cfg.settings.realtime.provider !== 'off') {     // live conversation instead of the step-by-step pipeline
      const r = await api.rtStart();
      if (!r.ok) { showBubble(r.error, 8000); return; }
      rtRate = r.rate; voice.live = true;
    } else voice.live = false;
    await voice.start();
    micBtn.classList.add('on');
  } catch (e) {
    console.error(e);
    if (voice.live) { api.rtStop(); voice.live = false; }
    showBubble('The microphone is not available. Check Windows privacy settings.', 6000);
  }
}
function micOff() {
  voice.stop();
  if (voice.live) { api.rtStop(); voice.live = false; voice.stopSpeaking(); }
  micBtn.classList.remove('on'); micBtn.style.setProperty('--level', 0);
}
micBtn.addEventListener('click', () => (voice.on ? micOff() : micOn()));

// Events from the brain pipeline (main process).
let speakInfo = null;
api.onPipeline(async (ev) => {
  const a = cfg.settings.audio;
  markActive();
  switch (ev.type) {
    case 'thinking': ch.command('think'); break;
    case 'intent': ch.command(ev.name); break;
    case 'speak-start':
      speakInfo = ev; voice.beginStream();
      if (ev.muted || a.bubbleAlways) showBubble(ev.text, 0);
      if (ev.muted) ch.command('talk', { hold: true });
      break;
    case 'audio': voice.playBytes(ev.bytes); break;
    case 'tts-text': voice.speakSystem(ev.sentences, cfg.settings.tts.system); break;
    case 'speak-end':
      if (ev.muted) {
        const ms = Math.min(12000, Math.max(2000, (speakInfo ? speakInfo.text.length : 20) * 65));
        setTimeout(() => { ch.stopActions(); setTimeout(hideBubble, 1500); }, ms);
      } else voice.markStreamDone();
      break;
    case 'cancel': voice.stopSpeaking(); ch.stopActions(); hideBubble(); break;
    case 'adhan':
      showBubble(ev.text, 8000);
      if (ev.pose) ch.command('adhan', { hold: true });
      await voice.playAdhan(ev.bytes, ev.volume);
      break;
    case 'rt-audio': if (!a.muted) voice.playPcm(ev.pcm, ev.rate || rtRate); break;
    case 'rt-interrupt': voice.stopSpeaking(); ch.stopActions(); break;
    case 'rt-done': voice.rtDoneNow(); break;
    case 'rt-text': if (a.muted || a.bubbleAlways) showBubble(ev.text, Math.min(12000, Math.max(3000, ev.text.length * 65))); break;
    case 'rt-state': if (ev.state === 'closed' && voice.live) { micOff(); showBubble('The live conversation ended.', 3000); } break;
    case 'error': showBubble(ev.text, 7000); break;
    default: break;
  }
});

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
canvas.addEventListener('dblclick', () => api.openWindow('chat'));
let zoomSave = 0;
canvas.addEventListener('wheel', (e) => {
  cfg.zoom = Math.min(2.4, Math.max(0.6, (cfg.zoom || 1) * (e.deltaY < 0 ? 1.08 : 0.93)));
  applyZoom();
  clearTimeout(zoomSave);
  zoomSave = setTimeout(() => api.setConfig({ zoom: cfg.zoom }), 500);
}, { passive: true });
document.addEventListener('pointermove', (e) => {
  markActive();
  pointer = { x: e.clientX, y: e.clientY };
  overUI = !!(e.target.closest && e.target.closest('#mic'));
});

// Mouse events pass through transparent pixels: the alpha under the cursor is read after each render.
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
  // Full speed while something happens, a low rate while Saeed just stands there.
  const busy = performance.now() - lastActive < 8000 || voice.speaking || ch.actions.length > 0;
  const fps = busy ? (cfg.fps || 30) : ((cfg.settings.performance && cfg.settings.performance.idleFps) || 12);
  if (acc < 1 / fps - 0.002) return;
  const dt = Math.min(acc, 0.1);
  acc = 0;
  ch.update(dt);
  renderer.render(scene, camera);
  hitTest();
  placeBubble();
}
requestAnimationFrame(frame);

// Tray "Hide me" / "Show me": stop rendering, the microphone and any sound while hidden.
api.onService((state) => {
  if (state === 'pause') { running = false; micOff(); voice.stopSpeaking(); hideBubble(); }
  else if (!running) { running = true; last = performance.now(); acc = 0; requestAnimationFrame(frame); }
});

window.avatar = { say, command: (c, a) => ch.command(c, a), mic: { start: micOn, stop: micOff } };
