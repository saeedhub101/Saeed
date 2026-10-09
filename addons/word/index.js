'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  tools: {
    async read({ path: p, maxChars = 20000 }, ctx) {
      const mammoth = require('mammoth');
      const { value } = await mammoth.extractRawText({ path: ctx.safePath(p) });
      return value.length > maxChars ? value.slice(0, maxChars) + `\n…(${value.length - maxChars} more characters)` : value;
    },
    async create({ path: p, blocks, rtl }, ctx) {
      const d = require('docx');
      const full = ctx.safePath(p);
      if (fs.existsSync(full)) throw new Error('The file already exists. Choose another name.');
      const H = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3];
      const para = (text, extra = {}) => new d.Paragraph({ children: [new d.TextRun({ text: String(text), rightToLeft: !!rtl })], bidirectional: !!rtl, ...extra });
      const children = [];
      for (const b of blocks) {
        if (b.type === 'heading') children.push(para(b.text, { heading: H[Math.min(2, Math.max(0, (b.level || 1) - 1))] }));
        else if (b.type === 'table') {
          children.push(new d.Table({
            width: { size: 100, type: d.WidthType.PERCENTAGE },
            rows: (b.rows || []).map((r, i) => new d.TableRow({ tableHeader: i === 0, children: r.map((c) => new d.TableCell({ children: [para(c ?? '', i === 0 ? {} : {})] })) })),
          }));
          children.push(para(''));
        } else children.push(para(b.text || ''));
      }
      const doc = new d.Document({ sections: [{ children }] });
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, await d.Packer.toBuffer(doc));
      return `Created ${full}`;
    },
  },
};
