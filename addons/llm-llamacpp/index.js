'use strict';
const fs = require('fs');
const path = require('path');

let state = null;

async function modelFile(ctx) {
  if (ctx.settings.modelPath && fs.existsSync(ctx.settings.modelPath)) return ctx.settings.modelPath;
  const url = ctx.settings.modelUrl;
  if (!url) throw new Error('Set a model link or a model file in this add-on\'s settings.');
  const dir = path.join(ctx.dataDir, 'models');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, decodeURIComponent(url.split('?')[0].split('/').pop()));
  if (fs.existsSync(file)) return file;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('Model download failed: HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0, tmp = file + '.part', out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  let got = 0, last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(value); got += value.length;
    if (Date.now() - last > 1000) { last = Date.now(); ctx.status(`Downloading the model… ${(got / 1048576).toFixed(0)}${total ? ' of ' + (total / 1048576).toFixed(0) : ''} MB`); }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(tmp, file);
  return file;
}

async function ensure(ctx) {
  if (state) return state;
  const { getLlama } = await import('node-llama-cpp');
  const modelPath = await modelFile(ctx);
  ctx.status('Loading the model…');
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });
  const context = await model.createContext({ contextSize: Number(ctx.settings.contextSize) || 4096 });
  state = { llama, model, context };
  return state;
}

module.exports = {
  llm: {
    // messages: [{ role: 'user'|'assistant'|'tool', text }]. Tools are not used by this simple local brain.
    async complete({ system, messages }, ctx) {
      const { LlamaChatSession } = await import('node-llama-cpp');
      const st = await ensure(ctx);
      const seq = st.context.getSequence();
      const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: system });
      try {
        const turns = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text);
        const last = turns.pop();
        if (!last) return { text: '', toolCalls: [] };
        const history = [{ type: 'system', text: system }];
        for (const m of turns) history.push(m.role === 'user' ? { type: 'user', text: m.text } : { type: 'model', response: [m.text] });
        session.setChatHistory(history);
        const text = await session.prompt(last.text, { maxTokens: Number(ctx.settings.maxTokens) || 600, onTextChunk: (t) => ctx.stream(t) });
        return { text: String(text).trim(), toolCalls: [] };
      } finally { session.dispose(); seq.dispose(); }
    },
  },
  async deactivate() { if (state) { try { await state.context.dispose(); await state.model.dispose(); } catch { /* ignore */ } state = null; } },
};
