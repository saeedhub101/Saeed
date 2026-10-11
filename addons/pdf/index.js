'use strict';
const fs = require('fs');

async function pages(buf, max = 0) {
  const pdf = require('pdf-parse/lib/pdf-parse.js');
  const out = [];
  const info = await pdf(buf, {
    max,
    pagerender: (page) => page.getTextContent().then((tc) => {
      let last = null, text = '';
      for (const it of tc.items) {
        const y = it.transform[5];
        text += (last !== null && Math.abs(y - last) > 2 ? '\n' : last !== null ? ' ' : '') + it.str;
        last = y;
      }
      out.push(text);
      return text;
    }),
  });
  return { pages: out, info };
}
const cut = (t, n) => (t.length > n ? t.slice(0, n) + '\n…(truncated)' : t);

module.exports = {
  tools: {
    async info({ path: p }, ctx) {
      const { pages: pg, info } = await pages(fs.readFileSync(await ctx.access(p, 'read')), 1);
      return { pages: info.numpages, title: info.info && info.info.Title, author: info.info && info.info.Author, textOnFirstPage: pg[0] ? pg[0].length > 20 : false };
    },
    async read({ path: p, fromPage = 1, toPage = 0, maxChars = 30000 }, ctx) {
      const { pages: pg, info } = await pages(fs.readFileSync(await ctx.access(p, 'read')), toPage || 0);
      let out = '';
      pg.forEach((t, i) => { if (i + 1 >= Math.max(1, fromPage)) out += `--- page ${i + 1} ---\n${t}\n`; });
      if (!out.trim()) return `No text found in ${info.numpages} page(s). The PDF may be scanned: use render_page to look at a page, or the OCR add-on.`;
      return `Pages in file: ${info.numpages}\n` + cut(out, maxChars);
    },
    async search({ path: p, query, maxHits = 20 }, ctx) {
      const { pages: pg } = await pages(fs.readFileSync(await ctx.access(p, 'read')));
      const q = String(query).toLowerCase(), hits = [];
      pg.forEach((t, i) => {
        const low = t.toLowerCase();
        for (let at = low.indexOf(q); at >= 0 && hits.length < maxHits; at = low.indexOf(q, at + q.length)) hits.push({ page: i + 1, text: t.slice(Math.max(0, at - 70), at + q.length + 90).replace(/\s+/g, ' ') });
      });
      return hits.length ? hits : `"${query}" was not found in the text. If the pages are images, use render_page.`;
    },
    async render_page({ path: p, page = 1, scale = 1.6 }, ctx) {
      const data = new Uint8Array(fs.readFileSync(await ctx.access(p, 'read')));
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const { createCanvas } = require('@napi-rs/canvas');
      const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
      try {
        const n = Math.max(1, Math.min(doc.numPages, Math.round(page)));
        const pg = await doc.getPage(n), vp = pg.getViewport({ scale: Math.max(0.5, Math.min(4, scale)) });
        const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height)), c2d = canvas.getContext('2d');
        c2d.fillStyle = '#fff'; c2d.fillRect(0, 0, canvas.width, canvas.height);
        await pg.render({ canvasContext: c2d, viewport: vp, canvas }).promise;
        return { text: `Page ${n} of ${doc.numPages} (${canvas.width}x${canvas.height})`, image: { mime: 'image/png', data: canvas.toBuffer('image/png').toString('base64') } };
      } finally { await doc.destroy(); }
    },
  },
};
