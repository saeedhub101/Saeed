'use strict';
const fs = require('fs');

module.exports = {
  tools: {
    async read({ path: p, fromPage = 1, toPage = 0, maxChars = 30000 }, ctx) {
      const pdf = require('pdf-parse/lib/pdf-parse.js');
      const buf = fs.readFileSync(ctx.safePath(p));
      const pages = [];
      const info = await pdf(buf, {
        max: toPage || 0,
        pagerender: (page) => page.getTextContent().then((tc) => {
          let last = null, text = '';
          for (const it of tc.items) {
            const y = it.transform[5];
            text += (last !== null && Math.abs(y - last) > 2 ? '\n' : last !== null ? ' ' : '') + it.str;
            last = y;
          }
          pages.push(text);
          return text;
        }),
      });
      const from = Math.max(1, fromPage);
      let out = '';
      pages.forEach((t, i) => { if (i + 1 >= from) out += `--- page ${i + 1} ---\n${t}\n`; });
      if (!out.trim()) return `No text found in ${info.numpages} page(s). The PDF may be scanned: use the OCR add-on, or attach the page as an image in the chat.`;
      return `Pages in file: ${info.numpages}\n` + (out.length > maxChars ? out.slice(0, maxChars) + '\n…(truncated)' : out);
    },
  },
};
