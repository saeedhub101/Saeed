// A small "liveliness" layer on top of the character engine: idle energy, occasional
// spontaneous gestures, glancing toward the real cursor, a one-time greeting when Saeed
// appears, and sleeping after a long absence with a glad-to-see-you wake. None of this
// ever fires while he is speaking, listening or mid-gesture, and it never repeats the
// same thing twice in a row.
const rand = (a, b) => a + Math.random() * (b - a);
const FIDGETS = ['look', 'smile', 'wink', 'brows'];
const WAKE_PICKS = ['greet', 'wave', 'happy'];

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

    if (!this.greeted && idleMs > 2500 && !busy) { this.greeted = true; this.boost(10); this.do('wave'); return; }

    if (!busy) {
      if (!this.asleep && idleMs > this.sleepAfterMs) { this.asleep = true; this.do('sleep'); return; }
      if (this.asleep && idleMs < this.sleepAfterMs) {
        this.asleep = false; this.boost(20);
        this.ch.command('stand');
        this.do(this.pick(WAKE_PICKS));
        return;
      }
    }
    if (this.asleep || busy) return;

    this.nextGlance -= dtSec;
    if (this.nextGlance <= 0) { this.nextGlance = rand(10, 18); this.glance(); }

    this.nextFidget -= dtSec;
    if (this.nextFidget <= 0) {
      this.do(this.pick(FIDGETS));
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
