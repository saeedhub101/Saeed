// Microphone capture with an RMS gate, barge-in (interrupting Saeed), audio playback and lip-sync levels.
const TARGET = 16000;

export function resample(x, from, to, gain) {
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio, i0 = Math.floor(p), f = p - i0;
    const a = x[i0], b = i0 + 1 < x.length ? x[i0 + 1] : a;
    o[i] = Math.max(-1, Math.min(1, (a + (b - a) * f) * gain));
  }
  return o;
}

const WORKLET = `class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.b = []; this.n = 0; }
  process(inputs) {
    const c = inputs[0] && inputs[0][0];
    if (c) {
      this.b.push(new Float32Array(c)); this.n += c.length;
      if (this.n >= 1024) {
        const o = new Float32Array(this.n); let k = 0;
        for (const x of this.b) { o.set(x, k); k += x.length; }
        this.b = []; this.n = 0; this.port.postMessage(o, [o.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);`;

export class Voice {
  /** hooks: onLevel(rms) onHearing(bool) onUtterance(f32) onInterrupt() onSpeaking(bool, kind) onMouth({open, vowel}) onError(msg) */
  constructor(getSettings, hooks = {}) {
    this.getSettings = getSettings; this.hooks = hooks;
    this.stream = null; this.ctx = null; this.node = null;
    this.pre = []; this.preMs = 0; this.rec = null; this.recMs = 0; this.voicedMs = 0; this.quiet = 0; this.loud = 0; this.irq = 0;
    this.paused = false;
    this.out = null; this.queue = []; this.cur = null; this.kind = 'speech'; this.pending = 0; this.doneFlag = true;
    this.speaking = false; this.sys = false; this.gen = 0; this.mouthTimer = 0;
    this.live = false; this.liveSrcs = new Set(); this.nextT = 0; this.rtDone = true; this.closeTimer = 0;
  }
  get a() { return this.getSettings().audio; }
  get on() { return !!this.stream; }

  /* ---------- capture ---------- */
  async start() {
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.node = new AudioWorkletNode(this.ctx, 'capture');
      this.node.port.onmessage = (e) => this.frame(e.data);
      const mute = this.ctx.createGain(); mute.gain.value = 0;
      src.connect(this.node); this.node.connect(mute); mute.connect(this.ctx.destination);
      this.rec = null; this.pre = []; this.preMs = 0; this.loud = 0; this.irq = 0;
    } catch (e) { this.stop(); throw e; }
  }
  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.node) this.node.port.onmessage = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.stream = this.ctx = this.node = null;
    if (this.rec) { this.rec = null; this.hooks.onHearing?.(false); }
    this.hooks.onLevel?.(0);
  }

  frame(data) {
    if (!this.ctx) return;
    const a = this.a, gain = a.micGain || 1;
    let s = 0;
    for (let i = 0; i < data.length; i++) { const v = data[i] * gain; s += v * v; }
    const rms = Math.sqrt(s / data.length);
    const ms = (data.length / this.ctx.sampleRate) * 1000;
    this.hooks.onLevel?.(rms);
    if (this.live) {                       // live conversation: the server listens, we only stream audio and watch for interruptions
      this.hooks.onRaw?.(data, this.ctx.sampleRate, gain);
      if (this.speaking && rms > a.interruptRms) { this.irq += ms; if (this.irq >= a.interruptMs) { this.irq = 0; this.interrupt(); } } else this.irq = 0;
      return;
    }
    if (this.paused) return;
    const chunk = resample(data, this.ctx.sampleRate, TARGET, gain);
    if (this.rec) {
      this.rec.push(chunk); this.recMs += ms;
      if (rms >= a.micRms * 0.6) { this.voicedMs += ms; this.quiet = 0; } else this.quiet += ms;
      if (this.quiet >= a.silenceMs || this.recMs > 30000) this.finish();
      return;
    }
    this.pre.push(chunk); this.preMs += ms;
    while (this.preMs > 300 && this.pre.length > 1) this.preMs -= this.pre.shift().length / 16;
    if (this.speaking) {
      if (rms > a.interruptRms) {
        this.irq += ms;
        if (this.irq >= a.interruptMs) { this.irq = 0; this.interrupt(); this.beginRec(); }
      } else this.irq = 0;
      return;
    }
    if (rms > a.micRms) { this.loud += ms; if (this.loud >= 80) this.beginRec(); } else this.loud = 0;
  }
  beginRec() {
    this.rec = this.pre.splice(0); this.recMs = this.preMs; this.preMs = 0;
    this.voicedMs = 0; this.quiet = 0; this.loud = 0;
    this.hooks.onHearing?.(true);
  }
  finish() {
    const parts = this.rec; this.rec = null;
    this.hooks.onHearing?.(false);
    if (this.voicedMs < this.a.minSpeechMs) return;
    let n = 0; for (const p of parts) n += p.length;
    const out = new Float32Array(n); let k = 0;
    for (const p of parts) { out.set(p, k); k += p.length; }
    const end = Math.max(1600, n - Math.max(0, Math.floor((this.quiet - 300) * 16)));
    this.hooks.onUtterance?.(out.slice(0, end));
  }
  interrupt() { this.stopSpeaking(); this.hooks.onInterrupt?.(); }

  /* ---------- playback ---------- */
  ensureOut() {
    clearTimeout(this.closeTimer);
    if (this.out) return;
    this.out = new AudioContext();
    this.gain = this.out.createGain();
    this.an = this.out.createAnalyser(); this.an.fftSize = 1024;
    this.gain.connect(this.an); this.an.connect(this.out.destination);
    this.td = new Uint8Array(this.an.fftSize); this.fd = new Uint8Array(this.an.frequencyBinCount);
  }
  beginStream() { this.doneFlag = false; }
  markStreamDone() { this.doneFlag = true; this.maybeEnd(); }
  async playBytes(bytes, { kind = 'speech', volume = 1 } = {}) {
    this.ensureOut();
    const g = this.gen;
    this.pending++;
    try {
      if (this.out.state === 'suspended') await this.out.resume();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const buf = await this.out.decodeAudioData(ab);
      if (g === this.gen) { this.queue.push({ buf, kind, volume }); this.pump(); }
    } catch (e) { this.hooks.onError?.('Could not play the audio: ' + e.message); }
    finally { this.pending--; this.maybeEnd(); }
  }
  async playAdhan(bytes, volume) {
    this.beginStream();
    await this.playBytes(bytes, { kind: 'adhan', volume });
    this.markStreamDone();
  }
  pump() {
    if (this.cur || !this.queue.length) return;
    const it = this.queue.shift();
    const src = this.out.createBufferSource();
    src.buffer = it.buf; src.connect(this.gain);
    this.gain.gain.value = this.a.volume * (it.volume ?? 1);
    this.cur = src; this.kind = it.kind; this.paused = it.kind === 'adhan';
    this.setSpeaking(true);
    src.onended = () => { if (this.cur !== src) return; this.cur = null; this.pump(); this.maybeEnd(); };
    src.start();
    this.startMouth();
  }
  maybeEnd() { if (this.doneFlag && !this.cur && !this.queue.length && !this.pending && !this.sys) this.setSpeaking(false); }
  setSpeaking(v) {
    if (this.speaking === v) return;
    this.speaking = v;
    if (!v) {
      this.paused = false; this.stopMouth();
      clearTimeout(this.closeTimer);           // free the audio device when nothing was played for a while
      this.closeTimer = setTimeout(() => {
        if (!this.speaking && this.out) { this.out.close().catch(() => {}); this.out = this.an = this.gain = null; this.nextT = 0; }
      }, 30000);
    }
    this.hooks.onSpeaking?.(v, this.kind);
  }
  stopSpeaking() {
    this.gen++;
    this.queue = [];
    try { if (this.cur) { this.cur.onended = null; this.cur.stop(); } } catch { /* already stopped */ }
    this.cur = null; this.sys = false; this.doneFlag = true;
    for (const s of this.liveSrcs) { s.onended = null; try { s.stop(); } catch { /* stopped */ } }
    this.liveSrcs.clear(); this.nextT = 0; this.rtDone = true;
    try { speechSynthesis.cancel(); } catch { /* none */ }
    this.setSpeaking(false);
  }
  setVolume() { if (this.gain) this.gain.gain.value = this.a.volume; }

  /** Live conversation: raw PCM16 chunks from the server, played gaplessly. */
  playPcm(u8, rate = 24000) {
    this.ensureOut();
    if (this.out.state === 'suspended') this.out.resume();
    const n = Math.floor(u8.byteLength / 2);
    const dv = new DataView(u8.buffer, u8.byteOffset, n * 2);
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
    const buf = this.out.createBuffer(1, n, rate);
    buf.copyToChannel(f, 0);
    const src = this.out.createBufferSource();
    src.buffer = buf; src.connect(this.gain);
    this.gain.gain.value = this.a.volume;
    const t = Math.max(this.out.currentTime + 0.02, this.nextT);
    src.start(t); this.nextT = t + buf.duration;
    this.rtDone = false; this.kind = 'speech';
    this.liveSrcs.add(src);
    src.onended = () => { this.liveSrcs.delete(src); if (!this.liveSrcs.size && this.rtDone) this.setSpeaking(false); };
    this.setSpeaking(true); this.startMouth();
  }
  rtDoneNow() { this.rtDone = true; if (!this.liveSrcs.size) this.setSpeaking(false); }

  /** Windows system voices (no network). Mouth movement is simulated because the audio is not capturable. */
  speakSystem(sentences, tts) {
    this.stopSpeaking();
    const gen = ++this.gen;
    this.sys = true; this.kind = 'speech'; this.doneFlag = true;
    this.setSpeaking(true); this.startMouth();
    const voice = speechSynthesis.getVoices().find((v) => v.name === tts.voice);
    sentences.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      if (voice) u.voice = voice; else u.lang = /[\u0600-\u06FF]/.test(t) ? 'ar-SA' : 'en-US';
      u.rate = tts.rate || 1; u.pitch = tts.pitch || 1; u.volume = this.a.volume;
      const end = () => { if (gen !== this.gen || i < sentences.length - 1) return; this.sys = false; this.setSpeaking(false); };
      u.onend = end; u.onerror = end;
      speechSynthesis.speak(u);
    });
  }

  /* ---------- lip-sync levels ---------- */
  startMouth() { if (!this.mouthTimer) this.mouthTimer = setInterval(() => this.mouthTick(), 45); }
  stopMouth() { clearInterval(this.mouthTimer); this.mouthTimer = 0; this.hooks.onMouth?.({ open: 0, vowel: null }); }
  mouthTick() {
    if (this.sys || !this.an) {
      const V = ['aa', 'oh', 'ee', 'ou', 'ih'];
      this.hooks.onMouth?.({ open: 0.2 + 0.5 * Math.abs(Math.sin(performance.now() / 110)) * (Math.random() > 0.15 ? 1 : 0.3), vowel: V[Math.floor(Math.random() * V.length)] });
      return;
    }
    this.an.getByteTimeDomainData(this.td);
    let s = 0;
    for (const v of this.td) { const x = (v - 128) / 128; s += x * x; }
    const open = Math.min(1, Math.max(0, (Math.sqrt(s / this.td.length) - 0.01) * 7));
    let vowel = null;
    if (open > 0.08) {
      this.an.getByteFrequencyData(this.fd);
      const hz = this.out.sampleRate / this.an.fftSize;
      let num = 0, den = 0;
      for (let i = Math.floor(200 / hz); i < Math.min(this.fd.length, Math.floor(4000 / hz)); i++) { num += i * hz * this.fd[i]; den += this.fd[i]; }
      const c = den ? num / den : 0;
      vowel = c < 600 ? 'ou' : c < 900 ? 'oh' : c < 1300 ? 'aa' : c < 1900 ? 'ee' : 'ih';
    }
    this.hooks.onMouth?.({ open, vowel });
  }
}
