import { h } from './ui.js';
const api = window.api;
const $ = (id) => document.getElementById(id);
const list = $('list'), input = $('input'), stateEl = $('state');

function add(role, text, voice) {
  list.append(h('div', { class: `msg ${role}${voice ? ' voice' : ''}`, dir: 'auto' }, text));
  list.scrollTop = list.scrollHeight;
}
for (const m of await api.chatHistory()) add(m.role, m.text);

api.onChatEvent((ev) => {
  if (ev.type === 'message') add(ev.role, ev.text, ev.source === 'voice' && ev.role === 'user');
  else if (ev.type === 'state') stateEl.textContent = ev.text || '';
  else if (ev.type === 'error') add('error', ev.text);
  else if (ev.type === 'tool') add('tool', '⚙ ' + ev.text);
});

let images = [];
function drawThumbs() {
  $('thumbs').replaceChildren(...images.map((im, i) => h('div', {}, h('img', { src: `data:${im.mime};base64,${im.data}` }), h('button', { onclick: () => { images.splice(i, 1); drawThumbs(); } }, '×'))));
}
// Large pictures are scaled down (long side 1800 px) so they are fast and cheap to send.
async function addImage(file) {
  if (!file || !file.type.startsWith('image/') || images.length >= 4) return;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  images.push({ mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.92).split(',')[1] });
  drawThumbs();
}
$('attach').onclick = () => $('file').click();
$('file').onchange = async (e) => { for (const f of e.target.files) await addImage(f); e.target.value = ''; };
input.addEventListener('paste', async (e) => {
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); for (const f of files) await addImage(f); }
});

function send() {
  const t = input.value.trim();
  if (!t && !images.length) return;
  api.chatSend(t, images);
  input.value = ''; images = []; drawThumbs();
}
$('send').onclick = send;
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('stop').onclick = () => api.chatCancel();
$('clear').onclick = async () => { await api.chatClear(); list.replaceChildren(); };
input.focus();
