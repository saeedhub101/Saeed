'use strict';
// Live (realtime) conversation over a WebSocket: OpenAI Realtime, or any server that speaks the same protocol.
// Audio goes through the main process so API keys never reach a window.
const secrets = require('./secrets');
const brain = require('./brain');

let ws = null, bus = null, rate = 24000, lastUser = '', ready = false, ctx = null;

const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };

function sessionUpdate(r, p, s) {
  const tools = brain.toolDefs(s).map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }));
  const instructions = r.instructions || brain.defaultPrompt();
  if (p.protocol === 'beta') {
    return { type: 'session.update', session: {
      modalities: ['text', 'audio'], instructions, voice: p.voice, input_audio_format: 'pcm16', output_audio_format: 'pcm16',
      input_audio_transcription: { model: p.transcribeModel || 'whisper-1' }, turn_detection: { type: 'server_vad' }, tools, tool_choice: 'auto' } };
  }
  return { type: 'session.update', session: {
    type: 'realtime', instructions, output_modalities: ['audio'], tools, tool_choice: 'auto',
    audio: {
      input: { format: { type: 'audio/pcm', rate }, transcription: p.transcribeModel ? { model: p.transcribeModel } : undefined, turn_detection: { type: 'server_vad' } },
      output: { format: { type: 'audio/pcm', rate }, voice: p.voice },
    } } };
}

async function runTool(ev) {
  let args = {};
  try { args = JSON.parse(ev.arguments || '{}'); } catch { /* empty */ }
  const s = ctx.getSettings();
  const out = await brain.execTool(s, ev.name, args, {
    onIntent: (n) => bus.avatar({ type: 'intent', name: n }),
    onTool: (t) => bus.chat({ type: 'tool', text: `${t.name} ${JSON.stringify(t.args).slice(0, 140)}` }),
  });
  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: String(out) } });
  send({ type: 'response.create' });
}

async function onEvent(ev) {
  switch (ev.type) {
    case 'session.created': case 'session.updated':
      if (!ready) { ready = true; bus.avatar({ type: 'rt-state', state: 'ready', rate }); }
      break;
    case 'response.output_audio.delta': case 'response.audio.delta':
      bus.avatar({ type: 'rt-audio', pcm: Buffer.from(ev.delta, 'base64'), rate });
      break;
    case 'input_audio_buffer.speech_started':
      bus.avatar({ type: 'rt-interrupt' }); bus.chat({ type: 'state', text: 'listening…' });
      break;
    case 'conversation.item.input_audio_transcription.completed':
      lastUser = ev.transcript || '';
      if (lastUser.trim()) bus.chat({ type: 'message', role: 'user', text: lastUser.trim(), source: 'voice' });
      break;
    case 'response.output_audio_transcript.done': case 'response.audio_transcript.done':
      if (ev.transcript) {
        bus.chat({ type: 'message', role: 'assistant', text: ev.transcript }); bus.chat({ type: 'state', text: '' });
        bus.avatar({ type: 'rt-text', text: ev.transcript });
        if (lastUser.trim()) brain.remember(lastUser.trim(), ev.transcript);
        lastUser = '';
      }
      break;
    case 'response.function_call_arguments.done': await runTool(ev); break;
    case 'response.done': bus.avatar({ type: 'rt-done' }); break;
    case 'error': bus.chat({ type: 'error', text: 'Realtime: ' + ((ev.error && ev.error.message) || 'error') }); break;
    default: break;
  }
}

async function start(o) {
  stop();
  ctx = o; bus = o.bus; ready = false; lastUser = '';
  const s = o.getSettings(), r = s.realtime;
  if (r.provider === 'off') throw new Error('Realtime is off. Choose a provider in Settings → Live conversation.');
  const p = r.provider === 'custom' ? r.custom : r.openai;
  let url, headers = {};
  if (r.provider === 'openai') {
    const key = secrets.get('openai');
    if (!key) throw new Error('Add your OpenAI key (Settings → Brain, OpenAI).');
    url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(p.model)}`;
    headers.Authorization = `Bearer ${key}`;
    if (p.protocol === 'beta') headers['OpenAI-Beta'] = 'realtime=v1';
  } else {
    if (!p.url) throw new Error('Enter the realtime address in Settings → Live conversation.');
    url = p.url + (p.model ? (p.url.includes('?') ? '&' : '?') + 'model=' + encodeURIComponent(p.model) : '');
    const key = secrets.get('realtime-custom');
    if (key) headers[p.authHeader || 'Authorization'] = (p.authPrefix ?? 'Bearer ') + key;
    try { Object.assign(headers, p.headers ? JSON.parse(p.headers) : {}); } catch { throw new Error('Extra headers must be valid JSON.'); }
  }
  rate = Number(p.sampleRate) || 24000;
  const WebSocket = require('ws');
  const sock = (ws = new WebSocket(url, { headers }));
  await new Promise((resolve, reject) => {
    sock.once('open', resolve);
    sock.once('error', reject);
    sock.once('unexpected-response', (_q, res) => reject(new Error('The server refused the connection (HTTP ' + res.statusCode + ').')));
  });
  sock.on('message', (d) => { let ev; try { ev = JSON.parse(String(d)); } catch { return; } onEvent(ev).catch((e) => bus.chat({ type: 'error', text: 'Realtime: ' + e.message })); });
  sock.on('close', () => { if (ws === sock) { ws = null; bus.avatar({ type: 'rt-state', state: 'closed' }); } });
  sock.on('error', (e) => bus.chat({ type: 'error', text: 'Realtime: ' + e.message }));
  send(sessionUpdate(r, p, s));
  return { rate };
}

function audio(buf) { send({ type: 'input_audio_buffer.append', audio: Buffer.from(buf).toString('base64') }); }
function interrupt() { send({ type: 'response.cancel' }); }
function stop() { if (ws) { const w = ws; ws = null; try { w.close(); } catch { /* closed */ } } }
const active = () => !!ws;

module.exports = { start, stop, audio, interrupt, active };
