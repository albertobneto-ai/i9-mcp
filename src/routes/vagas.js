import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

const STATUSES = ['radar', 'aplicada', 'triagem', 'entrevista', 'proposta', 'descartada'];

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS vagas_radar (
      id           SERIAL PRIMARY KEY,
      external_id  VARCHAR(120),
      source       VARCHAR(40) NOT NULL DEFAULT 'indeed',
      title        VARCHAR(400) NOT NULL,
      company      VARCHAR(200),
      location     VARCHAR(200),
      work_model   VARCHAR(30),
      job_type     VARCHAR(60),
      url          TEXT,
      posted_on    DATE,
      fit          VARCHAR(10) NOT NULL DEFAULT 'media',
      fit_reason   TEXT,
      tags         TEXT,
      status       VARCHAR(20) NOT NULL DEFAULT 'radar',
      notes        TEXT,
      applied_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_vagas_url ON vagas_radar(url)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_status ON vagas_radar(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_fit ON vagas_radar(fit)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_updated ON vagas_radar(updated_at DESC)');
    res.json({ status: 'ok', table: 'vagas_radar' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/vagas — list + stats ──
router.get('/', async (req, res) => {
  try {
    const { status, fit, search, limit = 200, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (fit) { conditions.push(`fit = $${idx++}`); params.push(fit); }
    if (search) {
      conditions.push(`(title ILIKE $${idx} OR company ILIKE $${idx} OR tags ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(parseInt(limit), parseInt(offset));
    const data = await pool.query(
      `SELECT * FROM vagas_radar ${where}
       ORDER BY CASE fit WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                posted_on DESC NULLS LAST, id DESC
       LIMIT $${idx++} OFFSET $${idx++}`, params);

    const stats = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM vagas_radar GROUP BY status`);
    const byStatus = {};
    STATUSES.forEach(s => { byStatus[s] = 0; });
    stats.rows.forEach(r => { byStatus[r.status] = r.n; });

    res.json({ count: data.rows.length, stats: byStatus, vagas: data.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vagas — create one ──
router.post('/', async (req, res) => {
  try {
    const v = req.body || {};
    if (!v.title) return res.status(400).json({ error: 'title is required' });
    const r = await pool.query(
      `INSERT INTO vagas_radar
        (external_id, source, title, company, location, work_model, job_type,
         url, posted_on, fit, fit_reason, tags, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title, company = EXCLUDED.company,
         location = EXCLUDED.location, fit = EXCLUDED.fit,
         fit_reason = EXCLUDED.fit_reason, tags = EXCLUDED.tags,
         updated_at = NOW()
       RETURNING *`,
      [v.external_id || null, v.source || 'indeed', v.title, v.company || null,
       v.location || null, v.work_model || null, v.job_type || null,
       v.url || null, v.posted_on || null, v.fit || 'media', v.fit_reason || null,
       v.tags || null, v.status || 'radar', v.notes || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vagas/bulk — import a batch ──
router.post('/bulk', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : (req.body.vagas || []);
    if (!list.length) return res.status(400).json({ error: 'empty payload' });

    let inserted = 0, updated = 0;
    for (const v of list) {
      if (!v.title) continue;
      const r = await pool.query(
        `INSERT INTO vagas_radar
          (external_id, source, title, company, location, work_model, job_type,
           url, posted_on, fit, fit_reason, tags, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (url) DO UPDATE SET
           title = EXCLUDED.title, company = EXCLUDED.company,
           location = EXCLUDED.location, work_model = EXCLUDED.work_model,
           job_type = EXCLUDED.job_type, posted_on = EXCLUDED.posted_on,
           fit = EXCLUDED.fit, fit_reason = EXCLUDED.fit_reason,
           tags = EXCLUDED.tags, updated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [v.external_id || null, v.source || 'indeed', v.title, v.company || null,
         v.location || null, v.work_model || null, v.job_type || null,
         v.url || null, v.posted_on || null, v.fit || 'media', v.fit_reason || null,
         v.tags || null, v.status || 'radar', v.notes || null]);
      if (r.rows[0] && r.rows[0].is_new) inserted++; else updated++;
    }
    res.json({ inserted, updated, total: list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/vagas/:id ──
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'company', 'location', 'work_model', 'job_type',
                     'url', 'fit', 'fit_reason', 'tags', 'status', 'notes'];
    const fields = [];
    const params = [];
    let idx = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(req.body[key]);
      }
    }
    if (req.body.status === 'aplicada') fields.push('applied_at = COALESCE(applied_at, NOW())');
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE vagas_radar SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Vaga not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/vagas/:id ──
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM vagas_radar WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Vaga not found' });
    res.json({ deleted: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
