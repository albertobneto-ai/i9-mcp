// src/services/embeddings.js — Embeddings via OpenRouter (OpenAI text-embedding-3-small, dim 1536)
// Usado pela base de conhecimento (RAG). Reusa a mesma OPENROUTER_KEY do resto do app.

const EMB_URL = 'https://openrouter.ai/api/v1/embeddings';
const EMB_MODEL = 'openai/text-embedding-3-small';
export const EMB_DIM = 1536;

async function callEmbeddings(inputs) {
  const res = await fetch(EMB_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENROUTER_KEY}`,
      'HTTP-Referer': 'https://everi9.albertobottaro.info',
      'X-Title': 'Ever i9 KB',
    },
    body: JSON.stringify({ model: EMB_MODEL, input: inputs }),
  });
  if (!res.ok) throw new Error(`Embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // ordena por index para garantir alinhamento 1:1 com a ordem dos inputs
  const rows = (data.data || []).slice().sort((a, b) => a.index - b.index);
  return rows.map(r => r.embedding);
}

// embedding de um texto único -> array de floats (1536)
export async function embed(text) {
  const [v] = await callEmbeddings([text]);
  return v;
}

// embedding em lote -> array de arrays. Chunka em lotes de 96 para não estourar o payload.
export async function embedBatch(texts) {
  const out = [];
  const B = 96;
  for (let i = 0; i < texts.length; i += B) {
    const vecs = await callEmbeddings(texts.slice(i, i + B));
    out.push(...vecs);
  }
  return out;
}

// formata array JS como literal de vetor pgvector: '[0.1,0.2,...]'
export function toVectorLiteral(arr) {
  return '[' + arr.map(x => (typeof x === 'number' ? x : 0)).join(',') + ']';
}
