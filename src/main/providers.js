'use strict';
// Speech-to-text and text-to-speech over HTTP. Keys come from secrets.js.
const secrets = require('./secrets');
const addons = require('./addons');
const { encodeWav } = require('./wav');

const trim = (u) => String(u || '').replace(/\/+$/, '');
const bearer = (name) => { const k = secrets.get(name); return k ? { Authorization: `Bearer ${k}` } : {}; };
async function ok(r, label) {
  if (r.ok) return r;
  let t = ''; try { t = (await r.text()).slice(0, 300); } catch { /* ignore */ }
  throw new Error(`${label} ${r.status}: ${t}`);
}

async function transcribe(s, f32, { signal } = {}) {
  const c = s.stt;
  const lang = c.language === 'auto' ? undefined : c.language;
  if (c.provider.startsWith('addon:')) return String(await addons.callProvider('stt', c.provider, { pcm: f32, language: lang }, signal) || '').trim();
  const fd = new FormData();
  fd.append('file', new Blob([encodeWav(f32, 16000)], { type: 'audio/wav' }), 'speech.wav');
  if (c.provider === 'elevenlabs') {
    fd.append('model_id', c.elevenlabs.model || 'scribe_v1');
    if (lang) fd.append('language_code', lang);
    const r = await ok(await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': secrets.get('elevenlabs') }, body: fd, signal }), 'ElevenLabs STT');
    return String((await r.json()).text || '').trim();
  }
  const p = c[c.provider];
  fd.append('model', p.model);
  if (lang) fd.append('language', lang);
  const r = await ok(await fetch(`${trim(p.baseUrl)}/audio/transcriptions`, { method: 'POST', headers: bearer(c.provider), body: fd, signal }), 'STT');
  return String((await r.json()).text || '').trim();
}

async function synthesize(s, text, { signal } = {}) {
  const c = s.tts;
  if (c.provider.startsWith('addon:')) {
    const r = await addons.callProvider('tts', c.provider, { text }, signal);
    return { mime: r.mime, bytes: Buffer.from(r.bytes) };
  }
  if (c.provider === 'elevenlabs') {
    const e = c.elevenlabs;
    if (!e.voiceId) throw new Error('ElevenLabs voice id is empty (Settings → Voice).');
    const r = await ok(await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(e.voiceId)}?output_format=mp3_44100_128`, {
      method: 'POST', signal,
      headers: { 'xi-api-key': secrets.get('elevenlabs'), 'content-type': 'application/json' },
      body: JSON.stringify({ text, model_id: e.model || 'eleven_multilingual_v2' }),
    }), 'ElevenLabs TTS');
    return { mime: 'audio/mpeg', bytes: Buffer.from(await r.arrayBuffer()) };
  }
  if (c.provider === 'openai' || c.provider === 'custom') {
    const p = c[c.provider];
    const r = await ok(await fetch(`${trim(p.baseUrl)}/audio/speech`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...bearer(c.provider) },
      body: JSON.stringify({ model: p.model, voice: p.voice, input: text, response_format: 'mp3' }),
    }), 'TTS');
    return { mime: 'audio/mpeg', bytes: Buffer.from(await r.arrayBuffer()) };
  }
  throw new Error('The system voice is played inside the window.');
}

module.exports = { transcribe, synthesize };
