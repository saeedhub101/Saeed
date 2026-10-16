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

function toolInstructions(tools) {
  if (!Array.isArray(tools) || !tools.length) return '';
  return [
    '',
    'TOOLS: You may request one tool per response when it is useful. Only use a tool listed below.',
    'To request a tool, output exactly one JSON object and nothing else in this format:',
    '{"tool_call":{"name":"EXACT_TOOL_NAME","args":{}}}',
    'Copy the exact tool name and use arguments matching its schema. Do not claim a tool ran; wait for its result.',
    'If no tool is needed, answer normally in plain text. Never invent a tool result.',
    'Available tools and schemas:',
    JSON.stringify(tools),
  ].join('\n');
}

function parseToolCall(text, tools) {
  const allowed = new Map((Array.isArray(tools) ? tools : []).map((t) => [t.name, t]));
  const candidates = [String(text || '').trim()];
  const tagged = String(text || '').match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (tagged) candidates.unshift(tagged[1].trim());
  for (const candidate of candidates) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    const call = value && (value.tool_call || value);
    if (!call || typeof call.name !== 'string' || !allowed.has(call.name)) continue;
    const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args
      : call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments) ? call.arguments : null;
    if (!args) continue;
    return [{ id: `local-${Date.now()}-1`, name: call.name, args }];
  }
  return [];
}

module.exports = {
  llm: {
    // Local models receive the same tool catalogue as hosted providers; tools still pass through Saeed's permission broker.
    async complete({ system, messages, tools }, ctx) {
      const { LlamaChatSession } = await import('node-llama-cpp');
      const st = await ensure(ctx);
      const seq = st.context.getSequence();
      const session = new LlamaChatSession({ contextSequence: seq, systemPrompt: String(system || '') + toolInstructions(tools) });
      try {
        const turns = messages.filter((m) => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') && m.text);
        const last = turns.pop();
        if (!last) return { text: '', toolCalls: [] };
        const history = [{ type: 'system', text: String(system || '') + toolInstructions(tools) }];
        for (const m of turns) {
          if (m.role === 'user') history.push({ type: 'user', text: m.text });
          else if (m.role === 'assistant') history.push({ type: 'model', response: [m.text] });
          else history.push({ type: 'user', text: `Tool result (${m.name || m.toolCallId || 'tool'}):\n${m.text}` });
        }
        session.setChatHistory(history);
        const text = String(await session.prompt(last.role === 'tool' ? `Tool result (${last.name || last.toolCallId || 'tool'}):\n${last.text}\nContinue the task using this result.` : last.text, {
          maxTokens: Number(ctx.settings.maxTokens) || 600,
        })).trim();
        const toolCalls = parseToolCall(text, tools);
        if (toolCalls.length) return { text: '', toolCalls };
        if (text) ctx.stream(text);
        return { text, toolCalls: [] };
      } finally { session.dispose(); seq.dispose(); }
    },
  },
  async deactivate() { if (state) { try { await state.context.dispose(); await state.model.dispose(); } catch { /* ignore */ } state = null; } },
};
