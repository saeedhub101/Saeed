'use strict';
const fs = require('fs');
const path = require('path');

let worker = null, workerLang = '';
module.exports = {
  tools: {
    async image_to_text({ path: p, lang = 'ara+eng' }, ctx) {
      const { createWorker } = require('tesseract.js');
      const file = ctx.safePath(p);
      if (!worker || workerLang !== lang) {
        if (worker) await worker.terminate();
        const local = path.join(ctx.addonDir, 'tessdata');
        const hasLocal = fs.existsSync(path.join(local, 'eng.traineddata'));
        ctx.status('Preparing text recognition…');
        worker = await createWorker(lang, 1, hasLocal ? { langPath: local, gzip: false, cachePath: ctx.dataDir } : { cachePath: ctx.dataDir });
        workerLang = lang;
      }
      ctx.status('Reading the image…');
      const { data } = await worker.recognize(fs.readFileSync(file));
      return { text: data.text.trim(), confidence: Math.round(data.confidence) };
    },
  },
  async deactivate() { if (worker) { await worker.terminate(); worker = null; } },
};
