'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function get(url, dest, ctx, label) {
  if (fs.existsSync(dest)) return;
  ctx.status(`Downloading ${label}…`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} (${url})`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function ensure(ctx) {
  const root = path.join(ctx.dataDir, 'piper'), exe = path.join(root, 'piper', 'piper.exe');
  if (!fs.existsSync(exe)) {
    const zip = path.join(ctx.dataDir, 'piper.zip');
    await get(ctx.settings.exeUrl, zip, ctx, 'the Piper program');
    ctx.status('Unpacking Piper…');
    new (require('adm-zip'))(zip).extractAllTo(root, true);
    fs.rmSync(zip, { force: true });
  }
  const base = ctx.settings.voiceBase, name = decodeURIComponent(base.split('/').pop());
  const model = path.join(ctx.dataDir, 'voices', name + '.onnx');
  await get(base + '.onnx', model, ctx, 'the voice');
  await get(base + '.onnx.json', model + '.json', ctx, 'the voice settings');
  return { exe, model };
}

module.exports = {
  tts: {
    async synthesize({ text }, ctx) {
      if (process.platform !== 'win32') throw new Error('Piper needs Windows.');
      const { exe, model } = await ensure(ctx);
      const out = path.join(os.tmpdir(), `piper-${process.pid}-${Date.now()}.wav`);
      await new Promise((resolve, reject) => {
        const p = spawn(exe, ['--model', model, '--output_file', out, '--length_scale', String(Number(ctx.settings.speed) || 1)], { cwd: path.dirname(exe), windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => { err += d; });
        p.on('error', reject);
        p.on('close', (c) => (c === 0 ? resolve() : reject(new Error('Piper failed: ' + err.slice(-300)))));
        p.stdin.end(String(text) + '\n');
      });
      const bytes = fs.readFileSync(out);
      fs.rmSync(out, { force: true });
      return { mime: 'audio/wav', bytes };
    },
  },
};
