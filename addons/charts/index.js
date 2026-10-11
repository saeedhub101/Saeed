'use strict';
const fs = require('fs');
const path = require('path');

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#be185d', '#4b5563'];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rtl = (s) => /[\u0600-\u06FF]/.test(String(s));
const fmt = (v) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(+v.toFixed(2)));
const text = (x, y, s, o = {}) => `<text x="${x}" y="${y}" font-size="${o.size || 14}" fill="${o.fill || '#222'}" text-anchor="${o.anchor || 'middle'}"${o.bold ? ' font-weight="700"' : ''}${o.rot ? ` transform="rotate(${o.rot} ${x} ${y})"` : ''}${rtl(s) ? ' direction="rtl" unicode-bidi="plaintext"' : ''}>${esc(s)}</text>`;

/* ---------- numbers ---------- */
function niceTicks(min, max, n = 6) {
  if (!(max > min)) { max = min + 1; }
  const raw = (max - min) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const start = Math.floor(min / step) * step, out = [];
  for (let v = start; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return { ticks: out, min: out[0], max: out[out.length - 1] };
}
function polyfit(pts, deg) {
  const n = deg + 1, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const [x, y] of pts) for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += x ** (i + j); A[i][n] += y * x ** i; }
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) continue;
    for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
  }
  return A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[n] / row[i]));
}
const polyval = (c, x) => c.reduce((a, k, i) => a + k * x ** i, 0);
const sorted = (pts) => [...pts].sort((a, b) => a[0] - b[0]);
function interp(pts, x) {                    // linear, null outside the data
  const p = sorted(pts);
  if (!p.length || x < p[0][0] - 1e-9 || x > p[p.length - 1][0] + 1e-9) return null;
  for (let i = 0; i < p.length - 1; i++) if (x <= p[i + 1][0]) { const t = (x - p[i][0]) / ((p[i + 1][0] - p[i][0]) || 1); return p[i][1] + t * (p[i + 1][1] - p[i][1]); }
  return p[p.length - 1][1];
}
function evalCurve(pts, x, method) {
  if (method === 'poly3' && pts.length >= 4) {
    const p = sorted(pts);
    if (x < p[0][0] - 1e-9 || x > p[p.length - 1][0] + 1e-9) return null;
    return polyval(polyfit(p, 3), x);
  }
  return interp(pts, x);
}

/* ---------- chart ---------- */
function curvePath(pts, mode, X, Y) {
  const p = sorted(pts);
  if (p.length < 2) return '';
  let dense = p;
  if (mode === 'poly2' || mode === 'poly3') {
    const deg = Math.min(mode === 'poly2' ? 2 : 3, p.length - 1), c = polyfit(p, deg);
    dense = Array.from({ length: 81 }, (_, i) => { const x = p[0][0] + ((p[p.length - 1][0] - p[0][0]) * i) / 80; return [x, polyval(c, x)]; });
    return 'M' + dense.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' L');
  }
  if (mode === 'spline' && p.length > 2) {                   // Catmull-Rom as Bezier
    let d = `M${X(p[0][0]).toFixed(1)},${Y(p[0][1]).toFixed(1)}`;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], e = p[i + 2] || c;
      d += ` C${X(b[0] + (c[0] - a[0]) / 6).toFixed(1)},${Y(b[1] + (c[1] - a[1]) / 6).toFixed(1)} ${X(c[0] - (e[0] - b[0]) / 6).toFixed(1)},${Y(c[1] - (e[1] - b[1]) / 6).toFixed(1)} ${X(c[0]).toFixed(1)},${Y(c[1]).toFixed(1)}`;
    }
    return d;
  }
  return 'M' + p.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(' L');
}

function chartSvg(s) {
  const W = 1100, H = 720, L = 90, T = 70, B = 100;
  const hasRight = s.series.some((r) => r.axis === 'right'), R = hasRight ? 90 : 40;
  const all = (axis) => s.series.filter((r) => (r.axis === 'right') === (axis === 'right')).flatMap((r) => r.points);
  const xs = [...s.series.flatMap((r) => r.points), ...(s.markers || [])].map((p) => (Array.isArray(p) ? p[0] : p.x));
  const xt = niceTicks(s.xMin ?? Math.min(0, ...xs), s.xMax ?? Math.max(...xs));
  const lefts = [...all('left').map((p) => p[1]), ...(s.markers || []).map((m) => m.y)];
  const yt = niceTicks(s.yMin ?? Math.min(0, ...lefts), s.yMax ?? Math.max(...lefts, 1));
  const rights = all('right').map((p) => p[1]);
  const rt = hasRight ? niceTicks(Math.min(0, ...rights), Math.max(...rights, 1)) : null;
  const X = (v) => L + ((v - xt.min) / (xt.max - xt.min)) * (W - L - R);
  const Yl = (v) => H - B - ((v - yt.min) / (yt.max - yt.min)) * (H - T - B);
  const Yr = (v) => H - B - ((v - rt.min) / (rt.max - rt.min)) * (H - T - B);
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">`, `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (s.title) o.push(text(W / 2, 38, s.title, { size: 22, bold: true }));
  for (const t of xt.ticks) o.push(`<line x1="${X(t)}" y1="${T}" x2="${X(t)}" y2="${H - B}" stroke="#e5e7eb"/>`, text(X(t), H - B + 22, fmt(t), { size: 13 }));
  for (const t of yt.ticks) o.push(`<line x1="${L}" y1="${Yl(t)}" x2="${W - R}" y2="${Yl(t)}" stroke="#e5e7eb"/>`, text(L - 10, Yl(t) + 4, fmt(t), { size: 13, anchor: 'end' }));
  if (rt) for (const t of rt.ticks) o.push(text(W - R + 10, Yr(t) + 4, fmt(t), { size: 13, anchor: 'start' }));
  o.push(`<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="none" stroke="#6b7280"/>`);
  if (s.xLabel) o.push(text((L + W - R) / 2, H - B + 52, s.xLabel, { size: 15 }));
  if (s.yLabel) o.push(text(26, (T + H - B) / 2, s.yLabel, { size: 15, rot: -90 }));
  if (rt && s.yRightLabel) o.push(text(W - 24, (T + H - B) / 2, s.yRightLabel, { size: 15, rot: 90 }));
  s.series.forEach((r, i) => {
    const col = r.color || COLORS[i % COLORS.length], Y = r.axis === 'right' ? Yr : Yl;
    if (r.style === 'points') for (const [x, y] of r.points) o.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="4" fill="${col}"/>`);
    else o.push(`<path d="${curvePath(r.points, r.smooth || 'none', X, Y)}" fill="none" stroke="${col}" stroke-width="2.5"${r.axis === 'right' ? ' stroke-dasharray="7 4"' : ''}/>`);
  });
  for (const m of s.markers || []) o.push(`<circle cx="${X(m.x)}" cy="${Yl(m.y)}" r="6" fill="#111" stroke="#fff" stroke-width="2"/>`, text(X(m.x) + 10, Yl(m.y) - 10, m.label || `${fmt(m.x)}, ${fmt(m.y)}`, { size: 14, anchor: 'start', bold: true }));
  s.series.forEach((r, i) => {                                       // legend
    const col = r.color || COLORS[i % COLORS.length], x = L + 10 + (i % 4) * 250, y = H - 26 + Math.floor(i / 4) * 20;
    o.push(`<line x1="${x}" y1="${y}" x2="${x + 28}" y2="${y}" stroke="${col}" stroke-width="3"/>`, text(x + 36, y + 4, r.name, { size: 13, anchor: 'start' }));
  });
  o.push('</svg>');
  return o.join('\n');
}

/* ---------- well section ---------- */
function wellSvg(s) {
  const ar = s.language === 'ar';
  const T = ar ? { gl: 'سطح الأرض', swl: 'منسوب الماء الساكن', pwl: 'منسوب الماء أثناء الضخ', pump: 'المضخة', riser: 'ماسورة الرفع', dis: 'التفريغ', bot: 'قاع البئر', scr: 'المصفاة' }
    : { gl: 'Ground level', swl: 'Static water level', pwl: 'Pumping water level', pump: 'Pump', riser: 'Riser pipe', dis: 'Discharge', bot: 'Well bottom', scr: 'Screen' };
  const W = 900, H = 820, top = 110, bottom = 60, cx = 330;
  const up = Math.max(s.dischargeHeight || 0.6, 0.4), depth = s.wellDepth;
  const sc = (H - top - bottom) / (depth + up + 1);
  const Y = (d) => top + (d + up) * sc;                         // depth below ground -> pixel
  const cw = Math.max(40, Math.min(110, (s.casingDiameterMm || 300) / 4)), rw = Math.max(8, Math.min(30, (s.riserDiameterMm || 80) / 5));
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Arial, sans-serif">`, `<rect width="${W}" height="${H}" fill="#fff"/>`];
  if (s.title) o.push(text(W / 2, 40, s.title, { size: 22, bold: true }));
  o.push(`<rect x="40" y="${Y(0)}" width="${W - 80}" height="${Y(depth) - Y(0) + 20}" fill="#efe6d8"/>`);                     // soil
  const pl = s.pumpingLevel ?? s.staticLevel;
  o.push(`<rect x="${cx - cw / 2}" y="${Y(s.staticLevel)}" width="${cw}" height="${Y(depth) - Y(s.staticLevel)}" fill="#bfdbfe"/>`,
    `<rect x="${cx - cw / 2}" y="${Y(pl)}" width="${cw}" height="${Y(depth) - Y(pl)}" fill="#93c5fd"/>`);
  o.push(`<rect x="${cx - cw / 2}" y="${Y(0)}" width="${cw}" height="${Y(depth) - Y(0)}" fill="none" stroke="#374151" stroke-width="4"/>`);   // casing
  if (s.screenFrom != null && s.screenTo != null) for (let d = s.screenFrom; d < s.screenTo; d += 0.5) o.push(`<line x1="${cx - cw / 2 - 5}" y1="${Y(d)}" x2="${cx - cw / 2 + 5}" y2="${Y(d)}" stroke="#92400e" stroke-width="3"/>`, `<line x1="${cx + cw / 2 - 5}" y1="${Y(d)}" x2="${cx + cw / 2 + 5}" y2="${Y(d)}" stroke="#92400e" stroke-width="3"/>`);
  o.push(`<line x1="40" y1="${Y(0)}" x2="${W - 40}" y2="${Y(0)}" stroke="#111" stroke-width="3"/>`);                                          // ground
  const pLen = s.pumpLength || Math.min(3, depth / 8), pTop = s.pumpDepth - pLen;
  o.push(`<rect x="${cx - rw / 2}" y="${Y(-(s.dischargeHeight || 0.6))}" width="${rw}" height="${Y(pTop) - Y(-(s.dischargeHeight || 0.6))}" fill="#9ca3af" stroke="#374151"/>`,            // riser
    `<rect x="${cx - cw / 2 + 12}" y="${Y(pTop)}" width="${cw - 24}" height="${Y(s.pumpDepth) - Y(pTop)}" rx="6" fill="#2563eb" stroke="#1e3a8a" stroke-width="2"/>`,                       // pump
    `<line x1="${cx}" y1="${Y(-(s.dischargeHeight || 0.6))}" x2="${cx + 120}" y2="${Y(-(s.dischargeHeight || 0.6))}" stroke="#374151" stroke-width="${rw}"/>`);                         // discharge
  const tri = (y, col) => `<polygon points="${cx + cw / 2 + 14},${y} ${cx + cw / 2 + 30},${y - 8} ${cx + cw / 2 + 30},${y + 8}" fill="${col}"/>`;
  o.push(tri(Y(s.staticLevel), '#1d4ed8'), tri(Y(pl), '#1e3a8a'));
  const dim = (d, label, x) => { o.push(`<line x1="${x}" y1="${Y(0)}" x2="${x}" y2="${Y(d)}" stroke="#6b7280" stroke-dasharray="4 3"/>`, `<line x1="${x - 6}" y1="${Y(d)}" x2="${x + 6}" y2="${Y(d)}" stroke="#374151" stroke-width="2"/>`, text(x + 10, (Y(0) + Y(d)) / 2, label, { size: 14, anchor: 'start' })); };
  dim(s.staticLevel, `${T.swl}: ${fmt(s.staticLevel)} m`, 560);
  if (s.pumpingLevel != null) dim(s.pumpingLevel, `${T.pwl}: ${fmt(s.pumpingLevel)} m`, 640);
  dim(s.pumpDepth, `${T.pump}: ${fmt(s.pumpDepth)} m`, 720);
  dim(depth, `${T.bot}: ${fmt(depth)} m`, 800);
  o.push(text(cx + 130, Y(-(s.dischargeHeight || 0.6)) - 14, T.dis, { anchor: 'start', size: 14, bold: true }), text(40, Y(0) - 8, T.gl + ' 0.00', { anchor: 'start', size: 14, bold: true }),
    text(cx + cw / 2 + 40, Y(pTop) + 6, T.pump, { anchor: 'start', size: 14, bold: true }), text(cx - cw / 2 - 10, Y(pTop) - 20, T.riser, { anchor: 'end', size: 13 }));
  o.push('</svg>');
  return o.join('\n');
}

/* ---------- output ---------- */
async function save(svg, p, ctx) {
  const full = await ctx.access(p, 'write', 'Save a drawing');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (/\.png$/i.test(full)) {
    try {
      const { Resvg } = require('@resvg/resvg-js');
      fs.writeFileSync(full, new Resvg(svg, { fitTo: { mode: 'width', value: 1600 }, font: { loadSystemFonts: true } }).render().asPng());
      return `Saved ${full}`;
    } catch { /* PNG engine not installed: save the SVG instead */ }
    const alt = full.replace(/\.png$/i, '.svg');
    fs.writeFileSync(alt, svg);
    return `PNG is not available here, saved as SVG instead: ${alt}`;
  }
  fs.writeFileSync(/\.svg$/i.test(full) ? full : full + '.svg', svg);
  return `Saved ${/\.svg$/i.test(full) ? full : full + '.svg'}`;
}

module.exports = {
  tools: {
    async plot(a, ctx) {
      if (!Array.isArray(a.series) || !a.series.some((r) => r.points && r.points.length)) throw new Error('No data points to draw.');
      return save(chartSvg(a), a.path, ctx);
    },
    async system_curve({ flow, head, staticHead = 0, maxFlow }) {
      const k = (head - staticHead) / (flow * flow), top = maxFlow || flow * 1.4;
      return { k, points: Array.from({ length: 21 }, (_, i) => { const q = (top * i) / 20; return [+q.toFixed(3), +(staticHead + k * q * q).toFixed(3)]; }) };
    },
    async pump_select({ flow, head, maxExcessPercent = 15, method = 'linear', pumps }) {
      const rows = [];
      for (const p of pumps) {
        const h = evalCurve(p.curve, flow, method);
        if (h == null) { rows.push({ model: p.model, ok: false, note: `The duty flow ${flow} is outside this pump's curve.` }); continue; }
        const excess = ((h - head) / head) * 100;
        const eff = p.efficiency ? evalCurve(p.efficiency, flow, method) : null;
        rows.push({ model: p.model, headAtDuty: +h.toFixed(2), excessPercent: +excess.toFixed(1), efficiency: eff == null ? null : +eff.toFixed(1),
          flowVsBepPercent: p.bepFlow ? +((flow / p.bepFlow) * 100).toFixed(0) : null, ok: excess >= 0 && excess <= maxExcessPercent,
          note: excess < 0 ? 'Head is too low at this flow.' : excess > maxExcessPercent ? 'Head is much higher than needed (throttling or a smaller pump is better).' : 'Suitable.' });
      }
      const good = rows.filter((r) => r.ok).sort((a, b) => a.excessPercent - b.excessPercent || (b.efficiency || 0) - (a.efficiency || 0));
      return { duty: { flow, head }, suitable: good, others: rows.filter((r) => !r.ok) };
    },
    async well_section(a, ctx) {
      if (!(a.wellDepth > 0) || !(a.pumpDepth > 0) || a.pumpDepth > a.wellDepth) throw new Error('Check the depths: the pump must be inside the well.');
      return save(wellSvg(a), a.path, ctx);
    },
  },
  _test: { chartSvg, wellSvg, evalCurve, niceTicks, polyfit },
};
