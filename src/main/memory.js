'use strict';
// Long-term memory (facts about the user) and reminders. Small files, a single timer, nothing else running.
const { app, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

const file = (n) => path.join(app.getPath('userData'), n);
const readJson = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const writeJson = (n, v) => fs.writeFile(file(n), JSON.stringify(v, null, 1), () => {});

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
  const f = loadFacts(), keep = f.filter((x) => !x.text.toLowerCase().includes(q));
  facts = keep; writeJson('memory.json', keep);
  return `Forgot ${f.length - keep.length} item(s).`;
};
const listFacts = () => loadFacts().map((x) => x.text);
const removeFactAt = (i) => { const f = loadFacts(); f.splice(i, 1); writeJson('memory.json', f); };
const promptText = (limit = 40) => { const f = loadFacts().slice(-limit); return f.length ? '\nThings you know about the user and their world (use them naturally, never recite them):\n- ' + f.map((x) => x.text).join('\n- ') : ''; };

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

module.exports = { addFact, forgetFact, listFacts, removeFactAt, promptText, addReminder, listReminders, cancelReminder, initReminders };
