// src/services/openrouter.js — Modelos gratuitos via OpenRouter (API compativel com OpenAI)
import { pushUsage } from './usage-context.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// 3 modelos gratuitos confiaveis (verificados em 2026). IDs :free.
export const FREE_MODELS = [
  { id: 'deepseek/deepseek-v4-flash:free', label: 'DeepSeek V4 Flash' },
  { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B' },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B' },
];

export function isFreeModel(model) {
  return model === 'free' || (!!model && FREE_MODELS.some(m => m.id === model));
}

export function labelFor(model) {
  return FREE_MODELS.find(m => m.id === model)?.label || model;
}

async function callOne(systemPrompt, messages, model, maxTokens) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://everi9.albertobottaro.info',
      'X-Title': 'Ever i9',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter ${model}: resposta vazia`);
  pushUsage(model, data.usage);
  return text;
}

// Tenta o modelo escolhido; se falhar (429/5xx/indisponivel), cai para os outros gratuitos.
export async function callWithFallback(systemPrompt, messages, preferredModel, maxTokens = 8192) {
  const order = [preferredModel, ...FREE_MODELS.map(m => m.id).filter(id => id !== preferredModel)];
  let lastErr;
  for (const model of order) {
    try {
      const text = await callOne(systemPrompt, messages, model, maxTokens);
      return { text, model };
    } catch (err) {
      lastErr = err;
      console.error('OpenRouter fallback:', err.message);
    }
  }
  throw lastErr || new Error('Todos os modelos gratuitos falharam');
}

// ════════════════════════════════════════════════════════════════
// POOL DINAMICO DE MODELOS GRATUITOS  (escopo inicial: /hf)
// Nao altera FREE_MODELS/callWithFallback acima (usados por /ata e /chat).
// ════════════════════════════════════════════════════════════════
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
let _poolCache = { models: [], ts: 0 };
const POOL_TTL = 30 * 60 * 1000;          // 30 min
const _health = new Map();                 // id -> { ok: ts, fail: ts }

// Busca a lista de modelos do OpenRouter, filtra os gratuitos de qualidade minima
export async function getFreePool() {
  const now = Date.now();
  if (_poolCache.models.length && (now - _poolCache.ts) < POOL_TTL) return _poolCache.models;
  try {
    const res = await fetch(MODELS_URL, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_KEY}` },
    });
    if (!res.ok) throw new Error('models ' + res.status);
    const data = await res.json();
    const list = (data.data || [])
      .filter(m => {
        const id = m.id || '';
        const free = id.endsWith(':free') ||
          (m.pricing && String(m.pricing.prompt) === '0' && String(m.pricing.completion) === '0');
        const ctx = Number(m.context_length || 0) >= 8192;
        const arch = m.architecture || {};
        const out = Array.isArray(arch.output_modalities) ? arch.output_modalities : [];
        const textOnly = (out.length === 1 && out[0] === 'text') || (!out.length && arch.modality === 'text->text');
        return free && ctx && textOnly;
      })
      .map(m => ({ id: m.id, label: m.name || m.id, ctx: Number(m.context_length || 0) }))
      .sort((a, b) => b.ctx - a.ctx)        // maior contexto primeiro (proxy de capacidade)
      .slice(0, 20);
    if (list.length) _poolCache = { models: list, ts: now };
  } catch (e) {
    console.error('getFreePool erro:', e.message);
  }
  // fallback: se a busca falhou e nao ha cache, usa os 3 hardcoded
  return _poolCache.models.length ? _poolCache.models : FREE_MODELS.map(m => ({ ...m, ctx: 0 }));
}

// Ordena por memoria de disponibilidade: sucesso recente no topo, falha recente no fim
function orderByHealth(pool) {
  const now = Date.now(), RECENT = 10 * 60 * 1000;
  const score = (h) => {
    if (h.ok && (now - h.ok) < RECENT) return 2;
    if (h.fail && (now - h.fail) < RECENT) return 0;
    return 1;
  };
  return [...pool].sort((a, b) => score(_health.get(b.id) || {}) - score(_health.get(a.id) || {}));
}

async function callOneTimed(systemPrompt, messages, model, maxTokens, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://everi9.albertobottaro.info',
        'X-Title': 'Ever i9',
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${model} ${res.status}`);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${model}: vazio`);
    pushUsage(model, data.usage);
    return text;
  } finally {
    clearTimeout(t);
  }
}

// Cascata pelo pool dinamico, ordenado por disponibilidade recente.
export async function callWithDynamicPool(systemPrompt, messages, maxTokens = 8192) {
  const pool = await getFreePool();
  const ordered = orderByHealth(pool);
  let lastErr;
  for (const m of ordered) {
    try {
      const text = await callOneTimed(systemPrompt, messages, m.id, maxTokens);
      _health.set(m.id, { ...(_health.get(m.id) || {}), ok: Date.now() });
      return { text, model: m.id, label: m.label };
    } catch (err) {
      _health.set(m.id, { ...(_health.get(m.id) || {}), fail: Date.now() });
      lastErr = err;
      console.error('pool fallback:', m.id, err.message);
    }
  }
  throw lastErr || new Error('Pool gratuito esgotado');
}
