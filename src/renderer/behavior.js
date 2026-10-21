// A small "liveliness" layer on top of the character engine: idle energy, occasional
// spontaneous gestures, glancing toward the real cursor, a one-time greeting when Saeed
// appears, and sleeping after a long absence with a glad-to-see-you wake. None of this
// ever fires while he is speaking, listening or mid-gesture, and it never repeats the
// same thing twice in a row.
const rand = (a, b) => a + Math.random() * (b - a);

// Moods tilt which idle gesture, wake gesture, and reaction gets picked - the same idea as
// Merlin-the-Wizard's mood palettes, adapted to Saeed's own gesture names. Mood itself drifts
// slowly: it leans cheerful/pleased after things go well, puzzled/sad after errors, sleepy late
// at night or when energy is low, and otherwise settles back toward a thoughtful/curious middle.
const PALETTES = {
  cheerful: { fidget: ['smile', 'wink', 'look'], wake: ['greet', 'wave', 'happy'], success: ['happy', 'laugh'], failure: ['worried'], surprise: ['surprised'], confusion: ['worried'], thank: ['smile', 'bow'] },
  pleased: { fidget: ['smile', 'happy', 'look'], wake: ['greet', 'wave', 'happy'], success: ['happy', 'laugh'], failure: ['worried'], surprise: ['surprised'], confusion: ['worried'], thank: ['bow', 'smile'] },
  thoughtful: { fidget: ['think', 'look', 'brows'], wake: ['greet', 'think'], success: ['smile', 'yes'], failure: ['think', 'worried'], surprise: ['surprised'], confusion: ['think'], thank: ['yes'] },
  mischievous: { fidget: ['wink', 'laugh', 'smile'], wake: ['wink', 'wave'], success: ['laugh', 'happy'], failure: ['worried'], surprise: ['surprised', 'laugh'], confusion: ['wink'], thank: ['wink'] },
  puzzled: { fidget: ['worried', 'brows', 'look'], wake: ['worried', 'greet'], success: ['smile'], failure: ['worried', 'sad'], surprise: ['surprised'], confusion: ['worried'], thank: ['smile'] },
  sad: { fidget: ['sad', 'look'], wake: ['greet'], success: ['smile'], failure: ['sad'], surprise: ['surprised'], confusion: ['sad'], thank: ['smile'] },
  sleepy: { fidget: ['look', 'brows'], wake: ['yes', 'greet'], success: ['smile'], failure: ['worried'], surprise: ['surprised'], confusion: ['worried'], thank: ['smile'] },
  curious: { fidget: ['look', 'brows', 'think'], wake: ['greet', 'surprised'], success: ['happy'], failure: ['think'], surprise: ['surprised'], confusion: ['think'], thank: ['smile'] },
};
const MOODS = Object.keys(PALETTES);

export class Behavior {
  constructor(ch, api) {
    this.ch = ch;
    this.api = api;
    this.energy = 70;
    this.nextFidget = rand(14, 24);
    this.nextGlance = rand(10, 18);
    this.recent = [];
    this.greeted = false;
    this.asleep = false;
    this.glancing = false;
    this.sleepAfterMs = 15 * 60000;
    this.mood = 'cheerful';
    this.moodScore = Object.fromEntries(MOODS.map((m) => [m, m === 'cheerful' ? 2 : m === 'curious' ? 0.5 : 0]));
    this.nextMoodCheck = rand(60, 120);
  }

  palette() { return PALETTES[this.mood]; }

  /** A felt event during real conversation: 'success' | 'failure' | 'surprise' | 'thank'. Nudges the mood, doesn't force an animation by itself. */
  notice(kind) {
    const s = this.moodScore;
    if (kind === 'success') { s.pleased += 1.5; s.cheerful += 1; s.sad = Math.max(0, s.sad - 1); s.puzzled = Math.max(0, s.puzzled - 0.5); }
    else if (kind === 'failure') { s.puzzled += 1; s.sad += 0.6; s.pleased = Math.max(0, s.pleased - 1); }
    else if (kind === 'surprise') { s.curious += 1; s.mischievous += 0.5; }
    else if (kind === 'thank') { s.pleased += 0.8; s.cheerful += 0.5; }
    this.shiftMood();
  }

  decayMood(dtSec) { for (const k of MOODS) this.moodScore[k] = Math.max(0, this.moodScore[k] - dtSec * 0.01); }

  shiftMood() {
    const h = new Date().getHours(), night = h >= 23 || h < 6;
    const w = { ...this.moodScore };
    w.sleepy += (night ? 2 : 0) + (this.energy < 35 ? 1.5 : 0);
    w.cheerful += !night && this.energy > 70 ? 1 : 0;
    w.thoughtful += 0.6; w.curious += 0.3;                 // a quiet floor so the middle moods still happen sometimes
    const entries = MOODS.map((m) => [m, w[m] + 0.3]);
    let r = Math.random() * entries.reduce((a, [, v]) => a + v, 0);
    for (const [m, v] of entries) { r -= v; if (r <= 0) { this.mood = m; return; } }
  }

  remember(name) {
    this.recent.push(name);
    if (this.recent.length > 4) this.recent.shift();
  }
  pick(list) {
    const fresh = list.filter((n) => !this.recent.includes(n));
    const pool = fresh.length ? fresh : list;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  do(name) { this.ch.command(name); this.remember(name); }

  // Quiet hours drain a little faster, so spontaneous fidgets thin out late at night
  // without ever stopping outright.
  decay(dtSec) {
    const h = new Date().getHours();
    const night = h >= 23 || h < 6;
    this.energy = Math.max(15, this.energy - dtSec * (night ? 0.035 : 0.015));
  }
  boost(amount) { this.energy = Math.min(100, this.energy + amount); }

  /** idleMs: time since the last real engagement (chat, voice, drag...). busy: speaking, listening, thinking, or mid-gesture. */
  tick({ dtSec, idleMs, busy }) {
    this.decay(dtSec);
    this.decayMood(dtSec);
    this.nextMoodCheck -= dtSec;
    if (this.nextMoodCheck <= 0) { this.nextMoodCheck = rand(60, 120); this.shiftMood(); }

    if (!this.greeted && idleMs > 2500 && !busy) { this.greeted = true; this.boost(10); this.do(this.pick(this.palette().wake)); return; }

    if (!busy) {
      if (!this.asleep && idleMs > this.sleepAfterMs) { this.asleep = true; this.do('sleep'); return; }
      if (this.asleep && idleMs < this.sleepAfterMs) {
        this.asleep = false; this.boost(20);
        this.do('wake');   // plays the real stand_up rising motion (it only fires because he was actually lying down)
        return;
      }
    }
    if (this.asleep || busy) return;

    this.nextGlance -= dtSec;
    if (this.nextGlance <= 0) { this.nextGlance = rand(10, 18); this.glance(); }

    this.nextFidget -= dtSec;
    if (this.nextFidget <= 0) {
      this.do(this.pick(this.palette().fidget));
      this.nextFidget = rand(14, 24) / Math.max(0.2, this.energy / 100);
    }
  }

  async glance() {
    if (this.glancing || this.asleep) return;
    this.glancing = true;
    try {
      const c = await this.api.cursorInfo();
      if (c && c.near) this.ch.face.lookAt(Math.max(-1, Math.min(1, -c.dx / 160)), Math.max(-1, Math.min(1, -c.dy / 160)), 1.6);
    } catch { /* window gone or no cursor info */ }
    this.glancing = false;
  }
}
