'use strict';
// API keys live in main only. They are encrypted with Windows DPAPI (safeStorage) and never sent to windows.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'secrets.json');
let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { cache = {}; }
  return cache;
}
function set(name, value) {
  load();
  if (!value) delete cache[name];
  else if (safeStorage.isEncryptionAvailable()) cache[name] = { e: true, v: safeStorage.encryptString(value).toString('base64') };
  else cache[name] = { e: false, v: Buffer.from(value).toString('base64') };
  fs.writeFileSync(file(), JSON.stringify(cache));
}
function get(name) {
  const x = load()[name];
  if (!x) return '';
  try { return x.e ? safeStorage.decryptString(Buffer.from(x.v, 'base64')) : Buffer.from(x.v, 'base64').toString(); } catch { return ''; }
}
const has = (name) => !!load()[name];
module.exports = { set, get, has };
