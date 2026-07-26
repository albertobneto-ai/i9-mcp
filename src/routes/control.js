import express from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

/* ============================================================
   Control i9 — fila de solicitações ao agente
   Estados: NA_FILA -> EM_ANALISE -> RESPONDIDO | FALHA
   ============================================================ */

export async function initControlTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS control_requests (
    id SERIAL PRIMARY KEY,
    user_id INT,
    user_name VARCHAR(120),
    request TEXT,
    status VARCHAR(20) DEFAULT 'NA_FILA',
    file_name VARCHAR(300),
    file_size INT,
    file_b64 TEXT,
    result TEXT,
    result_file_name VARCHAR(300),
    result_file_b64 TEXT,
    error TEXT,
    meta JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    answered_at TIMESTAMPTZ
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_control_status ON control_requests(status)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_control_created ON control_requests(created_at DESC)');
}

// colunas leves — nunca devolver os blobs na listagem
const LIGHT = `id, user_id, user_name, request, status, file_name, file_size,
  result, result_file_name, error, meta, created_at, claimed_at, answered_at,
  (file_b64 IS NOT NULL) AS has_file,
  (result_file_b64 IS NOT NULL) AS has_result_file`;

const MAX_B64 = 11 * 1024 * 1024; // ~8 MB de arquivo real

/* ---------- LISTA ---------- */
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const params = [];
    let sql = `SELECT ${LIGHT} FROM control_requests`;
    if (status) { params.push(status); sql += ` WHERE status = $1`; }
    sql += ` ORDER BY created_at DESC LIMIT ${Math.min(parseInt(limit) || 100, 300)}`;
    const r = await pool.query(sql, params);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- FILA DO AGENTE (skill /controli9) ---------- */
router.get('/pending', authMiddleware, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${LIGHT} FROM control_requests
       WHERE status IN ('NA_FILA','EM_ANALISE')
       ORDER BY created_at ASC LIMIT 50`);
    res.json({ items: r.rows, count: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- CRIAR ---------- */
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { request, file } = req.body || {};
    const txt = (request || '').trim();
    if (!txt && !file) return res.status(400).json({ error: 'Envie um texto ou um arquivo' });
    if (file && file.content_b64 && file.content_b64.length > MAX_B64)
      return res.status(413).json({ error: 'Arquivo acima do limite de 8 MB' });

    const r = await pool.query(
      `INSERT INTO control_requests (user_id, user_name, request, status, file_name, file_size, file_b64)
       VALUES ($1,$2,$3,'NA_FILA',$4,$5,$6) RETURNING id, status, created_at`,
      [req.user.id, req.user.name || req.user.email || null, txt || null,
       file?.name || null, file?.size || null, file?.content_b64 || null]);

    res.json({ ok: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- DETALHE ---------- */
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${LIGHT} FROM control_requests WHERE id = $1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Solicitação não encontrada' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- DOWNLOAD DO ANEXO ENVIADO ---------- */
router.get('/:id/file', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT file_name, file_b64 FROM control_requests WHERE id = $1', [req.params.id]);
    const row = r.rows[0];
    if (!row || !row.file_b64) return res.status(404).json({ error: 'Sem anexo' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name || 'anexo')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(row.file_b64, 'base64'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- DOWNLOAD DA RESPOSTA ---------- */
router.get('/:id/result-file', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT result_file_name, result_file_b64 FROM control_requests WHERE id = $1', [req.params.id]);
    const row = r.rows[0];
    if (!row || !row.result_file_b64) return res.status(404).json({ error: 'Sem arquivo de resposta' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.result_file_name || 'resposta')}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(row.result_file_b64, 'base64'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- REIVINDICAR (agente assume o card) ---------- */
router.post('/:id/claim', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE control_requests SET status='EM_ANALISE', claimed_at=NOW()
       WHERE id=$1 AND status='NA_FILA' RETURNING id, status, claimed_at`, [req.params.id]);
    if (!r.rows[0]) return res.status(409).json({ error: 'Card não está NA_FILA' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- RESPONDER ---------- */
router.post('/:id/result', authMiddleware, async (req, res) => {
  try {
    const { result, file_name, file_b64, error } = req.body || {};
    if (!result && !file_b64 && !error)
      return res.status(400).json({ error: 'Envie result, file_b64 ou error' });
    if (file_b64 && file_b64.length > MAX_B64)
      return res.status(413).json({ error: 'Arquivo de resposta acima do limite de 8 MB' });

    const status = error ? 'FALHA' : 'RESPONDIDO';
    const r = await pool.query(
      `UPDATE control_requests
       SET status=$1, result=$2, result_file_name=$3, result_file_b64=$4, error=$5, answered_at=NOW()
       WHERE id=$6 RETURNING id, status, answered_at`,
      [status, result || null, file_name || null, file_b64 || null, error || null, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Solicitação não encontrada' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------- EXCLUIR ---------- */
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM control_requests WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
