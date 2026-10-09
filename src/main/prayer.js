'use strict';
// Prayer times: one request per month (Aladhan calendar API), cached on disk. A timer fires the adhan.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sig = (p) => `${p.city}|${p.country}|${p.method}`;
const cacheFile = (y, m) => path.join(app.getPath('userData'), `prayer-${y}-${pad(m)}.json`);

let days = {}, lastSig = '', timer = null, ctx = null, busy = false;
const fired = new Set();

async function loadMonth(p, date, force) {
  const y = date.getFullYear(), m = date.getMonth() + 1, f = cacheFile(y, m);
  if (!force) {
    try { const c = JSON.parse(fs.readFileSync(f, 'utf8')); if (c.sig === sig(p)) { Object.assign(days, c.days); return; } } catch { /* fetch */ }
  }
  const url = `https://api.aladhan.com/v1/calendarByCity/${y}/${m}?city=${encodeURIComponent(p.city)}&country=${encodeURIComponent(p.country)}&method=${p.method}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Prayer times request failed: ' + r.status);
  const j = await r.json();
  const out = {};
  for (const d of j.data) {
    const [dd, mm, yy] = d.date.gregorian.date.split('-');
    const t = {};
    for (const n of NAMES) t[n] = String(d.timings[n]).slice(0, 5);
    out[`${yy}-${mm}-${dd}`] = t;
  }
  Object.assign(days, out);
  fs.writeFileSync(f, JSON.stringify({ sig: sig(p), days: out }));
}

async function ensure(p, force) {
  if (busy) return;
  busy = true;
  try {
    if (lastSig !== sig(p)) { days = {}; fired.clear(); lastSig = sig(p); }
    const now = new Date();
    if (force || !days[dateKey(now)]) await loadMonth(p, now, force);
    const soon = new Date(now.getTime() + 2 * 86400000);
    if (soon.getMonth() !== now.getMonth() && !days[dateKey(soon)]) await loadMonth(p, soon, false);
  } finally { busy = false; }
}

const today = () => days[dateKey(new Date())] || null;

function next() {
  const now = new Date();
  const check = (d) => {
    const t = days[dateKey(d)];
    if (!t) return null;
    for (const n of NAMES) {
      const [h, m] = t[n].split(':').map(Number);
      const when = new Date(d); when.setHours(h, m, 0, 0);
      if (when > now) return { name: n, time: t[n] };
    }
    return null;
  };
  return check(now) || check(new Date(now.getTime() + 86400000));
}

async function tick() {
  const p = ctx.getSettings().prayer;
  if (!p.enabled) return;
  try { await ensure(p, false); } catch (e) { console.error('[prayer]', e.message); return; }
  const t = today();
  if (!t) return;
  const now = new Date();
  for (const n of NAMES) {
    const [h, m] = t[n].split(':').map(Number);
    const when = new Date(now); when.setHours(h, m, 0, 0);
    const diff = now - when;
    if (diff >= 0 && diff < 60000) {
      const k = `${dateKey(now)}-${n}`;
      if (!fired.has(k)) { fired.add(k); ctx.onAdhan(n); }
    }
  }
  if (ctx.onUpdate) ctx.onUpdate();
}

function start(c) { ctx = c; clearInterval(timer); timer = setInterval(tick, 15000); tick(); }
async function refresh() { const p = ctx.getSettings().prayer; await ensure(p, true); if (ctx.onUpdate) ctx.onUpdate(); return today(); }
module.exports = { start, refresh, today, next, NAMES };
