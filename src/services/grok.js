// src/services/grok.js — xAI API (Grok) com Web Search via Responses API
import { pushUsage } from './usage-context.js';
const CHAT_URL = 'https://api.x.ai/v1/chat/completions';
const RESPONSES_URL = 'https://api.x.ai/v1/responses';

export async function call(systemPrompt, messages, maxTokens = 16384, options = {}) {
  // Com busca: usar Responses API
  if (options.search) {
    const input = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];
    const res = await fetch(RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROK_KEY}`,
      },
      body: JSON.stringify({
        model: 'grok-3-mini-fast',
        input,
        tools: [{ type: 'web_search' }],
      }),
    });
    if (!res.ok) throw new Error(`Grok search ${res.status}: ${await res.text()}`);
    const data = await res.json();
    pushUsage('grok-search', data.usage);
    // Responses API retorna output_text ou output array
    if (data.output_text) return data.output_text;
    if (data.output) {
      const texts = data.output
        .filter(o => o.type === 'message')
        .flatMap(o => o.content || [])
        .filter(c => c.type === 'output_text' || c.type === 'text')
        .map(c => c.text)
        .join('\n');
      return texts || JSON.stringify(data.output);
    }
    return JSON.stringify(data);
  }

  // Sem busca: usar Chat Completions API normal
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROK_MODEL || 'grok-3-mini-fast',
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`Grok ${res.status}: ${await res.text()}`);
  const data = await res.json();
  pushUsage(process.env.GROK_MODEL || 'grok-3-mini-fast', data.usage);
  return data.choices[0].message.content;
}

export async function stream(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROK_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.GROK_MODEL || 'grok-3-mini-fast',
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`Grok stream ${res.status}: ${await res.text()}`);
  return res.body;
}
