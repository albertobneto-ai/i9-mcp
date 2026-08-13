import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS tracelog_results (
      id              SERIAL PRIMARY KEY,
      trace_id        VARCHAR(20) NOT NULL UNIQUE,
      mode            VARCHAR(20) NOT NULL DEFAULT 'realtime',
      phase           VARCHAR(20) NOT NULL DEFAULT 'done',
      org             VARCHAR(20) NOT NULL,
      org_id          INTEGER,
      user_alias      VARCHAR(50),
      user_name       VARCHAR(100),
      user_id         VARCHAR(18),
      user_type       VARCHAR(20),
      status          VARCHAR(20) NOT NULL DEFAULT 'monitoring',
      duration        VARCHAR(20),
      summary         TEXT,
      reported_issue  TEXT,
      chain_json      JSONB,
      diagnosis_json  JSONB,
      limits_json     JSONB,
      logins_json     JSONB,
      members_json    JSONB,
      permissions_json JSONB,
      metadata_json   JSONB,
      audit_json      JSONB,
      record_json     JSONB,
      raw_log         TEXT,
      log_id          VARCHAR(18),
      trace_flag_id   VARCHAR(18),
      debug_level_id  VARCHAR(18),
      t0              TIMESTAMPTZ,
      t1              TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_org ON tracelog_results(org)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_status ON tracelog_results(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_user ON tracelog_results(user_alias)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_mode ON tracelog_results(mode)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_phase ON tracelog_results(phase)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_tl_created ON tracelog_results(created_at DESC)');
    res.json({ status: 'ok', table: 'tracelog_results' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Next trace_id ──
async function nextTraceId() {
  const r = await pool.query(`SELECT trace_id FROM tracelog_results ORDER BY id DESC LIMIT 1`);
  if (r.rows.length === 0) return 'TRC-0001';
  const last = parseInt(r.rows[0].trace_id.replace('TRC-', ''), 10);
  return `TRC-${String(last + 1).padStart(4, '0')}`;
}

// ── GET /api/tracelog — list with filters ──
router.get('/', async (req, res) => {
  try {
    const { org, status, mode, phase, user, limit = 50, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (org) { conditions.push(`org = $${idx++}`); params.push(org.toUpperCase()); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (mode) { conditions.push(`mode = $${idx++}`); params.push(mode); }
    if (phase) {
      const phases = phase.split(',');
      conditions.push(`phase = ANY($${idx++})`);
      params.push(phases);
    }
    if (user) { conditions.push(`(user_alias ILIKE $${idx} OR user_name ILIKE $${idx})`); params.push(`%${user}%`); idx++; }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countR = await pool.query(`SELECT COUNT(*) FROM tracelog_results ${where}`, params);
    
    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const dataR = await pool.query(
      `SELECT trace_id, mode, phase, org, org_id, user_alias, user_name, user_id, user_type,
              status, duration, summary, reported_issue,
              chain_json, diagnosis_json, limits_json, logins_json, members_json,
              permissions_json, metadata_json, audit_json, record_json,
              log_id, trace_flag_id, debug_level_id, t0, t1, created_at, updated_at
       FROM tracelog_results ${where}
       ORDER BY created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params
    );

    res.json({
      count: parseInt(countR.rows[0].count),
      limit: parseInt(limit),
      offset: parseInt(offset),
      traces: dataR.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/tracelog/:trace_id — single trace ──
router.get('/:trace_id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM tracelog_results WHERE trace_id = $1`,
      [req.params.trace_id.toUpperCase()]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Trace not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/tracelog — create new trace ──
router.post('/', async (req, res) => {
  try {
    const traceId = await nextTraceId();
    const {
      mode = 'realtime', phase = 'monitoring', org, org_id,
      user_alias, user_name, user_id, user_type,
      status = 'monitoring', duration, summary, reported_issue,
      chain_json, diagnosis_json, limits_json, logins_json, members_json,
      permissions_json, metadata_json, audit_json, record_json,
      raw_log, log_id, trace_flag_id, debug_level_id, t0, t1
    } = req.body;

    if (!org) return res.status(400).json({ error: 'org is required' });

    const r = await pool.query(
      `INSERT INTO tracelog_results (
        trace_id, mode, phase, org, org_id,
        user_alias, user_name, user_id, user_type,
        status, duration, summary, reported_issue,
        chain_json, diagnosis_json, limits_json, logins_json, members_json,
        permissions_json, metadata_json, audit_json, record_json,
        raw_log, log_id, trace_flag_id, debug_level_id, t0, t1
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
      ) RETURNING trace_id, phase, status, created_at`,
      [
        traceId, mode, phase, org.toUpperCase(), org_id,
        user_alias, user_name, user_id, user_type,
        status, duration, summary, reported_issue,
        chain_json ? JSON.stringify(chain_json) : null,
        diagnosis_json ? JSON.stringify(diagnosis_json) : null,
        limits_json ? JSON.stringify(limits_json) : null,
        logins_json ? JSON.stringify(logins_json) : null,
        members_json ? JSON.stringify(members_json) : null,
        permissions_json ? JSON.stringify(permissions_json) : null,
        metadata_json ? JSON.stringify(metadata_json) : null,
        audit_json ? JSON.stringify(audit_json) : null,
        record_json ? JSON.stringify(record_json) : null,
        raw_log, log_id, trace_flag_id, debug_level_id,
        t0 || new Date().toISOString(), t1
      ]
    );

    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/tracelog/:trace_id — update phase/results ──
router.patch('/:trace_id', async (req, res) => {
  try {
    const traceId = req.params.trace_id.toUpperCase();
    const existing = await pool.query(`SELECT id FROM tracelog_results WHERE trace_id = $1`, [traceId]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Trace not found' });

    const fields = [];
    const params = [];
    let idx = 1;

    const allowed = [
      'phase', 'status', 'duration', 'summary', 'reported_issue',
      'chain_json', 'diagnosis_json', 'limits_json', 'logins_json', 'members_json',
      'permissions_json', 'metadata_json', 'audit_json', 'record_json',
      'raw_log', 'log_id', 'trace_flag_id', 'debug_level_id', 't1'
    ];
    const jsonFields = [
      'chain_json', 'diagnosis_json', 'limits_json', 'logins_json', 'members_json',
      'permissions_json', 'metadata_json', 'audit_json', 'record_json'
    ];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(jsonFields.includes(key) && typeof req.body[key] === 'object'
          ? JSON.stringify(req.body[key])
          : req.body[key]
        );
      }
    }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    fields.push(`updated_at = NOW()`);
    params.push(traceId);

    await pool.query(
      `UPDATE tracelog_results SET ${fields.join(', ')} WHERE trace_id = $${idx}`,
      params
    );

    const updated = await pool.query(`SELECT trace_id, phase, status, updated_at FROM tracelog_results WHERE trace_id = $1`, [traceId]);
    res.json(updated.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
