'use strict';
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const plain = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return plain(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text) return v.text;
    if (v.error) return v.error;
    return JSON.stringify(v);
  }
  return v;
};
async function open(p, ctx, mustExist) {
  const full = ctx.safePath(p);
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(full)) await wb.xlsx.readFile(full);
  else if (mustExist) throw new Error('File not found: ' + full);
  return { wb, full };
}
const sheetOf = (wb, name, create) => {
  let ws = name ? wb.getWorksheet(name) : wb.worksheets[0];
  if (!ws && create) ws = wb.addWorksheet(name || 'Sheet1');
  if (!ws) throw new Error('Sheet not found: ' + (name || '(first)'));
  return ws;
};
async function save(wb, full) { fs.mkdirSync(path.dirname(full), { recursive: true }); await wb.xlsx.writeFile(full); }

module.exports = {
  tools: {
    async list_sheets({ path: p }, ctx) {
      const { wb } = await open(p, ctx, true);
      return wb.worksheets.map((w) => ({ name: w.name, rows: w.actualRowCount, columns: w.actualColumnCount }));
    },
    async read({ path: p, sheet, range, maxRows = 200 }, ctx) {
      const { wb } = await open(p, ctx, true);
      const ws = sheetOf(wb, sheet);
      let r1 = 1, r2 = Math.min(ws.rowCount, maxRows), c1 = 1, c2 = ws.columnCount;
      if (range) {
        const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.trim());
        if (!m) throw new Error('Range must look like A1:F40');
        const col = (s) => s.toUpperCase().split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0);
        c1 = col(m[1]); r1 = +m[2]; c2 = col(m[3]); r2 = Math.min(+m[4], r1 + maxRows - 1);
      }
      const rows = [];
      for (let r = r1; r <= r2; r++) {
        const row = [];
        for (let c = c1; c <= c2; c++) row.push(plain(ws.getCell(r, c).value));
        rows.push(row);
      }
      return { sheet: ws.name, fromRow: r1, rows, totalRows: ws.rowCount };
    },
    async write_cells({ path: p, sheet, cells }, ctx) {
      const { wb, full } = await open(p, ctx, false);
      const ws = sheetOf(wb, sheet, true);
      for (const c of cells) ws.getCell(c.ref).value = c.formula ? { formula: String(c.formula).replace(/^=/, '') } : c.value;
      await save(wb, full);
      return `Wrote ${cells.length} cells in ${ws.name} (${full})`;
    },
    async append_rows({ path: p, sheet, rows }, ctx) {
      const { wb, full } = await open(p, ctx, false);
      const ws = sheetOf(wb, sheet, true);
      for (const r of rows) ws.addRow(r);
      await save(wb, full);
      return `Added ${rows.length} rows to ${ws.name} (${full})`;
    },
    async create({ path: p, sheets }, ctx) {
      const full = ctx.safePath(p);
      if (fs.existsSync(full)) throw new Error('The file already exists. Use write_cells or append_rows to change it.');
      const wb = new ExcelJS.Workbook();
      for (const s of sheets) {
        const ws = wb.addWorksheet(s.name);
        for (const r of s.rows || []) ws.addRow(r);
        if (s.rows && s.rows.length) ws.getRow(1).font = { bold: true };
        ws.columns.forEach((c) => { let w = 8; c.eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, String(plain(cell.value)).length + 2); }); c.width = Math.min(w, 60); });
      }
      await save(wb, full);
      return `Created ${full}`;
    },
  },
};
