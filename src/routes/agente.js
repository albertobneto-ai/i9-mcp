// src/routes/agente.js — Agente Funcional
// Fluxo faseado: requisito -> caso de uso -> aprovacao -> mapa de componentes.
// Tabelas proprias. NAO toca control_requests.
import express from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

export const AF_STAGES = ['REQUISITO', 'CASO_DE_USO', 'APROVADO', 'MAPA', 'APROVADO_MAPA', 'ARQUITETURA', 'CONCLUIDO'];
const MAX_B64 = 8 * 1024 * 1024 * 1.4;

export async function initAgenteTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS af_sessions (
    id serial PRIMARY KEY,
    user_id int,
    user_name varchar(200),
    title varchar(300) NOT NULL,
    requisito text,
    file_name varchar(300),
    file_b64 text,
    stage varchar(20) NOT NULL DEFAULT 'REQUISITO',
    approved_at timestamptz,
    approval_note text,
    error text,
    progress int NOT NULL DEFAULT 0,
    progress_label varchar(200),
    progress_at timestamptz,
    meta jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS af_artifacts (
    id serial PRIMARY KEY,
    session_id int NOT NULL REFERENCES af_sessions(id) ON DELETE CASCADE,
    kind varchar(20) NOT NULL,
    version int NOT NULL DEFAULT 1,
    content text,
    summary jsonb DEFAULT '{}'::jsonb,
    file_name varchar(300),
    file_b64 text,
    created_at timestamptz DEFAULT now()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_af_artifacts_session ON af_artifacts(session_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_af_sessions_stage ON af_sessions(stage)');
  // colunas de progresso — sessoes criadas antes desta versao
  await pool.query("ALTER TABLE af_sessions ADD COLUMN IF NOT EXISTS progress int NOT NULL DEFAULT 0");
  await pool.query('ALTER TABLE af_sessions ADD COLUMN IF NOT EXISTS progress_label varchar(200)');
  await pool.query('ALTER TABLE af_sessions ADD COLUMN IF NOT EXISTS progress_at timestamptz');
}

const COLS = `id, user_id, user_name, title, requisito, stage, approved_at, approval_note,
  error, meta, created_at, updated_at, file_name,
  progress, progress_label, progress_at,
  (file_b64 IS NOT NULL) AS has_file`;

async function loadArtifacts(sessionId) {
  const r = await pool.query(
    `SELECT id, kind, version, summary, file_name, created_at,
            (file_b64 IS NOT NULL) AS has_file,
            length(content) AS content_len
     FROM af_artifacts WHERE session_id = $1
     ORDER BY kind, version DESC`, [sessionId]);
  return r.rows;
}

// ── GET / — lista sessoes ──
router.get('/', authMiddleware, async (_req, res) => {
  try {
    const r = await pool.query(`SELECT ${COLS} FROM af_sessions ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /queue — sessoes que aguardam trabalho do agente ──
router.get('/queue', authMiddleware, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${COLS} FROM af_sessions
       WHERE stage IN ('REQUISITO','APROVADO','APROVADO_MAPA') ORDER BY created_at ASC`);
    res.json({ items: r.rows, count: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — cria sessao a partir do requisito ──
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { title, requisito, file_name, file_b64 } = req.body || {};
    if (!title || !title.trim()) return res.status(400).json({ error: 'title é obrigatório' });
    if (!requisito && !file_b64) return res.status(400).json({ error: 'Envie requisito ou anexo' });
    if (file_b64 && file_b64.length > MAX_B64) return res.status(413).json({ error: 'Anexo acima de 8 MB' });

    const r = await pool.query(
      `INSERT INTO af_sessions (user_id, user_name, title, requisito, file_name, file_b64, stage)
       VALUES ($1,$2,$3,$4,$5,$6,'REQUISITO') RETURNING ${COLS}`,
      [req.user?.id || null, req.user?.name || null, title.trim(),
       requisito || null, file_name || null, file_b64 || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id — sessao + artefatos ──
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT ${COLS} FROM af_sessions WHERE id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json({ ...r.rows[0], artifacts: await loadArtifacts(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id/file — anexo do requisito ──
router.get('/:id/file', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT file_name, file_b64 FROM af_sessions WHERE id = $1', [req.params.id]);
    const row = r.rows[0];
    if (!row || !row.file_b64) return res.status(404).json({ error: 'Sem anexo' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name || 'anexo')}"`);
    res.send(Buffer.from(row.file_b64, 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /artifact/:aid — conteudo integral de um artefato ──
router.get('/artifact/:aid', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, session_id, kind, version, content, summary, file_name, created_at
       FROM af_artifacts WHERE id = $1`, [req.params.aid]);
    if (!r.rows.length) return res.status(404).json({ error: 'Artefato não encontrado' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /artifact/:aid/file — download do artefato ──
router.get('/artifact/:aid/file', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT file_name, file_b64 FROM af_artifacts WHERE id = $1', [req.params.aid]);
    const row = r.rows[0];
    if (!row || !row.file_b64) return res.status(404).json({ error: 'Sem arquivo' });
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name || 'artefato')}"`);
    res.send(Buffer.from(row.file_b64, 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/artifact — agente grava caso de uso ou mapa ──
router.post('/:id/artifact', authMiddleware, async (req, res) => {
  try {
    const { kind, content, summary, file_name, file_b64 } = req.body || {};
    if (!['CASO_DE_USO', 'MAPA', 'ARQUITETURA'].includes(kind))
      return res.status(400).json({ error: 'kind deve ser CASO_DE_USO, MAPA ou ARQUITETURA' });
    if (!content && !file_b64) return res.status(400).json({ error: 'Envie content ou file_b64' });
    if (file_b64 && file_b64.length > MAX_B64) return res.status(413).json({ error: 'Arquivo acima de 8 MB' });

    const s = await pool.query('SELECT stage FROM af_sessions WHERE id = $1', [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });

    const st = s.rows[0].stage;
    if (kind === 'MAPA' && !['APROVADO', 'MAPA', 'APROVADO_MAPA', 'ARQUITETURA', 'CONCLUIDO'].includes(st))
      return res.status(409).json({ error: 'A especificação exige história funcional aprovada', stage: st });
    if (kind === 'ARQUITETURA' && !['APROVADO_MAPA', 'ARQUITETURA', 'CONCLUIDO'].includes(st))
      return res.status(409).json({ error: 'O desenho de arquitetura exige especificação funcional aprovada', stage: st });

    const v = await pool.query(
      'SELECT COALESCE(MAX(version),0)+1 AS v FROM af_artifacts WHERE session_id=$1 AND kind=$2',
      [req.params.id, kind]);

    const a = await pool.query(
      `INSERT INTO af_artifacts (session_id, kind, version, content, summary, file_name, file_b64)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, version, created_at`,
      [req.params.id, kind, v.rows[0].v, content || null,
       JSON.stringify(summary || {}), file_name || null, file_b64 || null]);

    // Estágio nunca anda para trás: regravar o caso de uso numa sessão já aprovada
    // registra a nova versão sem exigir nova aprovação.
    const ORDER = AF_STAGES;
    const proposed = kind === 'CASO_DE_USO' ? 'CASO_DE_USO'
                   : kind === 'MAPA' ? 'MAPA' : 'CONCLUIDO';
    const current = s.rows[0].stage;
    const nextStage = ORDER.indexOf(proposed) > ORDER.indexOf(current) ? proposed : current;
    // artefato gravado encerra o andamento
    await pool.query(
      `UPDATE af_sessions SET stage=$1, progress=0, progress_label=NULL, progress_at=NULL,
       updated_at=now() WHERE id=$2`, [nextStage, req.params.id]);

    res.status(201).json({ ok: true, artifact: a.rows[0], stage: nextStage });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/progress — o agente reporta andamento ──
router.post('/:id/progress', authMiddleware, async (req, res) => {
  try {
    const { percent, label } = req.body || {};
    const p = Math.max(0, Math.min(100, parseInt(percent, 10) || 0));
    const r = await pool.query(
      `UPDATE af_sessions SET progress=$1, progress_label=$2, progress_at=now(), updated_at=now()
       WHERE id=$3 RETURNING id, progress, progress_label, progress_at`,
      [p, (label || '').slice(0, 200) || null, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/approve — portao entre caso de uso e mapa ──
router.post('/:id/approve', authMiddleware, async (req, res) => {
  try {
    const { note } = req.body || {};
    const s = await pool.query('SELECT stage FROM af_sessions WHERE id=$1', [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    const next = { CASO_DE_USO: 'APROVADO', MAPA: 'APROVADO_MAPA' }[s.rows[0].stage];
    if (!next) return res.status(409).json({
      error: 'Só é possível aprovar com história funcional ou especificação gerada', stage: s.rows[0].stage });

    const r = await pool.query(
      `UPDATE af_sessions SET stage=$1, approved_at=now(), approval_note=$2,
       progress=0, progress_label=NULL, progress_at=NULL, updated_at=now()
       WHERE id=$3 RETURNING ${COLS}`, [next, note || null, req.params.id]);
    res.json({ ok: true, session: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/reject — pede ajuste, volta para REQUISITO ──
router.post('/:id/reject', authMiddleware, async (req, res) => {
  try {
    const { note } = req.body || {};
    if (!note || !note.trim()) return res.status(400).json({ error: 'note é obrigatório ao pedir ajuste' });
    const s = await pool.query('SELECT stage FROM af_sessions WHERE id=$1', [req.params.id]);
    if (!s.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    // ajuste na especificacao volta para o portao dela; nos demais casos volta ao requisito
    const back = ['MAPA', 'APROVADO_MAPA', 'ARQUITETURA', 'CONCLUIDO'].includes(s.rows[0].stage)
      ? 'APROVADO' : 'REQUISITO';
    const r = await pool.query(
      `UPDATE af_sessions SET stage=$1, approval_note=$2, updated_at=now()
       WHERE id=$3 RETURNING ${COLS}`, [back, note.trim(), req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json({ ok: true, session: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/fail — registra falha ──
router.post('/:id/fail', authMiddleware, async (req, res) => {
  try {
    const { error } = req.body || {};
    const r = await pool.query(
      `UPDATE af_sessions SET error=$1, updated_at=now() WHERE id=$2 RETURNING ${COLS}`,
      [error || 'Falha sem motivo informado', req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json({ ok: true, session: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /:id ──
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM af_sessions WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Sessão não encontrada' });
    res.json({ ok: true, deleted: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
