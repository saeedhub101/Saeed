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
function parseToolArguments(raw) {
  const value = JSON.parse(String(raw || '{}'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.');
  return value;
}
const maxSteps = (s) => (s.agent && s.agent.maxSteps) || 25;
const requestOptions = (settings, provider, model) => {
  const id = String(model || '');
  if (provider !== 'openai' || !/^gpt-(?:5|6)(?:[.-]|$)/i.test(id)) return {};
  const allowed = /^gpt-6(?:[.-]|$)/i.test(id)
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : ['low', 'medium', 'high', 'xhigh'];
  const effort = settings.llm.reasoningEffort;
  return { reasoning_effort: allowed.includes(effort) ? effort : 'high' };
};

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

// Remember failed exact calls for this turn so a model cannot repeat a broken operation indefinitely.
function createToolRunner(execTool, signal) {
  const failed = new Set();
  return async (name, args) => {
    const key = String(name) + ':' + JSON.stringify(args || {});
    if (failed.has(key)) return 'This exact tool call already failed earlier in this task and was not repeated. Use the error to choose another tool, correct the arguments, or explain the blocker.';
    try {
      const result = await execTool(name, args || {});
      const summary = rText(result);
      if ((result && typeof result === 'object' && (result.ok === false || result.success === false || result.error))
        || /\b(?:error|denied|failed|failure|could not|couldn.t|unknown tool|tool call rejected|invalid|not found|does not exist|permission denied)\b/i.test(summary)
        || /\bHTTP [45]\d\d\b/i.test(summary)
        || /لم يتم العثور|لم أتمكن|تعذر|مرفوض|غير موجود|لا يوجد|لم ينجح|فشل|خطأ|رفض/i.test(summary)) failed.add(key);
      return result;
    } catch (error) {
      if (signal && signal.aborted) throw error;
      failed.add(key);
      return 'Tool execution error: ' + String(error && error.message || error) + '. Diagnose this result and try a different permitted approach if possible.';
    }
  };
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
      if (b && b.type === 'tool_use') {
        try { b.input = b._json ? parseToolArguments(b._json) : {}; }
        catch {
          b.input = {};
          // Keep the marker local-only; it is not serialized into the provider's assistant message.
          Object.defineProperty(b, '_invalidInput', { value: true, enumerable: false });
        }
        delete b._json;
      }
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
  const runTool = createToolRunner(execTool, signal);
  for (let i = 0; i < maxSteps(s); i++) {
    const j = await anthropicCall(key, { model: s.llm.anthropic.model, max_tokens: 4096, system, messages: msgs, tools: toolDefs }, signal, onText);
    msgs.push({ role: 'assistant', content: j.content });
    const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (text) all += (all ? ' ' : '') + text;
    const uses = j.content.filter((b) => b.type === 'tool_use');
    if (j.stop_reason !== 'tool_use' || !uses.length) return text.trim() || all.trim();
    const results = [];
    for (const u of uses) {
      const r = u._invalidInput
        ? 'Tool was not executed because the model returned invalid JSON arguments. Retry with valid JSON matching the tool schema.'
        : await runTool(u.name, u.input || {});
      const img = rImage(r);
      results.push({
        type: 'tool_result', tool_use_id: u.id,
        content: img ? [{ type: 'text', text: rText(r) || 'Image' }, { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }] : rText(r) || 'Tool returned no content. Verify the state before assuming success.',
      });
    }
    msgs.push({ role: 'user', content: results });
  }
  // The last permitted tool round may have returned useful evidence without leaving a
  // model turn to interpret it. Make a final tools-disabled synthesis call.
  const finalSystem = system + '\n\nExecution limit reached. Do not request or claim any more tool calls. Summarize only verified outcomes, clearly identify unfinished steps, and never claim the task is complete if the evidence does not prove it.';
  const final = await anthropicCall(key, { model: s.llm.anthropic.model, max_tokens: 1800, system: finalSystem, messages: msgs, tools: [] }, signal, onText);
  const finalText = (final.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return finalText || 'I could not produce a verified final summary.';
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
  const runTool = createToolRunner(execTool, signal);
  for (let i = 0; i < maxSteps(s); i++) {
    const m = await openaiCall(p, key, { model: p.model, ...requestOptions(s, name, p.model), messages: msgs, tools: toolDefs, tool_choice: 'auto' }, signal, onText);
    msgs.push({ ...m, content: m.content || null });
    if (m.content) all += (all ? ' ' : '') + m.content;
    if (!m.tool_calls || !m.tool_calls.length) return String(m.content || '').trim() || all.trim();
    const images = [];
    for (const tc of m.tool_calls) {
      let args;
      try {
        args = parseToolArguments(tc.function.arguments);
      } catch {
        // Never execute a tool with empty or fabricated arguments after a model JSON error.
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: 'Tool was not executed because the model returned invalid JSON arguments. Retry with valid JSON matching the tool schema.' });
        continue;
      }
      const r = await runTool(tc.function.name, args);
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: rText(r) || 'Tool returned no content. Verify the state before assuming success.' });
      const img = rImage(r);
      if (img) images.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    }
    if (images.length) msgs.push({ role: 'user', content: [{ type: 'text', text: '(image returned by the tool)' }, ...images] });
  }
  const finalSystem = system + '\n\nExecution limit reached. Do not request or claim any more tool calls. Summarize only verified outcomes, clearly identify unfinished steps, and never claim the task is complete if the evidence does not prove it.';
  const finalMessages = msgs.slice();
  if (finalMessages[0] && finalMessages[0].role === 'system') finalMessages[0] = { ...finalMessages[0], content: finalSystem };
  else finalMessages.unshift({ role: 'system', content: finalSystem });
  const final = await openaiCall(p, key, { model: p.model, ...requestOptions(s, name, p.model), messages: finalMessages, tools: [], tool_choice: 'none' }, signal, onText);
  return String(final.content || '').trim() || 'I could not produce a verified final summary.';
}

/* ---------- brains that come from add-ons (for example a local Qwen / Llama) ---------- */
// The add-on implements llm.complete({ system, messages, tools }) -> { text, toolCalls: [{ id, name, args }] }.
async function addonAgent(s, { system, history, tools, execTool, signal, onText }) {
  const addons = require('./addons');
  const id = s.llm.provider;
  const msgs = history.map((m) => ({ role: m.role, text: m.text, images: m.images }));
  const defs = tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  let all = '';
  const runTool = createToolRunner(execTool, signal);
  for (let i = 0; i < maxSteps(s); i++) {
    const r = await addons.callProvider('llm', id, { system, messages: msgs, tools: defs }, signal, onText);
    if (r.text) all += (all ? ' ' : '') + r.text;
    if (!r.toolCalls || !r.toolCalls.length) return String(r.text || '').trim() || all.trim();
    // Keep a model turn in local chat history so the following tool result is not a consecutive user turn.
    // This marker is internal context only; it is never added to the visible answer.
    msgs.push({ role: 'assistant', text: r.text || '[Requested tool: ' + r.toolCalls.map((tc) => tc.name).join(', ') + ']', toolCalls: r.toolCalls });
    for (const tc of r.toolCalls) {
      let out;
      out = await runTool(tc.name, tc.args || {});
      msgs.push({ role: 'tool', toolCallId: tc.id, name: tc.name, text: rText(out) || 'Tool returned no content. Verify the state before assuming success.' });
    }
  }
  const finalSystem = system + '\n\nExecution limit reached. Do not request or claim any more tool calls. Summarize only verified outcomes, clearly identify unfinished steps, and never claim the task is complete if the evidence does not prove it.';
  const final = await addons.callProvider('llm', id, { system: finalSystem, messages: msgs, tools: [] }, signal, onText);
  return String(final.text || '').trim() || 'I could not produce a verified final summary.';
}

const runAgent = (s, opts) => (s.llm.provider.startsWith('addon:') ? addonAgent(s, opts) : s.llm.provider === 'anthropic' ? anthropicAgent(s, opts) : openaiAgent(s, opts));
module.exports = { runAgent, _test: { createToolRunner, parseToolArguments, requestOptions } };
