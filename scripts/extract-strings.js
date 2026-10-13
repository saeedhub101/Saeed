#!/usr/bin/env node
// Lists the English texts of the interface, as a starting point for a language add-on:
//   node scripts/extract-strings.js > strings.template.json   (then translate the values)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'src/renderer')).filter((f) => /\.(js|html)$/.test(f)).map((f) => path.join('src/renderer', f)),
  'src/main/main.js', 'src/main/permissions.js', 'src/shared/face.js',
];
const out = new Set();
const keep = (s) => {
  if (s.length < 3 || s.length > 260 || !/[A-Za-z]{2}/.test(s)) return false;
  if (/^[a-z][a-zA-Z0-9_.:\-]*$/.test(s) && !/\s/.test(s)) return false;          // identifiers, css classes, event names
  if (/[=;<>]|=>|\bfunction\b|^https?:|\.\w{2,4}$|^[#.\[]|px$|^rgba?\(|^\d|\$\{/.test(s) && !/\s{1}[A-Za-z]/.test(s)) return false;
  if (/\$\{|=>|\{\s*$|^\s*\.|\/\/|[{}]\s*$/.test(s)) return false;
  return /\s/.test(s) || /^[A-Z][a-z]{3,}/.test(s);
};
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) { const s = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, '\n'); if (keep(s)) out.add(s); }
  for (const m of src.matchAll(/>([^<>{}\n]{3,200})</g)) { const s = m[1].trim(); if (keep(s)) out.add(s); }
}
const obj = {};
for (const s of [...out].sort()) obj[s] = '';
process.stdout.write(JSON.stringify(obj, null, 1) + '\n');
