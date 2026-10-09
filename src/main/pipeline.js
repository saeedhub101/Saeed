'use strict';
// Orchestrates one conversation turn: text -> (local command | brain) -> speech. Voice and chat share it.
const providers = require('./providers');
const brain = require('./brain');
const actions = require('./actions');

let bus, getSettings, canSpeak, isActive, job = null;

function init(o) { ({ bus, getSettings, canSpeak, isActive } = o); }

function cancel() {
  if (job) { job.ctrl.abort(); job = null; }
  if (bus) bus.avatar({ type: 'cancel' });
}

function splitSentences(t) {
  const parts = t.split(/(?<=[.!?؟…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = []; let buf = '';
  for (const p of parts) { buf = buf ? buf + ' ' + p : p; if (buf.length >= 25) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out;
}

async function speak(text, signal) {
  const s = getSettings();
  const muted = s.audio.muted || !canSpeak();
  bus.avatar({ type: 'speak-start', text, muted });
  if (muted) { bus.avatar({ type: 'speak-end', muted: true }); return; }
  const sentences = splitSentences(text);
  if (s.tts.provider === 'system') { bus.avatar({ type: 'tts-text', sentences }); return; }
  for (const sentence of sentences) {
    if (signal.aborted) return;
    const a = await providers.synthesize(s, sentence, { signal });
    if (signal.aborted) return;
    bus.avatar({ type: 'audio', mime: a.mime, bytes: a.bytes });
  }
  bus.avatar({ type: 'speak-end' });
}

async function handleText(text, source = 'chat', images = []) {
  text = String(text || '').trim();
  if (!text && !images.length) return;
  if (!text) text = '(see the attached image)';
  if (!isActive()) return;
  cancel();
  const ctrl = new AbortController();
  const me = { ctrl };
  job = me;
  const s = getSettings();
  bus.chat({ type: 'message', role: 'user', text: images.length ? `${text}  [${images.length} image${images.length > 1 ? 's' : ''}]` : text, source });
  bus.chat({ type: 'state', text: 'thinking…' });
  bus.avatar({ type: 'thinking' });
  try {
    let reply;
    const local = s.commands.local && !images.length ? await actions.route(text, s) : null;
    if (local) {
      reply = local.reply;
      if (local.intent) bus.avatar({ type: 'intent', name: local.intent });
      brain.remember(text, reply);
    } else {
      reply = (await brain.ask(text, {
        signal: ctrl.signal, settings: s, images,
        onIntent: (n) => bus.avatar({ type: 'intent', name: n }),
        onTool: (t) => bus.chat({ type: 'tool', text: `${t.name} ${JSON.stringify(t.args).slice(0, 140)}` }),
      })).text;
    }
    if (ctrl.signal.aborted) return;
    bus.chat({ type: 'message', role: 'assistant', text: reply });
    bus.chat({ type: 'state', text: '' });
    if (reply) await speak(reply, ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const msg = String(e && e.message || e);
    bus.chat({ type: 'error', text: msg });
    bus.chat({ type: 'state', text: '' });
    bus.avatar({ type: 'error', text: msg.slice(0, 160) });
  } finally {
    if (job === me) job = null;
  }
}

// Speak a fixed sentence (announcements, tests) without asking the brain.
async function say(text) {
  if (!isActive()) return;
  cancel();
  const ctrl = new AbortController();
  job = { ctrl };
  try { await speak(text, ctrl.signal); }
  catch (e) { bus.avatar({ type: 'error', text: String(e.message || e).slice(0, 160) }); }
}

module.exports = { init, handleText, say, cancel };
