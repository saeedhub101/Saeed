'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  tools: {
    async list_folder({ path: p }, ctx) {
      const dir = ctx.safePath(p);
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map((e) => {
        const full = path.join(dir, e.name);
        let size = 0, modified = '';
        try { const st = fs.statSync(full); size = st.size; modified = st.mtime.toISOString().slice(0, 16); } catch { /* skip */ }
        return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', size, modified };
      });
    },
    async read_text({ path: p, maxChars = 20000 }, ctx) {
      const text = fs.readFileSync(ctx.safePath(p), 'utf8');
      return text.length > maxChars ? text.slice(0, maxChars) + `\n…(${text.length - maxChars} more characters)` : text;
    },
    async write_text({ path: p, content, append }, ctx) {
      const full = ctx.safePath(p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (append) fs.appendFileSync(full, content); else fs.writeFileSync(full, content);
      return `Saved ${full}`;
    },
    async find_files({ folder, contains, maxResults = 50 }, ctx) {
      const root = ctx.safePath(folder), q = String(contains).toLowerCase(), out = [];
      (function walk(d, depth) {
        if (out.length >= maxResults || depth > 6) return;
        let items = [];
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of items) {
          if (out.length >= maxResults) return;
          const full = path.join(d, e.name);
          if (e.name.toLowerCase().includes(q)) out.push(full);
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
        }
      })(root, 0);
      return out;
    },
  },
};
