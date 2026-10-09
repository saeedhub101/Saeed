import { h, fmtBytes, fmtEta } from './ui.js';
const api = window.api;
const box = document.getElementById('box');
let st = await api.updateGet();

const btn = (label, fn, cls = 'btn') => h('button', { class: cls, onclick: fn }, label);
const close = () => api.updateAction('close');

function paint() {
  const cur = st.current;
  let kids;
  switch (st.state) {
    case 'checking':
      kids = [h('h2', {}, 'Checking for updates'), h('p', { class: 'muted' }, h('span', { class: 'spin' }), 'Please wait…')];
      break;
    case 'none':
      kids = [h('h2', {}, 'You are up to date'), h('p', { class: 'muted' }, `Saeed ${cur} is the newest version.`), h('div', { class: 'actions' }, btn('Close', close, 'btn primary'))];
      break;
    case 'available':
      kids = [h('h2', {}, `Saeed ${st.version} is available`), h('p', { class: 'muted' }, `You have ${cur}.${st.size ? ' Download size: ' + fmtBytes(st.size) + '.' : ''}`),
        st.notes ? h('div', { class: 'notes', dir: 'auto' }, st.notes) : null,
        h('div', { class: 'actions' }, btn('Later', close), btn('Update now', () => api.updateAction('download'), 'btn primary'))];
      break;
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, st.percent || 0));
      kids = [h('h2', {}, `Downloading Saeed ${st.version || ''}`),
        h('div', { class: 'bar' }, h('div', { style: `width:${pct}%` })),
        h('p', {}, `${pct.toFixed(0)}%   ${fmtBytes(st.transferred || 0)} of ${fmtBytes(st.total || 0)}`),
        h('p', { class: 'muted' }, [st.bps ? `${fmtBytes(st.bps)}/s` : '', fmtEta(st.eta)].filter(Boolean).join('  ·  '))];
      break;
    }
    case 'ready':
      kids = [h('h2', {}, 'Update ready'), h('p', { class: 'muted' }, 'Saeed will close, install the update and start again.'),
        h('div', { class: 'actions' }, btn('Later', close), btn('Restart and install', () => api.updateAction('install'), 'btn primary'))];
      break;
    case 'dev':
      kids = [h('h2', {}, 'Updates'), h('p', { class: 'muted' }, 'Updates work in the installed version of Saeed (not when started with npm start).'), h('div', { class: 'actions' }, btn('Close', close, 'btn primary'))];
      break;
    case 'error':
      kids = [h('h2', {}, 'Could not check for updates'), h('p', { class: 'warn' }, st.error || 'Unknown error'),
        h('p', { class: 'muted' }, 'Check your internet connection and the GitHub repository set in the build.'),
        h('div', { class: 'actions' }, btn('Close', close), btn('Try again', () => api.updateAction('check'), 'btn primary'))];
      break;
    default:
      kids = [h('h2', {}, 'Updates'), h('div', { class: 'actions' }, btn('Check for updates', () => api.updateAction('check'), 'btn primary'))];
  }
  box.replaceChildren(...kids.filter(Boolean));
}
paint();
api.onUpdateState((s) => { st = s; paint(); });
