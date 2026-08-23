// src/routes/kb.js — Base de Conhecimento (RAG grounded: pgvector + Haiku)
// Responde EXCLUSIVAMENTE com base nos documentos ingeridos. Sem web search.
import express from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { embed, embedBatch, toVectorLiteral, EMB_DIM } from '../services/embeddings.js';
import { callHaiku } from '../services/claude.js';

const router = express.Router();

// ── init: extensão + tabelas (idempotente; seguro chamar no boot) ──
export async function initKbTables() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_documents (
    id serial PRIMARY KEY,
    title text NOT NULL,
    source text,
    meta jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS kb_chunks (
    id serial PRIMARY KEY,
    document_id int NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
    chunk_index int NOT NULL,
    content text NOT NULL,
    token_est int,
    embedding vector(${EMB_DIM}),
    created_at timestamptz DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_chunks_docid ON kb_chunks(document_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_chunks_embedding ON kb_chunks USING hnsw (embedding vector_cosine_ops)');
}

// ── chunking: agrupa parágrafos até um alvo de caracteres, com overlap leve ──
function chunkText(text, target = 1200, overlapParas = 1) {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const p of paras) {
    if (len + p.length > target && buf.length) {
      chunks.push(buf.join('\n\n'));
      buf = overlapParas > 0 ? buf.slice(-overlapParas) : [];
      len = buf.join('\n\n').length;
    }
    buf.push(p);
    len += p.length;
  }
  if (buf.length) chunks.push(buf.join('\n\n'));
  // parágrafo isolado gigante -> quebra bruta por tamanho
  const final = [];
  for (const c of chunks) {
    if (c.length <= target * 2) { final.push(c); continue; }
    for (let i = 0; i < c.length; i += target) final.push(c.slice(i, i + target));
  }
  return final.filter(Boolean);
}

const estTokens = (s) => Math.ceil(s.length / 4);

// ── POST /api/kb/ingest — {title, source?, content} ──
router.post('/ingest', authMiddleware, async (req, res) => {
  const { title, source, content } = req.body || {};
  if (!title || !content || !content.trim())
    return res.status(400).json({ error: 'title e content são obrigatórios' });
  const client = await pool.connect();
  try {
    const chunks = chunkText(content);
    if (!chunks.length) return res.status(400).json({ error: 'conteúdo vazio após chunking' });
    const vectors = await embedBatch(chunks);
    if (vectors.length !== chunks.length)
      throw new Error(`embeddings (${vectors.length}) != chunks (${chunks.length})`);

    await client.query('BEGIN');
    const docRes = await client.query(
      'INSERT INTO kb_documents (title, source) VALUES ($1, $2) RETURNING id',
      [title.trim(), source || null]
    );
    const docId = docRes.rows[0].id;
    for (let i = 0; i < chunks.length; i++) {
      await client.query(
        `INSERT INTO kb_chunks (document_id, chunk_index, content, token_est, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [docId, i, chunks[i], estTokens(chunks[i]), toVectorLiteral(vectors[i])]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, document_id: docId, chunks: chunks.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[kb ingest]', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── POST /api/kb/ask — {question, top_k?} ──
router.post('/ask', authMiddleware, async (req, res) => {
  const { question, top_k } = req.body || {};
  if (!question || !question.trim())
    return res.status(400).json({ error: 'question é obrigatório' });
  const k = Math.min(Math.max(parseInt(top_k) || 6, 1), 12);
  try {
    const cnt = await pool.query('SELECT count(*)::int AS n FROM kb_chunks');
    if (!cnt.rows[0].n)
      return res.json({ answer: 'A base de conhecimento está vazia. Adicione um documento antes de perguntar.', sources: [], found: false });

    const qVec = await embed(question);
    // top-k por distância de cosseno (<=> menor = mais próximo); score = 1 - distância
    const hits = await pool.query(
      `SELECT c.content, c.chunk_index, d.id AS doc_id, d.title,
              1 - (c.embedding <=> $1::vector) AS score
       FROM kb_chunks c
       JOIN kb_documents d ON d.id = c.document_id
       ORDER BY c.embedding <=> $1::vector
       LIMIT $2`,
      [toVectorLiteral(qVec), k]
    );
    if (!hits.rows.length)
      return res.json({ answer: 'Não encontrei nada relacionado na base de conhecimento.', sources: [], found: false });

    const contexto = hits.rows.map((r, i) =>
      `[Trecho ${i + 1} — documento: "${r.title}"]\n${r.content}`
    ).join('\n\n---\n\n');

    const system = [
      'Você é um assistente que responde EXCLUSIVAMENTE com base nos trechos da base de conhecimento fornecidos na mensagem do usuário.',
      'Regras invioláveis:',
      '1. Use SOMENTE as informações contidas nos trechos fornecidos. NUNCA use conhecimento externo, memória de treino ou suposição.',
      '2. Se a resposta não estiver nos trechos, responda exatamente: "Não encontrei isso na base de conhecimento." e nada mais.',
      '3. Cite entre parênteses o(s) documento(s) de onde tirou a informação, pelo título.',
      '4. Não invente, não extrapole, não complete lacunas. Se o trecho cobre só parte, diga que a base cobre apenas parcialmente.',
      '5. Responda em português do Brasil, de forma direta.',
    ].join('\n');

    const userMsg = `PERGUNTA: ${question}\n\n=== TRECHOS DA BASE DE CONHECIMENTO ===\n\n${contexto}\n\n=== FIM DOS TRECHOS ===\n\nResponda à pergunta usando apenas os trechos acima.`;

    const answer = await callHaiku(system, [{ role: 'user', content: userMsg }], 1500);

    const sources = hits.rows.map((r, i) => ({
      n: i + 1, doc_id: r.doc_id, title: r.title,
      chunk_index: r.chunk_index, score: Number(Number(r.score).toFixed(4)),
    }));
    res.json({ answer, sources, found: true });
  } catch (e) {
    console.error('[kb ask]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/kb/docs — lista documentos com contagem de chunks ──
router.get('/docs', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT d.id, d.title, d.source, d.created_at, count(c.id)::int AS chunks
       FROM kb_documents d
       LEFT JOIN kb_chunks c ON c.document_id = d.id
       GROUP BY d.id
       ORDER BY d.created_at DESC`
    );
    res.json({ docs: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/kb/docs/:id — remove documento e seus chunks (cascade) ──
router.delete('/docs/:id', authMiddleware, async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await pool.query('DELETE FROM kb_documents WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'documento não encontrado' });
    res.json({ ok: true, deleted: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
