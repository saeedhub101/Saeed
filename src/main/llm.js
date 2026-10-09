'use strict';
// Tool-using chat loop for Claude (Anthropic) and OpenAI-compatible servers (OpenAI, Groq, OpenRouter, Ollama...).
const secrets = require('./secrets');
const trim = (u) => String(u || '').replace(/\/+$/, '');
const MAX_STEPS = 10;
const aContent = (m) => (m.images && m.images.length
  ? [...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.text }] : m.text);
const oContent = (m) => (m.images && m.images.length
  ? [...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })), { type: 'text', text: m.text }] : m.text);

async function check(r, label) {
  if (r.ok) return r;
  let t = ''; try { t = (await r.text()).slice(0, 400); } catch { /* ignore */ }
  throw new Error(`${label} ${r.status}: ${t}`);
}

async function anthropicAgent(s, { system, history, tools, execTool, signal }) {
  const key = secrets.get('anthropic');
  if (!key) throw new Error('Add your Anthropic API key in Settings → Brain.');
  const msgs = history.map((m) => ({ role: m.role, content: aContent(m) }));
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  for (let i = 0; i < MAX_STEPS; i++) {
    const r = await check(await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.llm.anthropic.model, max_tokens: 4096, system, messages: msgs, tools: toolDefs }),
    }), 'Claude');
    const j = await r.json();
    msgs.push({ role: 'assistant', content: j.content });
    const uses = j.content.filter((b) => b.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !uses.length) return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: String(await execTool(u.name, u.input || {})) });
    msgs.push({ role: 'user', content: results });
  }
  return '';
}

async function openaiAgent(s, { system, history, tools, execTool, signal }) {
  const name = s.llm.provider;               // 'openai' or 'custom'
  const p = s.llm[name];
  const msgs = [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: oContent(m) }))];
  const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const key = secrets.get(name);
  for (let i = 0; i < MAX_STEPS; i++) {
    const r = await check(await fetch(`${trim(p.baseUrl)}/chat/completions`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: p.model, messages: msgs, tools: toolDefs, tool_choice: 'auto' }),
    }), 'LLM');
    const m = (await r.json()).choices[0].message;
    msgs.push(m);
    if (!m.tool_calls || !m.tool_calls.length) return String(m.content || '').trim();
    for (const tc of m.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(await execTool(tc.function.name, args)) });
    }
  }
  return '';
}

const runAgent = (s, opts) => (s.llm.provider === 'anthropic' ? anthropicAgent(s, opts) : openaiAgent(s, opts));
module.exports = { runAgent };
