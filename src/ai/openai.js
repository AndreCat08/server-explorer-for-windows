// OpenAI-compatible chat completions with function calling, shared by 9router and Mandor. The app
// runs the tool loop itself and keeps the conversation in `messages`. `label` names the provider in
// error messages; `mapError` lets a provider explain its own HTTP errors.
const { TOOL_DEFS } = require('./tools');

const MAX_STEPS = 50;
const trimBase = (url) => String(url || '').trim().replace(/\/+$/, '');
const authHeaders = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function listModels({ baseUrl, apiKey }) {
  let res;
  try {
    res = await fetch(`${trimBase(baseUrl)}/models`, { headers: authHeaders(apiKey), signal: AbortSignal.timeout(8000) });
  } catch (err) {
    throw new Error(`Can't reach 9router at ${trimBase(baseUrl)}. Is it running? (${err.cause?.code || err.message})`);
  }
  if (!res.ok) throw new Error(`9router returned ${res.status}${res.status === 401 ? ': check the API key' : ''}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id).filter(Boolean).sort();
}

async function readCompletion(res, { onTextStart, onText }) {
  let text = '';
  const calls = [];
  const addDelta = (delta) => {
    if (delta.content) {
      if (!text) onTextStart();
      text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const index = tc.index ?? calls.length;
      const call = (calls[index] ||= { id: '', name: '', arguments: '' });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.name += tc.function.name;
      if (tc.function?.arguments) call.arguments += tc.function.arguments;
    }
  };

  if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
    // Some proxies ignore stream: true and answer with a single JSON body.
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    const message = json.choices?.[0]?.message || {};
    addDelta({ content: message.content, tool_calls: (message.tool_calls || []).map((c, index) => ({ ...c, index })) });
  } else {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
        const delta = json.choices?.[0]?.delta;
        if (delta) addDelta(delta);
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }));
  return { text, toolCalls };
}

async function runTurn({ messages, baseUrl, apiKey, model, systemPrompt, toolbox, onTextStart, onText, signal, label = '9router', mapError }) {
  if (!model) throw new Error(`Choose a ${label} model in the AI settings first.`);
  const tools = TOOL_DEFS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

  for (let step = 0; step < MAX_STEPS; step++) {
    let res;
    try {
      res = await fetch(`${trimBase(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'system', content: systemPrompt }, ...messages], tools }),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      throw new Error(`Can't reach ${label} at ${trimBase(baseUrl)}. (${err.cause?.code || err.message})`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(mapError ? mapError(res.status, body) : `${label} returned ${res.status}: ${body.slice(0, 400)}`);
    }

    let completion;
    try {
      completion = await readCompletion(res, { onTextStart, onText });
    } catch (err) {
      if (signal.aborted) return;
      throw err;
    }
    const { text, toolCalls } = completion;
    const message = { role: 'assistant', content: text || null };
    if (toolCalls.length) {
      message.tool_calls = toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
    }
    messages.push(message);
    if (!toolCalls.length) return;

    // Every tool call must get an answer, even when the user stops midway.
    for (const call of toolCalls) {
      let output;
      if (signal.aborted) {
        output = 'Cancelled by the user.';
      } else {
        let args = null;
        try {
          args = JSON.parse(call.arguments || '{}');
        } catch {
          // handled below
        }
        output = args ? await toolbox.call(call.name, args) : 'Error: the tool arguments were not valid JSON.';
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: output });
    }
    if (signal.aborted) return;
  }
  throw new Error(`Stopped after ${MAX_STEPS} steps. Send a message to continue.`);
}

module.exports = { listModels, runTurn };
