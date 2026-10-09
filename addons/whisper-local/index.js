'use strict';
const path = require('path');

const LANG = { ar: 'arabic', en: 'english', fr: 'french', de: 'german', es: 'spanish', tr: 'turkish', ur: 'urdu', fa: 'persian' };
let loaded = null;

async function getPipe(model, ctx) {
  if (loaded && loaded.model === model) return loaded.pipe;
  const tf = await import('@huggingface/transformers');
  tf.env.cacheDir = path.join(ctx.dataDir, 'models');
  let last = 0;
  const progress_callback = (p) => {
    if (p && p.status === 'progress' && Date.now() - last > 700) { last = Date.now(); ctx.status(`Downloading the speech model… ${Math.round(p.progress || 0)}%`); }
  };
  ctx.status('Loading the speech model…');
  let pipe;
  try { pipe = await tf.pipeline('automatic-speech-recognition', model, { dtype: 'q8', progress_callback }); }
  catch { pipe = await tf.pipeline('automatic-speech-recognition', model, { progress_callback }); }
  loaded = { model, pipe };
  return pipe;
}

module.exports = {
  stt: {
    async transcribe({ pcm, language }, ctx) {
      const pipe = await getPipe(ctx.settings.model || 'Xenova/whisper-base', ctx);
      const out = await pipe(new Float32Array(pcm), { language: language ? (LANG[language] || language) : undefined, task: 'transcribe', chunk_length_s: 30 });
      return String(out.text || '').trim();
    },
  },
  async deactivate() { loaded = null; },
};
