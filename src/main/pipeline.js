'use strict';
// Orchestrates one conversation turn: text -> (local command | brain) -> speech.
// The brain's answer is streamed: each finished sentence is turned into speech while the model keeps writing.
const providers = require('./providers');
const brain = require('./brain');
const actions = require('./actions');
const perms = require('./permissions');

let bus, getSettings, canSpeak, isActive, job = null;
function init(o) { ({ bus, getSettings, canSpeak, isActive } = o); }

function cancel() {
  if (job) { job.ctrl.abort(); job = null; }
  perms.endTask();
  if (bus) bus.avatar({ type: 'cancel' });
}

// Cuts streamed text into sentences. The first one may be short so Saeed starts speaking sooner.
function makeSentencer() {
  let buf = '', first = true;
  const pull = (force) => {
    const out = [];
    for (;;) {
      const re = /[.!?؟…]+["')\]]*\s|\n/g;
      re.lastIndex = Math.min(first ? 12 : 28, buf.length);
      const m = re.exec(buf);
      if (!m) break;
      const end = m.index + m[0].length;
      out.push(buf.slice(0, end).trim()); buf = buf.slice(end); first = false;
    }
    if (force && buf.trim()) { out.push(buf.trim()); buf = ''; }
    return out.filter(Boolean);
  };
  return { push: (d) => { buf += d; return pull(false); }, flush: () => pull(true) };
}

function startSpeech(signal, s) {
  const muted = s.audio.muted || !canSpeak();
  const showBubble = muted || s.audio.bubbleAlways;
  const sys = s.tts.provider === 'system';
  const sentencer = makeSentencer();
  let started = false, total = '', chain = Promise.resolve();

  const begin = () => { if (!started) { started = true; bus.avatar({ type: 'speak-start', text: '', muted }); } };
  const emit = (sentence) => {
    if (muted) return;
    if (sys) { bus.avatar({ type: 'tts-text', sentences: [sentence] }); return; }
    chain = chain.then(async () => {
      if (signal.aborted) return;
      const a = await providers.synthesize(s, sentence, { signal });
      if (!signal.aborted) bus.avatar({ type: 'audio', mime: a.mime, bytes: a.bytes, text: sentence });
    });
  };
  return {
    push(delta) {
      if (!delta) return;
      begin(); total += delta;
      if (showBubble) bus.avatar({ type: 'bubble', text: total });
      for (const sentence of sentencer.push(delta)) emit(sentence);
    },
    async end() {
      if (!started && !total) return;
      begin();
      for (const sentence of sentencer.flush()) emit(sentence);
      await chain;
      if (signal.aborted) return;
      bus.avatar({ type: 'speak-end', muted, length: total.length });
    },
  };
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
  const speech = startSpeech(ctrl.signal, s);
  try {
    let reply;
    const local = !images.length && (s.commands.local || actions.isGreeting(text)) ? await actions.route(text, s) : null;
    if (local) {
      reply = local.reply;
      if (local.intent) bus.avatar({ type: 'intent', name: local.intent });
      brain.remember(text, reply);
      speech.push(reply);
    } else {
      reply = (await brain.ask(text, {
        signal: ctrl.signal, settings: s, images,
        onIntent: (n) => bus.avatar({ type: 'intent', name: n }),
        onTool: (t) => bus.chat({ type: 'tool', text: `${t.name} ${JSON.stringify(t.args).slice(0, 140)}` }),
        onText: (d) => { if (ctrl.signal.aborted) return; speech.push(d); bus.chat({ type: 'delta', text: d }); },
      })).text;
    }
    if (ctrl.signal.aborted) return;
    bus.chat({ type: 'message', role: 'assistant', text: reply });
    bus.chat({ type: 'state', text: '' });
    await speech.end();
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const msg = String(e && e.message || e);
    bus.chat({ type: 'error', text: msg });
    bus.chat({ type: 'state', text: '' });
    bus.avatar({ type: 'error', text: msg.slice(0, 160) });
  } finally {
    if (job === me) { job = null; perms.endTask(); }
  }
}

// Speak a fixed sentence (announcements, tests) without asking the brain.
async function say(text) {
  if (!isActive()) return;
  cancel();
  const ctrl = new AbortController();
  job = { ctrl };
  try { const sp = startSpeech(ctrl.signal, getSettings()); sp.push(text); await sp.end(); }
  catch (e) { bus.avatar({ type: 'error', text: String(e.message || e).slice(0, 160) }); }
}

module.exports = { init, handleText, say, cancel };
