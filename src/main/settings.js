'use strict';
// Defaults for everything configurable in the Settings window.
const DEFAULT_SETTINGS = {
  stt: {
    provider: 'openai',                // openai | custom | elevenlabs | addon:<id> (for example the Whisper add-on)
    language: 'auto',                  // auto | ar | en
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
    custom: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
    elevenlabs: { model: 'scribe_v1' },
  },
  llm: {
    provider: 'anthropic',             // anthropic | openai | custom
    maxTurns: 12,
    systemPrompt: '',
    anthropic: { model: 'claude-sonnet-5-5' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    custom: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
  },
  tts: {
    provider: 'system',                // system | openai | custom | elevenlabs | addon:<id>
    system: { voice: '', rate: 1, pitch: 1 },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    custom: { baseUrl: '', model: '', voice: '' },
    elevenlabs: { voiceId: '', model: 'eleven_multilingual_v2' },
  },
  audio: {
    micRms: 0.06,          // voice level that starts listening to you
    interruptRms: 0.18,    // voice level that makes Saeed stop talking
    silenceMs: 900,        // silence that ends your sentence
    minSpeechMs: 350,      // shorter sounds are ignored
    interruptMs: 150,      // how long you must be loud to interrupt him
    micGain: 1,
    volume: 1,             // output volume 0..1
    muted: false,          // muted: no sound, words shown in the bubble
    bubbleAlways: false,
  },
  prayer: { enabled: false, city: 'Amman', country: 'Jordan', method: 23, adhanFile: '', adhanVolume: 1, pose: true },
  realtime: {
    provider: 'off',                   // off | openai | custom
    instructions: '',
    openai: { model: 'gpt-realtime', voice: 'alloy', protocol: 'ga', transcribeModel: 'gpt-4o-mini-transcribe', sampleRate: 24000 },
    custom: { url: '', model: '', voice: '', protocol: 'ga', transcribeModel: '', sampleRate: 24000, authHeader: 'Authorization', authPrefix: 'Bearer ', headers: '' },
  },
  agent: {
    confirm: 'writes',                 // writes | always | never : ask before actions that change things
    allowedFolders: [],                // empty = Documents, Desktop, Downloads
    addonIdleSeconds: 90,              // an idle add-on is stopped after this long
  },
  updates: { repo: '', autoCheck: true },
  addons: { registryUrl: '', enabled: {}, settings: {}, trusted: {} },
  performance: { idleFps: 12 },
  commands: { local: true },
  launcher: [],            // [{ names: 'payroll, الرواتب', path: 'C:\\...\\salaries.xlsx' }]
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function merge(base, over) {
  const out = structuredClone(base);
  (function m(a, b) {
    for (const k of Object.keys(b || {})) {
      if (isObj(a[k]) && isObj(b[k])) m(a[k], b[k]); else a[k] = b[k];
    }
  })(out, over || {});
  return out;
}
module.exports = { DEFAULT_SETTINGS, merge };
