'use strict';
// Tool-using chat loop for Claude (Anthropic) and OpenAI-compatible servers (OpenAI, Groq, OpenRouter, Ollama...).
// Replies stream: onText(delta) is called while the model writes, so Saeed can start speaking early.
// A tool may return a string or { text, image: { mime, data } } (a screenshot, a chart...).
const secrets = require('./secrets');

const trim = (u) => String(u || '').replace(/\/+$/, '');
const aContent = (m) => (m.images && m.images.length
  ? [...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), { type: 'text', text: m.text }] : m.text);
const oContent = (m) => (m.images && m.images.length
  ? [...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })), { type: 'text', text: m.text }] : m.text);
const rText = (r) => (typeof r === 'string' ? r : String((r && r.text) || ''));
const rImage = (r) => (r && typeof r === 'object' && r.image ? r.image : null);
const maxSteps = (s) => (s.agent && s.agent.maxSteps) || 25;

async function check(r, label) {
  if (r.ok) return r;
  let t = ''; try { t = (await r.text()).slice(0, 400); } catch { /* ignore */ }
  throw new Error(`${label} ${r.status}: ${t}`);
}

// Server-sent events: yields the data of each event.
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield data;
    }
  }
}

/* ---------- Claude ---------- */
async function anthropicCall(key, body, signal, onText) {
  const res = await check(await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ ...body, stream: !!onText }),
  }), 'Claude');
  if (!onText) return res.json();
  const content = [];
  let stop = null;
  for await (const data of sse(res)) {
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    if (ev.type === 'content_block_start') {
      const b = ev.content_block;
      content[ev.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' } : { type: 'text', text: '' };
    } else if (ev.type === 'content_block_delta') {
      const b = content[ev.index];
      if (!b) continue;
      if (ev.delta.type === 'text_delta') { b.text += ev.delta.text; onText(ev.delta.text); }
      else if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
    } else if (ev.type === 'content_block_stop') {
      const b = content[ev.index];
      if (b && b.type === 'tool_use') { try { b.input = b._json ? JSON.parse(b._json) : {}; } catch { b.input = {}; } delete b._json; }
    } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
    else if (ev.type === 'error') throw new Error('Claude: ' + ((ev.error && ev.error.message) || 'stream error'));
  }
  return { content: content.filter(Boolean), stop_reason: stop };
}

async function anthropicAgent(s, { system, history, tools, execTool, signal, onText }) {
  const key = secrets.get('anthropic');
  if (!key) throw new Error('Add your Anthropic API key in Settings → Brain.');
  if (!String(s.llm.anthropic.model || '').trim()) throw new Error('The brain model name is empty. Set it in Settings → Brain.');
  const msgs = history.map((m) => ({ role: m.role, content: aContent(m) }));
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }));
  let all = '';
  for (let i = 0; i < maxSteps(s); i++) {
    const j = await anthropicCall(key, { model: s.llm.anthropic.model, max_tokens: 4096, system, messages: msgs, tools: toolDefs }, signal, onText);
    msgs.push({ role: 'assistant', content: j.content });
    const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) all += (all ? ' ' : '') + text;
    const uses = j.content.filter((b) => b.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !uses.length) return all.trim();
    const results = [];
    for (const u of uses) {
      const r = await execTool(u.name, u.input || {});
      const img = rImage(r);
      results.push({
        type: 'tool_result', tool_use_id: u.id,
        content: img ? [{ type: 'text', text: rText(r) || 'Image' }, { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }] : rText(r) || 'Done.',
      });
    }
    msgs.push({ role: 'user', content: results });
  }
  return (all + ' I stopped because the task needed too many steps.').trim();
}

/* ---------- OpenAI-compatible ---------- */
async function openaiCall(p, key, body, signal, onText) {
  const res = await check(await fetch(`${trim(p.baseUrl)}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ ...body, stream: !!onText }),
  }), 'LLM');
  const streamed = (res.headers.get('content-type') || '').includes('event-stream');
  if (!onText || !streamed) {
    const m = (await res.json()).choices[0].message;
    if (onText && m.content) onText(m.content);
    return m;
  }
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  for await (const data of sse(res)) {
    if (data === '[DONE]') break;
    let ev; try { ev = JSON.parse(data); } catch { continue; }
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!d) continue;
    if (d.content) { msg.content += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      const t = (msg.tool_calls[tc.index] = msg.tool_calls[tc.index] || { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) t.id = tc.id;
      if (tc.function) { if (tc.function.name) t.function.name += tc.function.name; if (tc.function.arguments) t.function.arguments += tc.function.arguments; }
    }
  }
  msg.tool_calls = msg.tool_calls.filter(Boolean);
  if (!msg.tool_calls.length) delete msg.tool_calls;
  return msg;
}

async function openaiAgent(s, { system, history, tools, execTool, signal, onText }) {
  const name = s.llm.provider;               // 'openai' or 'custom'
  const p = s.llm[name];
  if (!String(p.model || '').trim()) throw new Error('The brain model name is empty. Set it in Settings → Brain.');
  const msgs = [{ role: 'system', content: system }, ...history.map((m) => ({ role: m.role, content: oContent(m) }))];
  const toolDefs = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } }));
  const key = secrets.get(name);
  let all = '';
  for (let i = 0; i < maxSteps(s); i++) {
    const m = await openaiCall(p, key, { model: p.model, messages: msgs, tools: toolDefs, tool_choice: 'auto' }, signal, onText);
    msgs.push({ ...m, content: m.content || null });
    if (m.content) all += (all ? ' ' : '') + m.content;
    if (!m.tool_calls || !m.tool_calls.length) return all.trim();
    const images = [];
    for (const tc of m.tool_calls) {
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* ignore */ }
      const r = await execTool(tc.function.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: rText(r) || 'Done.' });
      const img = rImage(r);
      if (img) images.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    }
    if (images.length) msgs.push({ role: 'user', content: [{ type: 'text', text: '(image returned by the tool)' }, ...images] });
  }
  return (all + ' I stopped because the task needed too many steps.').trim();
}

const runAgent = (s, opts) => (s.llm.provider === 'anthropic' ? anthropicAgent(s, opts) : openaiAgent(s, opts));
module.exports = { runAgent };
