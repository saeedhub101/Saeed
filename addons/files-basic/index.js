'use strict';
// Every path goes through ctx.access(): Saeed's Permissions decide (allow / ask / deny) and may ask the user.
const fs = require('fs');
const path = require('path');

module.exports = {
  tools: {
    async list_folder({ path: p }, ctx) {
      const dir = await ctx.access(p, 'read');
      return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map((e) => {
        const full = path.join(dir, e.name);
        let size = 0, modified = '';
        try { const st = fs.statSync(full); size = st.size; modified = st.mtime.toISOString().slice(0, 16); } catch { /* skip */ }
        return { name: e.name, type: e.isDirectory() ? 'folder' : 'file', size, modified };
      });
    },
    async read_text({ path: p, maxChars = 20000 }, ctx) {
      const text = fs.readFileSync(await ctx.access(p, 'read'), 'utf8');
      return text.length > maxChars ? text.slice(0, maxChars) + `\n…(${text.length - maxChars} more characters)` : text;
    },
    async write_text({ path: p, content, append }, ctx) {
      const full = await ctx.access(p, 'write', `${append ? 'Append to' : 'Write'} a text file (${String(content).length} characters)`);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      if (append) fs.appendFileSync(full, content); else fs.writeFileSync(full, content);
      return `Saved ${full}`;
    },
    async find_files({ folder, contains, maxResults = 50 }, ctx) {
      const root = await ctx.access(folder, 'read'), q = String(contains).toLowerCase(), out = [];
      (function walk(d, depth) {
        if (out.length >= maxResults || depth > 6) return;
        let items = [];
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of items) {
          if (out.length >= maxResults) return;
          const full = path.join(d, e.name);
          if (ctx.isBlocked(full)) continue;                 // folders blocked in Permissions are skipped
          if (e.name.toLowerCase().includes(q)) out.push(full);
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') walk(full, depth + 1);
        }
      })(root, 0);
      return out;
    },
    async make_folder({ path: p }, ctx) {
      const full = await ctx.access(p, 'write', 'Create a folder');
      fs.mkdirSync(full, { recursive: true });
      return `Created ${full}`;
    },
    async copy_path({ from, to }, ctx) {
      const a = await ctx.access(from, 'read'), b = await ctx.access(to, 'write', `Copy from ${a}`);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      fs.cpSync(a, b, { recursive: true, errorOnExist: true, force: false });
      return `Copied to ${b}`;
    },
    async move_path({ from, to }, ctx) {
      const a = await ctx.access(from, 'write', 'Move or rename (source)'), b = await ctx.access(to, 'write', `Move or rename from ${from}`);
      fs.mkdirSync(path.dirname(b), { recursive: true });
      if (fs.existsSync(b)) throw new Error('The destination already exists.');
      try { fs.renameSync(a, b); } catch { fs.cpSync(a, b, { recursive: true }); fs.rmSync(a, { recursive: true, force: true }); }
      return `Moved to ${b}`;
    },
    async delete_path({ path: p, permanent }, ctx) {
      if (permanent) {
        const full = await ctx.access(p, 'delete-permanent', 'Delete permanently. This cannot be undone.');
        fs.rmSync(full, { recursive: true, force: true });
        return `Deleted permanently: ${full}`;
      }
      const real = await ctx.trash(p);
      return `Moved to the Recycle Bin: ${real}`;
    },
  },
};
