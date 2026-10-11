'use strict';
// A real browser driven through Playwright, using the Edge or Chrome that is already installed (nothing to download).
// The page is shown to the model as a short numbered list of what can be clicked or typed, which is cheaper and more
// reliable than screenshots. Everything is closed when the add-on goes idle.
const fs = require('fs');
const path = require('path');

const st = { context: null, page: null, visible: false };

function findBrowser(channel) {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local = process.env.LOCALAPPDATA || '';
  const edge = [path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'), path.join(pf, 'Microsoft/Edge/Application/msedge.exe')];
  const chrome = [path.join(pf, 'Google/Chrome/Application/chrome.exe'), path.join(pf86, 'Google/Chrome/Application/chrome.exe'), path.join(local, 'Google/Chrome/Application/chrome.exe')];
  const order = channel === 'chrome' ? [...chrome, ...edge] : channel === 'msedge' ? [...edge, ...chrome] : [...edge, ...chrome];
  return order.find((p) => fs.existsSync(p)) || null;
}

async function launch(ctx, visible) {
  if (st.context && st.visible !== visible) await close();            // switching between hidden and visible restarts it (the profile is kept)
  if (st.context) return;
  const { chromium } = require('playwright-core');
  const exe = ctx.settings.executablePath || findBrowser(ctx.settings.channel);
  if (!exe) throw new Error('Microsoft Edge or Google Chrome was not found. Install one, or set the browser program in this add-on\'s settings.');
  st.context = await chromium.launchPersistentContext(path.join(ctx.dataDir, 'profile'), {
    executablePath: exe, headless: !visible, viewport: { width: 1280, height: 860 }, locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'], ignoreDefaultArgs: ['--enable-automation'],
  });
  st.visible = visible;
  st.page = st.context.pages()[0] || (await st.context.newPage());
  st.context.on('page', (p) => { st.page = p; });
}
async function close() {
  const c = st.context;
  st.context = st.page = null;
  if (c) { try { await c.close(); } catch { /* already closed */ } }
}
const need = () => { if (!st.page) throw new Error('The browser is not open. Use open first.'); return st.page; };

// Runs inside the page: numbers the visible interactive elements and returns them with the text of the page.
function readPage(maxChars) {
  document.querySelectorAll('[data-sd]').forEach((e) => e.removeAttribute('data-sd'));
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 3; };
  const label = (el) => (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('name') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 90);
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=menuitem],[role=tab],[role=option],[role=combobox],summary,[contenteditable=true]';
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, 250);
  const lines = els.map((el, i) => {
    const id = i + 1; el.setAttribute('data-sd', id);
    const tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    let kind = tag === 'a' ? 'link' : tag === 'button' || el.getAttribute('role') === 'button' ? 'button' : tag === 'select' ? 'dropdown' : tag === 'textarea' ? 'textbox' : tag === 'input' ? (['checkbox', 'radio', 'submit', 'button'].includes(type) ? type : type === 'password' ? 'password field' : 'field') : el.getAttribute('role') || tag;
    let extra = '';
    if (tag === 'input' && type !== 'password' && el.value && !['checkbox', 'radio', 'submit', 'button'].includes(type)) extra += ` value="${el.value.slice(0, 40)}"`;
    if ((type === 'checkbox' || type === 'radio') && el.checked) extra += ' (checked)';
    if (el.disabled) extra += ' (disabled)';
    if (tag === 'a') extra += ` -> ${(el.getAttribute('href') || '').slice(0, 70)}`;
    if (tag === 'select') extra += ' options: ' + [...el.options].slice(0, 12).map((o) => o.text.trim()).join(' | ');
    return `[${id}] ${kind} "${label(el)}"${extra}`;
  });
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
  return { title: document.title, url: location.href, lines, text: text.slice(0, maxChars) };
}
async function snap(maxChars = 6000) {
  const page = need();
  try { await page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch { /* still loading */ }
  const r = await page.evaluate(readPage, Math.min(8000, maxChars));
  return `Page: ${r.title}\nAddress: ${r.url}\n\nElements:\n${r.lines.join('\n') || '(none visible)'}\n\nText:\n${r.text}`;
}
const target = (id) => need().locator(`[data-sd="${id}"]`).first();
async function fillSecrets(text, ctx) {
  let out = String(text);
  for (const m of [...out.matchAll(/\{\{secret:([^}]+)\}\}/g)]) out = out.replace(m[0], (await ctx.secret(m[1])) || '');
  return out;
}

module.exports = {
  tools: {
    async open({ url, visible = false }, ctx) {
      await launch(ctx, !!visible);
      await st.page.goto(/^https?:/i.test(url) ? url : 'https://' + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return snap();
    },
    async snapshot({ maxChars } = {}) { return snap(maxChars); },
    async click({ id }) {
      const el = target(id);
      await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await el.click({ timeout: 8000 });
      await need().waitForTimeout(700);
      return snap(4000);
    },
    async type({ id, text, submit, append }, ctx) {
      const el = target(id), value = await fillSecrets(text, ctx);
      await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      if (append) await el.pressSequentially(value, { delay: 25 }); else await el.fill(value, { timeout: 8000 });
      if (submit) await el.press('Enter');
      await need().waitForTimeout(submit ? 1200 : 300);
      return snap(4000);
    },
    async select({ id, option }) {
      const el = target(id);
      try { await el.selectOption({ label: option }, { timeout: 5000 }); } catch { await el.selectOption({ value: option }, { timeout: 5000 }); }
      return snap(3000);
    },
    async press({ key }) { await need().keyboard.press(key); await need().waitForTimeout(600); return snap(4000); },
    async scroll({ amount = 1 }) { await need().mouse.wheel(0, Math.round(amount * 800)); await need().waitForTimeout(400); return snap(4000); },
    async goto({ url }) {
      const page = need();
      if (url === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
      else await page.goto(/^https?:/i.test(url) ? url : 'https://' + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      return snap(4000);
    },
    async wait({ ms, text }) {
      const page = need();
      if (text) await page.getByText(text).first().waitFor({ timeout: Math.min(30000, ms || 15000) });
      else await page.waitForTimeout(Math.min(15000, ms || 1000));
      return snap(3000);
    },
    async screenshot({ fullPage }) {
      const buf = await need().screenshot({ type: 'jpeg', quality: 80, fullPage: !!fullPage });
      return { text: `Screenshot of ${await need().title()}`, image: { mime: 'image/jpeg', data: buf.toString('base64') } };
    },
    async extract({ selector, maxChars = 12000 }) {
      const page = need();
      const t = selector ? await page.locator(selector).first().innerText({ timeout: 8000 }) : await page.evaluate(() => document.body.innerText);
      return t.length > maxChars ? t.slice(0, maxChars) + '\n…(truncated)' : t;
    },
    async tabs({ action, index, url }, ctx) {
      if (!st.context) throw new Error('The browser is not open. Use open first.');
      const pages = st.context.pages();
      if (action === 'new') { st.page = await st.context.newPage(); if (url) await st.page.goto(url, { waitUntil: 'domcontentloaded' }); return snap(3000); }
      if (action === 'switch') { st.page = pages[Math.max(0, Math.min(pages.length - 1, index || 0))]; await st.page.bringToFront(); return snap(3000); }
      if (action === 'close') { const p = pages[index ?? pages.indexOf(st.page)]; if (p) await p.close(); st.page = st.context.pages()[0] || null; return 'Closed.'; }
      return (await Promise.all(pages.map(async (p, i) => `${i}${p === st.page ? '*' : ''}: ${await p.title()} (${p.url()})`))).join('\n');
    },
    async close() { await close(); return 'Browser closed.'; },
  },
  async deactivate() { await close(); },
};
