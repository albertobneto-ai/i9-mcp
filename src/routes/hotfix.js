// src/routes/hotfix.js
// Hotfix Registry — controle de correções com versionamento v1/v2 e esteira de orgs.
// Segue o padrão de deploys.js/specs.js. Tabela própria (hotfix), init idempotente.

import express from 'express';
import pool from '../config/db.js';

const router = express.Router();

// ── Init idempotente da tabela hotfix ──
export async function initHotfixTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS hotfix (
    id SERIAL PRIMARY KEY,
    codigo VARCHAR(20) UNIQUE NOT NULL,
    titulo VARCHAR(255) NOT NULL,
    descricao TEXT,
    componente VARCHAR(255),
    tipo VARCHAR(40) DEFAULT 'Apex',
    area VARCHAR(80),
    org_origem VARCHAR(40),
    origem_org_id INT,
    codigo_v1 TEXT,
    codigo_v2 TEXT,
    hash_v1 VARCHAR(80),
    hash_v2 VARCHAR(80),
    deploy_id_homol VARCHAR(40),
    deploy_id_prod VARCHAR(40),
    deploy_id_arqevery VARCHAR(40),
    status_arqevery VARCHAR(20) DEFAULT 'na',
    status_homol VARCHAR(20) DEFAULT 'na',
    status_prod VARCHAR(20) DEFAULT 'todo',
    backfill_arqevery VARCHAR(20) DEFAULT 'na',
    posicao_atual VARCHAR(20),
    backup_ref VARCHAR(255),
    bug_ref VARCHAR(40),
    meta JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_hotfix_codigo ON hotfix(codigo)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_hotfix_created ON hotfix(created_at DESC)');
}

// Estados válidos por org: passed | current | todo | backfill | na | skip
const VALID_STATES = ['passed', 'current', 'todo', 'backfill', 'na', 'skip'];

// ── GET /api/hotfix/list — lista com resumo ──
router.get('/list', async (req, res) => {
  const { area = '', posicao = '', limit = 100, offset = 0 } = req.query;
  const limitN = Math.min(parseInt(limit, 10) || 100, 200);
  const offsetN = Math.max(parseInt(offset, 10) || 0, 0);

  const where = [];
  const params = [];
  if (area) { params.push(area); where.push(`area = $${params.length}`); }
  if (posicao) { params.push(posicao); where.push(`posicao_atual = $${params.length}`); }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const { rows } = await pool.query(
      `SELECT * FROM hotfix ${whereClause}
       ORDER BY created_at DESC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );

    // Resumo agregado
    const summary = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status_homol = 'current' OR posicao_atual = 'HOMOL') as em_homol,
        COUNT(*) FILTER (WHERE status_prod = 'todo') as falta_prod,
        COUNT(*) FILTER (WHERE backfill_arqevery = 'backfill') as falta_backfill,
        COUNT(*) FILTER (WHERE status_prod = 'passed') as em_prod
      FROM hotfix
    `);

    const s = summary.rows[0] || {};
    res.json({
      total: parseInt(s.total, 10) || 0,
      summary: {
        total: parseInt(s.total, 10) || 0,
        em_homol: parseInt(s.em_homol, 10) || 0,
        falta_prod: parseInt(s.falta_prod, 10) || 0,
        falta_backfill: parseInt(s.falta_backfill, 10) || 0,
        em_prod: parseInt(s.em_prod, 10) || 0,
      },
      areas: [...new Set(rows.map(r => r.area).filter(Boolean))],
      items: rows,
    });
  } catch (err) {
    console.error('[hotfix/list] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/hotfix/:codigo — detalhe completo (inclui código v1/v2) ──
router.get('/:codigo', async (req, res) => {
  const codigo = String(req.params.codigo || '').toUpperCase().trim();
  if (!codigo) return res.status(400).json({ error: 'codigo obrigatório' });
  try {
    const { rows } = await pool.query('SELECT * FROM hotfix WHERE UPPER(codigo) = $1', [codigo]);
    if (!rows.length) return res.status(404).json({ error: 'Hotfix não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[hotfix/:codigo] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/hotfix/register — cria/atualiza um hotfix (upsert por codigo) ──
router.post('/register', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.codigo || !b.titulo) {
      return res.status(400).json({ error: 'codigo e titulo são obrigatórios' });
    }
    const codigo = String(b.codigo).toUpperCase().trim();

    const r = await pool.query(
      `INSERT INTO hotfix (
        codigo, titulo, descricao, componente, tipo, area,
        org_origem, origem_org_id, codigo_v1, codigo_v2, hash_v1, hash_v2,
        deploy_id_homol, deploy_id_prod, deploy_id_arqevery,
        status_arqevery, status_homol, status_prod, backfill_arqevery,
        posicao_atual, backup_ref, bug_ref, meta, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, NOW()
      )
      ON CONFLICT (codigo) DO UPDATE SET
        titulo = EXCLUDED.titulo,
        descricao = EXCLUDED.descricao,
        componente = EXCLUDED.componente,
        tipo = EXCLUDED.tipo,
        area = EXCLUDED.area,
        org_origem = EXCLUDED.org_origem,
        origem_org_id = EXCLUDED.origem_org_id,
        codigo_v1 = EXCLUDED.codigo_v1,
        codigo_v2 = EXCLUDED.codigo_v2,
        hash_v1 = EXCLUDED.hash_v1,
        hash_v2 = EXCLUDED.hash_v2,
        deploy_id_homol = EXCLUDED.deploy_id_homol,
        deploy_id_prod = EXCLUDED.deploy_id_prod,
        deploy_id_arqevery = EXCLUDED.deploy_id_arqevery,
        status_arqevery = EXCLUDED.status_arqevery,
        status_homol = EXCLUDED.status_homol,
        status_prod = EXCLUDED.status_prod,
        backfill_arqevery = EXCLUDED.backfill_arqevery,
        posicao_atual = EXCLUDED.posicao_atual,
        backup_ref = EXCLUDED.backup_ref,
        bug_ref = EXCLUDED.bug_ref,
        meta = EXCLUDED.meta,
        updated_at = NOW()
      RETURNING *`,
      [
        codigo, b.titulo, b.descricao || null, b.componente || null,
        b.tipo || 'Apex', b.area || null,
        b.org_origem || null, b.origem_org_id || null,
        b.codigo_v1 || null, b.codigo_v2 || null, b.hash_v1 || null, b.hash_v2 || null,
        b.deploy_id_homol || null, b.deploy_id_prod || null, b.deploy_id_arqevery || null,
        b.status_arqevery || 'na', b.status_homol || 'na', b.status_prod || 'todo',
        b.backfill_arqevery || 'na', b.posicao_atual || null,
        b.backup_ref || null, b.bug_ref || null,
        b.meta ? JSON.stringify(b.meta) : '{}',
      ]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[hotfix/register] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/hotfix/:codigo/estagio — move a posição na esteira ──
router.patch('/:codigo/estagio', async (req, res) => {
  const codigo = String(req.params.codigo || '').toUpperCase().trim();
  const b = req.body || {};
  const fields = [];
  const params = [];
  const allowed = {
    status_arqevery: b.status_arqevery,
    status_homol: b.status_homol,
    status_prod: b.status_prod,
    backfill_arqevery: b.backfill_arqevery,
    posicao_atual: b.posicao_atual,
    deploy_id_prod: b.deploy_id_prod,
    deploy_id_arqevery: b.deploy_id_arqevery,
  };
  for (const [k, v] of Object.entries(allowed)) {
    if (v === undefined) continue;
    if (k.startsWith('status_') || k === 'backfill_arqevery') {
      if (!VALID_STATES.includes(v)) {
        return res.status(400).json({ error: `Estado inválido para ${k}: ${v}` });
      }
    }
    params.push(v);
    fields.push(`${k} = $${params.length}`);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nada para atualizar' });
  params.push(codigo);
  try {
    const r = await pool.query(
      `UPDATE hotfix SET ${fields.join(', ')}, updated_at = NOW()
       WHERE UPPER(codigo) = $${params.length} RETURNING *`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Hotfix não encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[hotfix/estagio] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
