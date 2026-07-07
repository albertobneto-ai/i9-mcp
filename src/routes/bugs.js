import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

const STATUSES = [
  'BACKLOG','EM_ANALISE','EM_DESENVOLVIMENTO','AGUARDANDO_DEPLOY',
  'DEPLOY_EXECUTADO','CORRECAO_APLICADA','AGUARDANDO_PASSOS_MANUAIS',
  'EM_TESTES_UNITARIOS','EM_TESTES_FUNCIONAIS','CONCLUIDO'
];

const IN_PROGRESS = ['EM_ANALISE','EM_DESENVOLVIMENTO','AGUARDANDO_DEPLOY',
  'DEPLOY_EXECUTADO','CORRECAO_APLICADA','AGUARDANDO_PASSOS_MANUAIS',
  'EM_TESTES_UNITARIOS','EM_TESTES_FUNCIONAIS'];

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS bug_cards (
      id SERIAL PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE,
      name VARCHAR(400) NOT NULL, obj VARCHAR(60), section VARCHAR(100),
      problem TEXT, root_cause TEXT, correction TEXT, claude_exec TEXT,
      manual_step TEXT, effort VARCHAR(20), blocked VARCHAR(100),
      status VARCHAR(40) DEFAULT 'BACKLOG',
      dev_h NUMERIC(5,2) DEFAULT 0, margin_h NUMERIC(5,2) DEFAULT 0,
      unit_h NUMERIC(5,2) DEFAULT 0, func_h NUMERIC(5,2) DEFAULT 0,
      total_h NUMERIC(5,2) DEFAULT 0, notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW()
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

// ── Dashboard stats (single call) ──
router.get('/stats', async (req, res) => {
  try {
    const [byStatus, bySection, byAutonomy, totals, done, blocked, inProg, hours] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int as count, COALESCE(SUM(total_h),0)::numeric(7,2) as hours FROM bug_cards GROUP BY status ORDER BY status`),
      pool.query(`SELECT section, COUNT(*)::int as count, COALESCE(SUM(total_h),0)::numeric(7,2) as hours, SUM(CASE WHEN status='CONCLUIDO' THEN 1 ELSE 0 END)::int as done FROM bug_cards GROUP BY section ORDER BY section`),
      pool.query(`SELECT CASE WHEN claude_exec ILIKE 'SIM%' THEN 'SIM' WHEN claude_exec ILIKE '%PARCIAL%' THEN 'PARCIAL' ELSE 'NAO' END as tipo, COUNT(*)::int as count FROM bug_cards GROUP BY 1`),
      pool.query(`SELECT COUNT(*)::int as total, COALESCE(SUM(total_h),0)::numeric(7,2) as hours, COALESCE(SUM(dev_h),0)::numeric(7,2) as dev_h, COALESCE(SUM(margin_h),0)::numeric(7,2) as margin_h, COALESCE(SUM(unit_h),0)::numeric(7,2) as unit_h, COALESCE(SUM(func_h),0)::numeric(7,2) as func_h FROM bug_cards`),
      pool.query(`SELECT COUNT(*)::int as count, COALESCE(SUM(total_h),0)::numeric(7,2) as hours FROM bug_cards WHERE status='CONCLUIDO'`),
      pool.query(`SELECT COUNT(*)::int as count FROM bug_cards WHERE blocked IS NOT NULL`),
      pool.query(`SELECT COUNT(*)::int as count FROM bug_cards WHERE status = ANY($1)`, [IN_PROGRESS]),
      pool.query(`SELECT COALESCE(SUM(CASE WHEN status='CONCLUIDO' THEN total_h ELSE 0 END),0)::numeric(7,2) as consumed, COALESCE(SUM(CASE WHEN status!='CONCLUIDO' THEN total_h ELSE 0 END),0)::numeric(7,2) as remaining FROM bug_cards`)
    ]);
    const t = totals.rows[0];
    const avgPerItem = t.total > 0 ? (parseFloat(t.hours) / t.total).toFixed(2) : 0;
    const unblocked = t.total - blocked.rows[0].count;
    res.json({
      byStatus: byStatus.rows,
      bySection: bySection.rows,
      byAutonomy: byAutonomy.rows,
      total: t,
      done: done.rows[0],
      blocked: blocked.rows[0].count,
      unblocked,
      inProgress: inProg.rows[0].count,
      hoursConsumed: parseFloat(hours.rows[0].consumed),
      hoursRemaining: parseFloat(hours.rows[0].remaining),
      avgPerItem: parseFloat(avgPerItem)
    });
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

// ── Update status ──
router.patch('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status', valid: STATUSES });
    const sets = []; const vals = []; let idx = 1;
    if (status) { sets.push(`status = $${idx++}`); vals.push(status); }
    if (notes !== undefined) { sets.push(`notes = $${idx++}`); vals.push(notes); }
    sets.push(`updated_at = NOW()`);
    if (sets.length < 2) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const r = await pool.query(`UPDATE bug_cards SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Bulk update ──
router.post('/bulk-status', async (req, res) => {
  try {
    const { codes, status, notes } = req.body;
    if (!codes || !status) return res.status(400).json({ error: 'codes[] and status required' });
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await pool.query(`UPDATE bug_cards SET status = $1, notes = COALESCE($2, notes), updated_at = NOW() WHERE code = ANY($3) RETURNING code, status`, [status, notes || null, codes]);
    res.json({ updated: r.rows.length, cards: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Seed ──
router.post('/seed', async (req, res) => {
  try {
    const existing = await pool.query('SELECT COUNT(*)::int as c FROM bug_cards');
    if (existing.rows[0].c > 0) return res.json({ status: 'already_seeded', count: existing.rows[0].c });
    const items = req.body.items;
    if (!items || !items.length) return res.status(400).json({ error: 'items[] required' });
    let inserted = 0;
    for (const it of items) {
      try {
        await pool.query(`INSERT INTO bug_cards (code,name,obj,section,problem,root_cause,correction,claude_exec,manual_step,effort,blocked,status,dev_h,margin_h,unit_h,func_h,total_h) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [it.code,it.name,it.obj,it.section,it.problem,it.root_cause,it.correction,it.claude_exec,it.manual_step,it.effort,it.blocked||null,'BACKLOG',it.dev_h||0,it.margin_h||0,it.unit_h||0,it.func_h||0,it.total_h||0]);
        inserted++;
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    res.json({ status: 'seeded', inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
