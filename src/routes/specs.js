import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS spec_registry (
      id            SERIAL PRIMARY KEY,
      spec_id       VARCHAR(20) NOT NULL UNIQUE,
      us_number     VARCHAR(50),
      title         VARCHAR(500) NOT NULL,
      type          VARCHAR(20) NOT NULL DEFAULT 'spec',
      version       INTEGER NOT NULL DEFAULT 1,
      status        VARCHAR(20) NOT NULL DEFAULT 'draft',
      org           VARCHAR(20),
      file_url      TEXT,
      file_name     VARCHAR(255),
      file_size     VARCHAR(20),
      changelog     TEXT,
      versions_json JSONB DEFAULT '[]',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spec_type ON spec_registry(type)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spec_status ON spec_registry(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spec_us ON spec_registry(us_number)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_spec_created ON spec_registry(created_at DESC)');
    res.json({ status: 'ok', table: 'spec_registry' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Next spec_id ──
async function nextSpecId() {
  const r = await pool.query(`SELECT spec_id FROM spec_registry ORDER BY id DESC LIMIT 1`);
  if (r.rows.length === 0) return 'SPEC-0001';
  const last = parseInt(r.rows[0].spec_id.replace('SPEC-', ''), 10);
  return `SPEC-${String(last + 1).padStart(4, '0')}`;
}

// ── GET /api/specs — list with filters ──
router.get('/', async (req, res) => {
  try {
    const { type, status, us, search, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (type) { conditions.push(`type = $${idx++}`); params.push(type); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (us) { conditions.push(`us_number = $${idx++}`); params.push(us.toUpperCase()); }
    if (search) {
      conditions.push(`(spec_id ILIKE $${idx} OR title ILIKE $${idx} OR us_number ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countR = await pool.query(`SELECT COUNT(*) FROM spec_registry ${where}`, params);

    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const dataR = await pool.query(
      `SELECT spec_id, us_number, title, type, version, status, org,
              file_url, file_name, file_size, changelog, versions_json,
              created_at, updated_at
       FROM spec_registry ${where}
       ORDER BY updated_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    res.json({
      count: parseInt(countR.rows[0].count),
      specs: dataR.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/specs/:spec_id ──
router.get('/:spec_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM spec_registry WHERE spec_id = $1`,
      [req.params.spec_id.toUpperCase()]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Spec not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/specs — create new spec ──
router.post('/', async (req, res) => {
  try {
    const specId = await nextSpecId();
    const {
      us_number, title, type = 'spec', status = 'draft', org,
      file_url, file_name, file_size, changelog = 'Versão inicial'
    } = req.body;

    if (!title) return res.status(400).json({ error: 'title is required' });

    const now = new Date().toISOString();
    const versions = [{ v: 1, date: now, status, changelog }];

    const r = await pool.query(
      `INSERT INTO spec_registry (spec_id, us_number, title, type, version, status, org,
        file_url, file_name, file_size, changelog, versions_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING spec_id, version, status, created_at`,
      [specId, us_number || null, title, type, 1, status, org || null,
       file_url || null, file_name || null, file_size || null,
       changelog, JSON.stringify(versions)]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/specs/:spec_id — new version or update ──
router.patch('/:spec_id', async (req, res) => {
  try {
    const specId = req.params.spec_id.toUpperCase();
    const existing = await pool.query(`SELECT * FROM spec_registry WHERE spec_id = $1`, [specId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Spec not found' });

    const current = existing.rows[0];
    const {
      new_version, title, status, org,
      file_url, file_name, file_size, changelog
    } = req.body;

    if (new_version) {
      // Create new version
      const newV = current.version + 1;
      const now = new Date().toISOString();
      const versions = current.versions_json || [];

      // Mark previous version as superseded
      versions.forEach(v => { if (v.status === 'published' || v.status === 'draft') v.status = 'superseded'; });

      const newStatus = status || 'published';
      versions.unshift({ v: newV, date: now, status: newStatus, changelog: changelog || `Versão ${newV}` });

      await pool.query(
        `UPDATE spec_registry SET
          version = $1, status = $2, changelog = $3, versions_json = $4,
          file_url = COALESCE($5, file_url), file_name = COALESCE($6, file_name),
          file_size = COALESCE($7, file_size), org = COALESCE($8, org),
          title = COALESCE($9, title), updated_at = NOW()
        WHERE spec_id = $10`,
        [newV, newStatus, changelog || `Versão ${newV}`, JSON.stringify(versions),
         file_url || null, file_name || null, file_size || null,
         org || null, title || null, specId]
      );
    } else {
      // Simple update (no new version)
      const fields = [];
      const params = [];
      let idx = 1;

      const allowed = ['title', 'status', 'org', 'file_url', 'file_name', 'file_size', 'us_number'];
      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          fields.push(`${key} = $${idx++}`);
          params.push(req.body[key]);
        }
      }
      if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

      fields.push('updated_at = NOW()');
      params.push(specId);
      await pool.query(`UPDATE spec_registry SET ${fields.join(', ')} WHERE spec_id = $${idx}`, params);
    }

    const updated = await pool.query(
      `SELECT spec_id, version, status, updated_at FROM spec_registry WHERE spec_id = $1`, [specId]
    );
    res.json(updated.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/specs/:spec_id ──
router.delete('/:spec_id', async (req, res) => {
  try {
    const specId = req.params.spec_id.toUpperCase();
    const r = await pool.query(`DELETE FROM spec_registry WHERE spec_id = $1 RETURNING spec_id`, [specId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Spec not found' });
    res.json({ deleted: specId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
