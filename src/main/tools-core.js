'use strict';
// Tools that are part of Saeed himself (no add-on needed): files anywhere, apps, commands, the web, memory and reminders.
// Everything goes through Permissions, so what you allow there is what he can do.
const { nativeImage, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const perms = require('./permissions');
const secrets = require('./secrets');
const memory = require('./memory');

const CORE = { addon: 'core', addonName: 'Saeed' };
const acc = (p, action, detail) => perms.access({ ...CORE, path: p, action, detail });
const cap = (c, detail, onlyDeny) => perms.checkCap({ ...CORE, cap: c, detail, onlyDeny });
const cut = (t, n = 20000) => { t = String(t); return t.length > n ? t.slice(0, n) + `\n…(${t.length - n} more characters)` : t; };
const S = (o) => ({ type: 'object', properties: o.p || {}, required: o.r || [] });
const str = (d) => ({ type: 'string', description: d });
const isWin = process.platform === 'win32';
const norm = (p) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));

/* ---------- finding files ---------- */
const psEncoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
function ps(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!isWin) return reject(new Error('Windows only'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(script)],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).slice(0, 300))) : resolve(String(out))));
  });
}
const words = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const sq = (s) => String(s).replace(/'/g, "''");

// The Windows Search index answers in a fraction of a second for indexed places.
async function indexSearch(name, ext, roots, limit) {
  if (!isWin) return [];
  const conds = words(name).map((w) => `System.FileName LIKE '%${sq(w)}%'`);
  if (ext) conds.push(`System.FileExtension = '.${sq(String(ext).replace(/^\./, ''))}'`);
  if (!conds.length) return [];
  const scope = roots.map((r) => `SCOPE='file:${sq(r.replace(/\\+$/, ''))}'`).join(' OR ');
  const sql = `SELECT TOP ${limit} System.ItemPathDisplay FROM SystemIndex WHERE ${conds.join(' AND ')} AND (${scope}) ORDER BY System.DateModified DESC`;
  try {
    const out = await ps(`$c = New-Object -ComObject ADODB.Connection; $c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"); $r = New-Object -ComObject ADODB.Recordset; $r.Open('${sq(sql)}', $c); while (-not $r.EOF) { $r.Fields.Item(0).Value; $r.MoveNext() }`, 12000);
    return out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
}

const SKIP = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information', 'windows', 'appdata', 'programdata', 'program files', 'program files (x86)', '$windows.~bt']);
async function walkSearch(name, ext, roots, limit, ms) {
  const ws = words(name), e = ext ? '.' + String(ext).replace(/^\./, '').toLowerCase() : '';
  const deny = perms.denyList().map(norm);
  const blocked = (p) => { const n = norm(p); return deny.some((d) => n === d || n.startsWith(d + path.sep)); };
  const out = [], queue = roots.map((r) => ({ p: r, explicit: true })), deadline = Date.now() + ms;
  while (queue.length && out.length < limit && Date.now() < deadline) {
    const batch = queue.splice(0, 24);
    await Promise.all(batch.map(async ({ p, explicit }) => {
      let items;
      try { items = await fs.promises.readdir(p, { withFileTypes: true }); } catch { return; }
      for (const it of items) {
        const full = path.join(p, it.name), low = it.name.toLowerCase();
        if (it.isDirectory()) { if ((!SKIP.has(low) || explicit) && !low.startsWith('.') && !blocked(full)) queue.push({ p: full, explicit: false }); }
        if ((ws.every((w) => low.includes(w)) || !ws.length) && (!e || low.endsWith(e)) && (ws.length || e)) out.push(full);
      }
    }));
  }
  return out;
}

async function findFiles(a) {
  const limit = Math.max(1, Math.min(100, Number(a.limit) || 30));
  let roots;
  if (a.folder) roots = [await acc(a.folder, 'read', `Search for "${a.name || ''}"`)];
  else if (a.everywhere && isWin) {
    roots = [];
    for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${l}:\\`)) { try { roots.push(await acc(`${l}:\\`, 'read', `Search drive ${l}: for "${a.name || ''}"`)); } catch { /* not allowed */ } }
  } else {
    roots = [];
    for (const n of ['Desktop', 'Documents', 'Downloads']) { try { roots.push(await acc(path.join(os.homedir(), n), 'read', `Search for "${a.name || ''}"`)); } catch { /* not allowed */ } }
  }
  if (!roots.length) throw new Error('No place to search is allowed. Allow folders in Saeed → Permissions.');
  let found = await indexSearch(a.name, a.ext, roots, limit);
  if (found.length < limit) found = [...new Set([...found, ...(await walkSearch(a.name, a.ext, roots, limit, 6000))])].slice(0, limit * 2);
  const rows = [];
  for (const p of found) {
    try { const st = fs.statSync(p); if (a.newerThanDays && Date.now() - st.mtimeMs > a.newerThanDays * 86400000) continue; rows.push({ path: p, size: st.size, modified: st.mtime.toISOString().slice(0, 16), type: st.isDirectory() ? 'folder' : 'file', t: st.mtimeMs }); } catch { /* vanished */ }
  }
  rows.sort((x, y) => y.t - x.t);
  return rows.slice(0, limit).map(({ t, ...r }) => r);
}

/* ---------- reading ---------- */
function readText(real, maxChars) {
  const fd = fs.openSync(real, 'r');
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(size, 2 * 1024 * 1024), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    if (buf.subarray(0, Math.min(n, 4096)).includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe)) return null;
    const t = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le') : buf.toString('utf8');
    return cut(t + (size > n ? '\n…(file is larger)' : ''), maxChars);
  } finally { fs.closeSync(fd); }
}
const HINT = { pdf: 'Use the PDF add-on (pdf__read, pdf__render_page).', xlsx: 'Use the Excel add-on.', xls: 'Use the Excel add-on.', docx: 'Use the Word add-on.', png: 'Use view_image.', jpg: 'Use view_image.', jpeg: 'Use view_image.' };

/* ---------- the web ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ', '&apos;': "'" };
const decode = (s) => String(s).replace(/&(amp|lt|gt|quot|nbsp|apos|#39);/g, (m) => entities[m] || m).replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n));
function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '';
  let t = String(html).replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, h, x) => { const label = x.replace(/<[^>]+>/g, '').trim(); return label ? `${label} (${h})` : ''; })
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|br)\s*>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  t = decode(t).replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: decode(title).trim(), text: t };
}
const fill = (s) => String(s ?? '').replace(/\{\{secret:([^}]+)\}\}/g, (_m, n) => secrets.get('user:' + n.replace(/^user:/, '')));

async function webSearch(a, settings) {
  const n = Math.max(1, Math.min(10, Number(a.count) || settings.web.maxResults || 6)), q = String(a.query || '').trim();
  if (!q) throw new Error('Empty query.');
  const prov = settings.web.search;
  if (prov === 'brave' && secrets.get('brave')) {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${n}`, { headers: { 'X-Subscription-Token': secrets.get('brave'), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`Brave search ${r.status}`);
    return ((await r.json()).web?.results || []).slice(0, n).map((x) => ({ title: x.title, url: x.url, snippet: decode((x.description || '').replace(/<[^>]+>/g, '')) }));
  }
  if (prov === 'tavily' && secrets.get('tavily')) {
    const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${secrets.get('tavily')}` }, body: JSON.stringify({ query: q, max_results: n, include_answer: true }), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Tavily search ${r.status}`);
    const j = await r.json();
    return { answer: j.answer, results: (j.results || []).map((x) => ({ title: x.title, url: x.url, snippet: x.content })) };
  }
  const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA }, body: 'q=' + encodeURIComponent(q), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Search failed (${r.status}). Add a Brave or Tavily key in Settings → Web for reliable results.`);
  return parseDuck(await r.text()).slice(0, n);
}
function parseDuck(html) {
  const out = [], re = /<a\b([^>]*class="[^"]*result__a[^"]*"[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    let href = (/href="([^"]+)"/.exec(m[1]) || [])[1] || '';
    const u = /uddg=([^&]+)/.exec(href);
    if (u) href = decodeURIComponent(u[1]); else if (href.startsWith('//')) href = 'https:' + href;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 2500), sn = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(after);
    out.push({ title: decode(m[2].replace(/<[^>]+>/g, '')).trim(), url: href, snippet: sn ? decode(sn[1].replace(/<[^>]+>/g, '')).trim() : '' });
  }
  return out.filter((x) => x.url.startsWith('http'));
}

async function webFetch(a, settings) {
  const r = await fetch(fill(a.url), { headers: { 'user-agent': UA, accept: 'text/html,application/json,text/plain,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const type = r.headers.get('content-type') || '';
  if (!r.ok) return `HTTP ${r.status} ${r.statusText}`;
  if (/pdf|octet-stream|zip|image\//i.test(type)) return `This is a ${type} file, not a page. Use download_file to save it, then open it with the matching tool.`;
  const raw = Buffer.from(await r.arrayBuffer()).subarray(0, 3 * 1024 * 1024).toString('utf8');
  const max = Number(a.maxChars) || settings.web.fetchMaxChars || 12000;
  if (/json/i.test(type)) return cut(raw, max);
  const { title, text } = /html/i.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw };
  return cut(`${title ? title + '\n\n' : ''}${text}`, max);
}

async function httpRequest(a) {
  const method = String(a.method || 'GET').toUpperCase();
  const why = await cap(method === 'GET' ? 'web.read' : 'web.send', `${method} ${a.url}`);
  if (why) return 'Denied: ' + why;
  const headers = {}; for (const [k, v] of Object.entries(a.headers || {})) headers[k] = fill(v);
  const body = a.body == null ? undefined : fill(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
  if (a.body && typeof a.body !== 'string' && !headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';
  const r = await fetch(fill(a.url), { method, headers: { 'user-agent': UA, ...headers }, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(30000) });
  return cut(`HTTP ${r.status}\n${await r.text()}`, 20000);
}

async function downloadFile(a) {
  const real = await acc(a.path, 'write', `Download ${a.url}`);
  const r = await fetch(fill(a.url), { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  fs.mkdirSync(path.dirname(real), { recursive: true });
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(real, buf);
  return `Saved ${buf.length} bytes to ${real}`;
}

/* ---------- commands and system ---------- */
function runCommand(a) {
  const sh = a.shell === 'cmd' ? 'cmd' : 'powershell';
  const [exe, args] = isWin ? (sh === 'cmd' ? ['cmd.exe', ['/d', '/s', '/c', a.command]] : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', a.command]]) : ['sh', ['-c', a.command]];
  return new Promise((resolve) => {
    execFile(exe, args, { cwd: a.cwd || os.homedir(), windowsHide: true, timeout: Math.min(600, Number(a.timeoutSec) || 60) * 1000, maxBuffer: 8 * 1024 * 1024 },
      (e, out, err) => resolve(cut(`${e && e.killed ? '(timed out)\n' : ''}${out || ''}${err ? '\n[stderr] ' + err : ''}${e && !out && !err ? String(e.message) : ''}`.trim() || '(no output)', 8000)));
  });
}
function systemInfo() {
  const drives = [];
  if (isWin) for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { try { const s = fs.statfsSync(`${l}:\\`); drives.push(`${l}: ${(s.bavail * s.bsize / 1e9).toFixed(0)} GB free of ${(s.blocks * s.bsize / 1e9).toFixed(0)} GB`); } catch { /* no such drive */ } }
  return { os: `${os.type()} ${os.release()}`, computer: os.hostname(), user: os.userInfo().username, home: os.homedir(), cpu: `${os.cpus()[0]?.model || ''} x${os.cpus().length}`,
    memory: `${(os.freemem() / 1e9).toFixed(1)} GB free of ${(os.totalmem() / 1e9).toFixed(1)} GB`, drives, language: process.env.LANG || '' };
}

/* ---------- definitions ---------- */
const DEFS = [
  { name: 'find_files', description: 'Find files and folders by (part of) the name, anywhere. Searches the fast Windows index first. Defaults to Desktop, Documents and Downloads; use folder for a place, everywhere:true for all drives. Always use this instead of asking the user for a path.',
    schema: S({ p: { name: str('Words from the file name'), ext: str('Extension such as xlsx, pdf'), folder: str('Folder to search in'), everywhere: { type: 'boolean' }, newerThanDays: { type: 'number' }, limit: { type: 'number' } } }) },
  { name: 'list_folder', description: 'List what is inside a folder.', schema: S({ p: { path: str('Folder') }, r: ['path'] }) },
  { name: 'read_file', description: 'Read a text-like file (txt, csv, json, xml, log, md, code). For PDF, Excel, Word use their add-on tools.', schema: S({ p: { path: str('File'), maxChars: { type: 'number' } }, r: ['path'] }) },
  { name: 'write_file', description: 'Create or overwrite a text file, or append to it. A path with no drive letter (e.g. "Desktop/notes.txt") is placed under the user\'s own home folder.', schema: S({ p: { path: str('File'), content: str('Text'), append: { type: 'boolean' } }, r: ['path', 'content'] }) },
  { name: 'make_folder', description: 'Create a folder. A path with no drive letter is placed under the user\'s own home folder.', schema: S({ p: { path: str('Folder') }, r: ['path'] }) },
  { name: 'copy_path', description: 'Copy a file or folder.', schema: S({ p: { from: str('Source'), to: str('Destination') }, r: ['from', 'to'] }) },
  { name: 'move_path', description: 'Move or rename a file or folder.', schema: S({ p: { from: str('Source'), to: str('Destination') }, r: ['from', 'to'] }) },
  { name: 'delete_path', description: 'Delete a file or folder (Recycle Bin by default; permanent:true deletes for good).', schema: S({ p: { path: str('Item'), permanent: { type: 'boolean' } }, r: ['path'] }) },
  { name: 'open_path', description: 'Open any file or folder with its default program (Excel opens .xlsx, etc.). reveal:true only shows it in Explorer. Use find_files first if you only know the name.', schema: S({ p: { path: str('File or folder'), reveal: { type: 'boolean' } }, r: ['path'] }) },
  { name: 'view_image', description: 'Look at a picture file (png, jpg, bmp, gif).', schema: S({ p: { path: str('Image file') }, r: ['path'] }) },
  { name: 'file_info', description: 'Size, dates and type of a file or folder.', schema: S({ p: { path: str('Item') }, r: ['path'] }) },
  { name: 'run_command', description: 'Run a PowerShell (or cmd) command on this PC and return the output. Use for anything the other tools cannot do. Prefer read-only commands unless the user asked for a change.', schema: S({ p: { command: str('Command'), shell: { type: 'string', enum: ['powershell', 'cmd'] }, cwd: str('Folder'), timeoutSec: { type: 'number' } }, r: ['command'] }) },
  { name: 'system_info', description: 'Computer, user, memory and disks.', schema: S({}) },
  { name: 'web_search', description: 'Search the internet in the background (no browser window). Returns titles, links and snippets. Then use web_fetch to read the best pages.', schema: S({ p: { query: str('What to search'), count: { type: 'number' } }, r: ['query'] }) },
  { name: 'web_fetch', description: 'Download a web page or API response and return its readable text (no browser window).', schema: S({ p: { url: str('Address'), maxChars: { type: 'number' } }, r: ['url'] }) },
  { name: 'http_request', description: 'Call a web API. Put secrets as {{secret:NAME}} (saved in Settings → Web) in url, headers or body so you never see them.', schema: S({ p: { method: str('GET, POST, PUT, DELETE'), url: str('Address'), headers: { type: 'object' }, body: {} }, r: ['url'] }) },
  { name: 'download_file', description: 'Download a file from the internet to a path on this PC.', schema: S({ p: { url: str('Address'), path: str('Where to save') }, r: ['url', 'path'] }) },
  { name: 'remember', description: 'Remember a lasting fact about the user or their work (preferences, names, how things are done).', schema: S({ p: { fact: str('The fact') }, r: ['fact'] }) },
  { name: 'forget', description: 'Forget remembered facts that contain this text.', schema: S({ p: { text: str('Text') }, r: ['text'] }) },
  { name: 'set_reminder', description: 'Remind the user later (spoken and a notification). Give inMinutes, or at as a local date-time like 2026-10-12T09:30.', schema: S({ p: { text: str('What to remind'), inMinutes: { type: 'number' }, at: str('Local date-time') }, r: ['text'] }) },
  { name: 'list_reminders', description: 'List the pending reminders.', schema: S({}) },
  { name: 'cancel_reminder', description: 'Cancel a reminder by id.', schema: S({ p: { id: str('Reminder id') }, r: ['id'] }) },
];
const NAMES = new Set(DEFS.map((d) => d.name));

async function run(name, a, { settings }) {
  try {
    switch (name) {
      case 'find_files': { const r = await findFiles(a); return r.length ? JSON.stringify(r) : 'No file with that name was found in the searched places. Try everywhere:true or another spelling.'; }
      case 'list_folder': {
        const dir = await acc(a.path, 'read');
        return JSON.stringify(fs.readdirSync(dir, { withFileTypes: true }).slice(0, 400).map((e) => { let s = {}; try { s = fs.statSync(path.join(dir, e.name)); } catch { /* skip */ } return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', size: s.size || 0, modified: s.mtime ? s.mtime.toISOString().slice(0, 16) : '' }; }));
      }
      case 'read_file': {
        const real = await acc(a.path, 'read'), t = readText(real, a.maxChars || 20000);
        return t ?? `This looks like a binary file. ${HINT[path.extname(real).slice(1).toLowerCase()] || 'Use a matching add-on.'}`;
      }
      case 'write_file': { const real = await acc(a.path, 'write', `${a.append ? 'Append to' : 'Write'} a file (${String(a.content).length} characters)`); fs.mkdirSync(path.dirname(real), { recursive: true }); (a.append ? fs.appendFileSync : fs.writeFileSync)(real, a.content); return `Saved ${real}`; }
      case 'make_folder': { const real = await acc(a.path, 'write', 'Create a folder'); fs.mkdirSync(real, { recursive: true }); return `Created ${real}`; }
      case 'copy_path': { const x = await acc(a.from, 'read'), y = await acc(a.to, 'write', `Copy from ${a.from}`); fs.mkdirSync(path.dirname(y), { recursive: true }); fs.cpSync(x, y, { recursive: true, errorOnExist: true, force: false }); return `Copied to ${y}`; }
      case 'move_path': {
        const x = await acc(a.from, 'write', 'Move or rename (source)'), y = await acc(a.to, 'write', `Move or rename from ${a.from}`);
        if (fs.existsSync(y)) return 'The destination already exists.';
        fs.mkdirSync(path.dirname(y), { recursive: true });
        try { fs.renameSync(x, y); } catch { fs.cpSync(x, y, { recursive: true }); fs.rmSync(x, { recursive: true, force: true }); }
        return `Moved to ${y}`;
      }
      case 'delete_path': {
        if (a.permanent) { const real = await acc(a.path, 'delete-permanent', 'Delete permanently. This cannot be undone.'); fs.rmSync(real, { recursive: true, force: true }); return `Deleted permanently: ${real}`; }
        const real = await acc(a.path, 'delete', 'Move to the Recycle Bin'); await shell.trashItem(real); return `Moved to the Recycle Bin: ${real}`;
      }
      case 'open_path': {
        const real = await acc(a.path, 'read', 'Open'), why = await cap('apps.open', `Open ${real}`);
        if (why) return 'Denied: ' + why;
        if (a.reveal) { shell.showItemInFolder(real); return `Shown in Explorer: ${real}`; }
        const err = await shell.openPath(real);
        return err ? `Could not open it: ${err}` : `Opened ${real}`;
      }
      case 'view_image': {
        const real = await acc(a.path, 'read');
        let img = nativeImage.createFromPath(real);
        if (img.isEmpty()) return 'This is not an image file I can read (png, jpg, bmp, gif).';
        const { width, height } = img.getSize();
        if (width > 1600) img = img.resize({ width: 1600 });
        return { text: `Image ${width}x${height}: ${real}`, image: { mime: 'image/jpeg', data: img.toJPEG(85).toString('base64') } };
      }
      case 'file_info': { const real = await acc(a.path, 'read'), s = fs.statSync(real); return JSON.stringify({ path: real, type: s.isDirectory() ? 'folder' : 'file', size: s.size, created: s.birthtime.toISOString(), modified: s.mtime.toISOString() }); }
      case 'run_command': {
        const why = await cap('system.run', String(a.command).slice(0, 600));
        return why ? 'Denied: ' + why : runCommand(a);
      }
      case 'system_info': return JSON.stringify(systemInfo());
      case 'web_search': { const why = await cap('web.read', `Search: ${a.query}`); return why ? 'Denied: ' + why : JSON.stringify(await webSearch(a, settings)); }
      case 'web_fetch': { const why = await cap('web.read', `Read ${a.url}`); return why ? 'Denied: ' + why : webFetch(a, settings); }
      case 'http_request': return httpRequest(a);
      case 'download_file': { const why = await cap('web.send', `Download ${a.url}`); return why ? 'Denied: ' + why : downloadFile(a); }
      case 'remember': return memory.addFact(a.fact);
      case 'forget': return memory.forgetFact(a.text);
      case 'set_reminder': return memory.addReminder(a);
      case 'list_reminders': return JSON.stringify(memory.listReminders());
      case 'cancel_reminder': return memory.cancelReminder(a.id);
      default: return 'Unknown tool.';
    }
  } catch (e) { return 'Error: ' + e.message; }
}

module.exports = { defs: () => DEFS, has: (n) => NAMES.has(n), run, findFiles, _test: { htmlToText, parseDuck, walkSearch, fill } };
