'use strict';
// Long-term memory (facts about the user) and reminders. Small files, a single timer, nothing else running.
const { app, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const file = (n) => path.join(app.getPath('userData'), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => {
  const target = file(n), tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(v, null, 1), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup is best effort */ }
    throw error;
  }
};

/* ---------- facts ---------- */
let facts = null;
const loadFacts = () => (facts = facts || readJson('memory.json', []));
const addFact = (text) => {
  const t = String(text || '').trim().slice(0, 300);
  if (!t) return 'Nothing to remember.';
  const f = loadFacts();
  if (!f.some((x) => x.text.toLowerCase() === t.toLowerCase())) { f.push({ text: t, t: Date.now() }); if (f.length > 200) f.shift(); writeJson('memory.json', f); }
  return 'Remembered.';
};
const forgetFact = (text) => {
  const q = String(text || '').trim().toLowerCase();
  if (!q) return 'Specify what to forget; no memory was changed.';
  const f = loadFacts(), keep = f.filter((x) => !x.text.toLowerCase().includes(q));
  facts = keep; writeJson('memory.json', keep);
  return `Forgot ${f.length - keep.length} item(s).`;
};
const listFacts = () => loadFacts().map((x) => x.text);
const removeFactAt = (i) => { const f = loadFacts(), index = Number(i); if (!Number.isInteger(index) || index < 0 || index >= f.length) return false; f.splice(index, 1); writeJson('memory.json', f); return true; };
const normalizeMemory = (s) => String(s || '').toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const MEMORY_STOP = new Set(['the','and','for','with','from','that','this','have','your','you','are','was','will','can','please','من','في','على','الى','عن','هذا','هذه','ذلك','التي','الذي','مع','هو','هي','انا','اريد','كان','يكون','كل','بعد','قبل']);
function rankFacts(items, query, limit = 8) {
  const terms = [...new Set(normalizeMemory(query).split(' ').filter((w) => w.length > 2 && !MEMORY_STOP.has(w)))];
  const recent = items.slice().sort((a, b) => (b.t || 0) - (a.t || 0));
  if (!terms.length) return recent.slice(0, limit);
  const scored = recent.map((fact, index) => {
    const words = normalizeMemory(fact.text).split(' ');
    const score = terms.reduce((sum, term) => {
      if (words.includes(term)) return sum + 3;
      if (term.length >= 4 && words.some((word) => word.length >= 4 && (word.includes(term) || term.includes(word)))) return sum + 1;
      return sum;
    }, 0);
    return { fact, score, index };
  }).filter((x) => x.score > 0).sort((x, y) => y.score - x.score || x.index - y.index);
  const selected = scored.slice(0, limit).map((x) => x.fact);
  for (const fact of recent.slice(0, 3)) if (selected.length < limit && !selected.includes(fact)) selected.push(fact);
  return selected;
}
const promptText = (query = '', limit = 8) => {
  const f = rankFacts(loadFacts(), query, limit);
  return f.length ? '\nRelevant things you know about the user and their work (apply only when relevant; do not recite):\n- ' + f.map((x) => x.text).join('\n- ') : '';
};

/* ---------- reminders ---------- */
let reminders = null, timer = 0, onFire = () => {};
const loadRem = () => (reminders = reminders || readJson('reminders.json', []));
const saveRem = () => writeJson('reminders.json', loadRem());
function schedule() {
  clearTimeout(timer);
  const r = loadRem().slice().sort((a, b) => a.at - b.at)[0];
  if (!r) return;
  const wait = Math.max(500, Math.min(r.at - Date.now(), 2 ** 31 - 1));
  timer = setTimeout(() => {
    const due = loadRem().filter((x) => x.at <= Date.now() + 1000);
    reminders = loadRem().filter((x) => !due.includes(x)); saveRem();
    for (const d of due) { onFire(d); try { new Notification({ title: 'Saeed', body: d.text }).show(); } catch { /* no notifications */ } }
    schedule();
  }, wait);
}
function addReminder({ text, inMinutes, at }) {
  let when = 0;
  if (inMinutes != null && isFinite(Number(inMinutes))) when = Date.now() + Number(inMinutes) * 60000;
  else if (at) when = new Date(at).getTime();
  if (!when || isNaN(when) || when < Date.now() - 1000) return 'Give a time in the future (inMinutes, or at as a local date-time).';
  const r = { id: Math.random().toString(36).slice(2, 8), text: String(text || '').slice(0, 300) || 'Reminder', at: when };
  loadRem().push(r); saveRem(); schedule();
  return `Reminder ${r.id} set for ${new Date(when).toLocaleString()}.`;
}
const listReminders = () => loadRem().map((r) => ({ id: r.id, text: r.text, at: new Date(r.at).toLocaleString() }));
const cancelReminder = (id) => { const n = loadRem().length; reminders = loadRem().filter((r) => r.id !== id); saveRem(); schedule(); return n === reminders.length ? 'No such reminder.' : 'Cancelled.'; };
const initReminders = (fire) => { onFire = fire; schedule(); };

module.exports = { addFact, forgetFact, listFacts, removeFactAt, promptText, addReminder, listReminders, cancelReminder, initReminders, _test: { normalizeMemory, rankFacts } };
