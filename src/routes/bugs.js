import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

const STATUSES = [
  'BACKLOG','EM_ANALISE','EM_DESENVOLVIMENTO','AGUARDANDO_DEPLOY',
  'DEPLOY_EXECUTADO','CORRECAO_APLICADA','AGUARDANDO_PASSOS_MANUAIS',
  'EM_TESTES_UNITARIOS','EM_TESTES_FUNCIONAIS','CONCLUIDO'
];

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bug_cards (
      id SERIAL PRIMARY KEY,
      code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(400) NOT NULL,
      obj VARCHAR(60),
      section VARCHAR(100),
      problem TEXT,
      root_cause TEXT,
      correction TEXT,
      claude_exec TEXT,
      manual_step TEXT,
      effort VARCHAR(20),
      blocked VARCHAR(100),
      status VARCHAR(40) DEFAULT 'BACKLOG',
      dev_h NUMERIC(5,2) DEFAULT 0,
      margin_h NUMERIC(5,2) DEFAULT 0,
      unit_h NUMERIC(5,2) DEFAULT 0,
      func_h NUMERIC(5,2) DEFAULT 0,
      total_h NUMERIC(5,2) DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_bug_status ON bug_cards(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_bug_code ON bug_cards(code)');
    res.json({ status: 'ok', table: 'bug_cards' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List all ──
router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM bug_cards ORDER BY id');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ──
router.get('/stats', async (req, res) => {
  try {
    const r = await pool.query(`SELECT status, COUNT(*)::int as count, 
      COALESCE(SUM(total_h),0)::numeric(7,2) as hours 
      FROM bug_cards GROUP BY status ORDER BY status`);
    const total = await pool.query(`SELECT COUNT(*)::int as total, 
      COALESCE(SUM(total_h),0)::numeric(7,2) as hours FROM bug_cards`);
    res.json({ byStatus: r.rows, total: total.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get one ──
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM bug_cards WHERE id = $1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update status (+ optional notes) ──
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status', valid: STATUSES });
    }
    const sets = [];
    const vals = [];
    let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(notes); }
    sets.push(`updated_at = NOW()`);
    if (sets.length < 2) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE bug_cards SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bulk update status by code ──
router.post('/bulk-status', async (req, res) => {
  try {
    const { codes, status, notes } = req.body;
    if (!codes || !status) return res.status(400).json({ error: 'codes[] and status required' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await pool.query(
      `UPDATE bug_cards SET status = $1, notes = COALESCE($2, notes), updated_at = NOW() 
       WHERE code = ANY($3) RETURNING code, status`,
      [status, notes || null, codes]
    );
    res.json({ updated: r.rows.length, cards: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Seed data ──
router.post('/seed', async (req, res) => {
  try {
    const existing = await pool.query('SELECT COUNT(*)::int as c FROM bug_cards');
    if (existing.rows[0].c > 0) {
      return res.json({ status: 'already_seeded', count: existing.rows[0].c });
    }
    const items = req.body.items;
    if (!items || !items.length) return res.status(400).json({ error: 'items[] required' });
    let inserted = 0;
    for (const it of items) {
      try {
        await pool.query(
          `INSERT INTO bug_cards (code,name,obj,section,problem,root_cause,correction,claude_exec,manual_step,effort,blocked,status,dev_h,margin_h,unit_h,func_h,total_h)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [it.code,it.name,it.obj,it.section,it.problem,it.root_cause,it.correction,
           it.claude_exec,it.manual_step,it.effort,it.blocked||null,'BACKLOG',
           it.dev_h||0,it.margin_h||0,it.unit_h||0,it.func_h||0,it.total_h||0]
        );
        inserted++;
      } catch (e) {
        if (e.code !== '23505') throw e; // ignore duplicates
      }
    }
    res.json({ status: 'seeded', inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
