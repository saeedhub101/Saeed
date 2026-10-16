'use strict';
// Defaults for everything configurable in the Settings window.
const DEFAULT_SETTINGS = {
  stt: {
    provider: 'addon:whisper-local',    // offline-first; cloud STT remains optional
    language: 'auto',                  // auto | ar | en
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
    custom: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3' },
    elevenlabs: { model: 'scribe_v1' },
  },
  llm: {
    provider: 'openai',                // anthropic | openai | custom
    maxTurns: 12,
    reasoningEffort: 'max',           // low | medium | high | xhigh | max; maximize GPT-6 reasoning
    systemPrompt: '',
    anthropic: { model: 'claude-sonnet-5' },
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' },
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
    addonIdleSeconds: 90,              // an idle add-on is stopped after this long
    maxSteps: 25,                      // tool steps allowed for one request (screen work needs many)
  },
  procedures: [],                      // [{ name, keywords: 'insurance, policy', text }] how to work in your company systems
  // What Saeed may do (caps) and where (locations). Modes: ask | allow | deny.
  // Shipped wide open, by this user's explicit choice: Saeed should not be stopped by default, this is a personal
  // assistant on the owner's own PC. The one exception left is "dangerous" below - wiping a whole drive or the
  // Windows folder - which needs its own separate switch so one bad command can't erase the system. Settings →
  // Permissions has a one-click "Restore safe restrictions" button for anyone who wants the cautious defaults back.
  permissions: {
    caps: {
      'files.read': 'allow', 'files.write': 'allow', 'files.delete': 'allow', 'files.deletePermanent': 'allow',
      'apps.open': 'allow', 'system.run': 'allow', 'desktop.control': 'allow', 'network': 'allow',
      'web.read': 'allow', 'web.send': 'allow', 'browser.control': 'allow', 'data.read': 'allow', 'data.write': 'allow',
    },
    defaultLocation: 'allow',          // places that match no rule below
    locations: [
      { path: '~/Documents', mode: 'allow' }, { path: '~/Desktop', mode: 'allow' }, { path: '~/Downloads', mode: 'allow' }, { path: '~/Pictures', mode: 'allow' },
      { path: '%OneDrive%/Documents', mode: 'allow' }, { path: '%OneDrive%/Desktop', mode: 'allow' },
      { path: '%SystemRoot%', mode: 'allow' }, { path: '%ProgramFiles%', mode: 'allow' }, { path: '%ProgramFiles(x86)%', mode: 'allow' },
      { path: '%ProgramData%', mode: 'allow' }, { path: '%APPDATA%', mode: 'allow' }, { path: '%LOCALAPPDATA%', mode: 'allow' },
    ],
    grants: {},                        // { addonId: { 'files.write': true } } set by "Always allow"
    dangerous: false,                  // allow deleting drive roots, the Windows folder and the user profile folder - its own switch, not part of the reset below
  },
  updates: { repo: 'saeedhub101/Saeed', autoCheck: true },
  ui: { language: 'en' },
  addons: { registryUrl: '', sources: [], enabled: { 'whisper-local': true }, settings: {}, trusted: {}, removed: [] },
  performance: { idleFps: 12 },
  web: { search: 'duckduckgo', maxResults: 6, fetchMaxChars: 12000 },   // duckduckgo (no key) | brave | tavily
  memory: { enabled: true },
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
