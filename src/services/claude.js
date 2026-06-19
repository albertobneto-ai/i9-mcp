// src/services/claude.js — Anthropic API com Prompt Caching
import { pushUsage } from './usage-context.js';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Retry com backoff para fetch transiente (Eco dyno rede instável)
async function fetchWithRetry(url, options, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      return res;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = attempt * 2000; // 2s, 4s
      console.error(`[claude] fetch attempt ${attempt}/${retries} failed: ${err.message}. Retry in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export async function call(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetchWithRetry(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  pushUsage('claude-sonnet-4-6', data.usage);
  return data.content[0].text;
}

export async function stream(systemPrompt, messages, maxTokens = 16384) {
  const res = await fetchWithRetry(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      stream: true,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude stream ${res.status}: ${await res.text()}`);
  return res.body;
}

// Claude Haiku 4.5 — fallback quando modelos grátis estão indisponíveis (/hf, /ata)
export async function callHaiku(systemPrompt, messages, maxTokens = 8192) {
  const res = await fetchWithRetry(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Haiku ${res.status}: ${await res.text()}`);
  const data = await res.json();
  pushUsage('claude-haiku-4-5', data.usage);
  return data.content?.[0]?.text || '';
}

// Chamada genérica para qualquer modelo Claude (Opus, Sonnet, Haiku)
export async function callAny(model, systemPrompt, messages, maxTokens = 8192) {
  const res = await fetchWithRetry(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Claude ${model} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  pushUsage(model, data.usage);
  return data.content?.[0]?.text || '';
}

// ── Roteamento híbrido de modelos por tipo de tarefa ──
export const MODELS = {
  OPUS: 'claude-opus-4-6',
  SONNET: 'claude-sonnet-4-6',
  HAIKU: 'claude-haiku-4-5-20251001',
};

// Mapa de tarefa → modelo. Spec/runbook/Flow/LWC usam Opus; resto Sonnet.
export function modelForTask(task) {
  const opusTasks = ['spec', 'runbook-parse', 'flow', 'lwc', 'apex-gen'];
  return opusTasks.includes(task) ? MODELS.OPUS : MODELS.SONNET;
}

// Chamada roteada com fallback automático Opus → Sonnet se Opus falhar
export async function callRouted(task, systemPrompt, messages, maxTokens = 8192) {
  const model = modelForTask(task);
  try {
    return { text: await callAny(model, systemPrompt, messages, maxTokens), model };
  } catch (err) {
    // Fallback para Sonnet se Opus indisponível
    if (model === MODELS.OPUS) {
      console.error('Opus falhou, fallback Sonnet:', err.message);
      const text = await callAny(MODELS.SONNET, systemPrompt, messages, maxTokens);
      return { text, model: MODELS.SONNET + ' (fallback)' };
    }
    throw err;
  }
}

// KB assistant with web search (Haiku + web_search tool)
export async function callHaikuWithSearch(systemPrompt, messages, maxTokens = 2048) {
  const apiKey = process.env.ANTHROPIC_KEY;
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
  };
  const resp = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  // Extract text from content blocks (may include web search results)
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return text;
}
