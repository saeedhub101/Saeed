'use strict';
// Persistent skill memory: how to do a task Saeed has learned, kept separate from user facts (memory.js)
// and from hand-written Procedures (settings.procedures). A skill is built by Saeed himself from a successful
// run (learn_skill), consulted before similar tasks (relevant/promptText), and corrected when something changes.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'skills.json');
let skills = null;
function load() {
  if (skills) return skills;
  try { skills = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { skills = []; }
  return skills;
}
function save() {
  const target = file(), tmp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(load(), null, 1), 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cleanup is best effort */ }
    throw error;
  }
}

const normalize = (s) => String(s || '').toLowerCase()
  .replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const STOP_WORDS = new Set(['the','and','for','with','from','that','this','please','من','في','على','الى','عن','هذا','هذه','مع','هو','هي','انا','اريد','نفذ','اعمل','قم','كل']);
const words = (s) => [...new Set(normalize(s).split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w)))];
const slug = () => Math.random().toString(36).slice(2, 8);

function learn({ name, app: appName, keywords, steps, fields, verify, notes }) {
  if (!name || !steps) return 'Give at least a name and the steps.';
  const list = load();
  const near = list.find((s) => s.name.toLowerCase() === String(name).toLowerCase() && (s.app || '') === (appName || ''));
  const row = {
    id: near ? near.id : slug(), name: String(name).slice(0, 120), app: String(appName || '').slice(0, 80),
    keywords: String(keywords || name).slice(0, 200), steps: String(steps).slice(0, 4000),
    fields: fields && typeof fields === 'object' ? fields : near ? near.fields : {}, verify: String(verify || '').slice(0, 500),
    notes: String(notes || '').slice(0, 1000), uses: near ? near.uses : 0, failures: near ? near.failures : 0,
    createdAt: near ? near.createdAt : Date.now(), updatedAt: Date.now(),
  };
  if (near) Object.assign(near, row); else list.push(row);
  save();
  return `Saved the skill "${row.name}"${row.app ? ' for ' + row.app : ''} (id ${row.id}).`;
}

function scoreSkill(skill, query) {
  const q = words(query);
  const hay = words([skill.name, skill.app, skill.keywords].join(' '));
  if (!q.length) return 0;
  return q.reduce((score, term) => {
    if (hay.includes(term)) return score + 3;
    if (term.length >= 4 && hay.some((word) => word.length >= 4 && (word.includes(term) || term.includes(word)))) return score + 1;
    return score;
  }, 0);
}
function recall(query, limit = 5) {
  const q = words(query);
  const list = load();
  const scored = list.map((s) => ({ s, score: scoreSkill(s, query) }))
    .filter((x) => x.score > 0 || !q.length)
    .sort((a, b) => b.score - a.score
      || ((b.s.uses || 0) - (b.s.failures || 0)) - ((a.s.uses || 0) - (a.s.failures || 0))
      || (b.s.updatedAt || 0) - (a.s.updatedAt || 0));
  return scored.slice(0, limit).map((x) => x.s);
}

function update(id, patch) {
  const s = load().find((x) => x.id === id);
  if (!s) return `No skill with id ${id}.`;
  for (const k of ['name', 'app', 'keywords', 'steps', 'verify', 'notes']) if (patch[k] != null) s[k] = String(patch[k]).slice(0, 4000);
  if (patch.fields && typeof patch.fields === 'object') s.fields = { ...s.fields, ...patch.fields };
  if (patch.outcome === 'success') s.uses++; else if (patch.outcome === 'failure') s.failures++;
  s.updatedAt = Date.now();
  save();
  return `Updated "${s.name}".`;
}

function forget(id) {
  const list = load(), n = list.length;
  skills = list.filter((s) => s.id !== id);
  save();
  return n === skills.length ? `No skill with id ${id}.` : 'Forgotten.';
}

const list = () => load();
function removeAt(i) { const l = load(), index = Number(i); if (!Number.isInteger(index) || index < 0 || index >= l.length) return false; l.splice(index, 1); save(); return true; }

// Added to the brain's system prompt when a skill's keywords match the request.
function promptText(query) {
  const hits = recall(query, 3).filter((s) => s.uses >= s.failures);   // skip ones that have failed more than they worked
  if (!hits.length) return '';
  return '\n\nSkills you have learned that may apply here (adapt if the screen looks different; re-check before trusting a saved field position):\n' +
    hits.map((s) => `## ${s.name}${s.app ? ' (' + s.app + ')' : ''}\nSteps: ${s.steps}${s.verify ? `\nHow to verify success: ${s.verify}` : ''}${s.notes ? `\nNotes: ${s.notes}` : ''}`).join('\n\n').slice(0, 5000);
}

module.exports = { learn, recall, update, forget, list, removeAt, promptText, _test: { normalize, words, scoreSkill } };
