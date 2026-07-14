// src/routes/explorer.js
// Sprint 1 — BE-1 (Stories CRUD + Board) e BE-2 (Dashboard)
// Rewrite completo — substitui v1 que consultava tabelas obsoletas.

import { Router } from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// ─── Startup: garante unique constraint em jira_key ───
(async () => {
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_us_jira_key_uniq ON user_stories(jira_key)
    `);
  } catch (e) {
    console.warn('[explorer] idx_us_jira_key_uniq already exists or error:', e.message);
  }
})();

// ---------- helpers ----------
function toInt(v, def = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// ============================================================
// BE-1  STORIES  CRUD
// ============================================================

// GET /api/explorer/stories?board_status=&sprint=&type=&assigned_to=&search=&limit=&offset=
router.get('/explorer/stories', authMiddleware, async (req, res) => {
  try {
    const { board_status, sprint, type, assigned_to, search } = req.query;
    const limit  = Math.min(toInt(req.query.limit, 100), 500);
    const offset = toInt(req.query.offset, 0);

    const where = [];
    const params = [];
    if (board_status) { params.push(board_status); where.push(`us.board_status = $${params.length}`); }
    if (sprint)       { params.push(sprint);       where.push(`us.sprint = $${params.length}`); }
    if (type)         { params.push(type);         where.push(`us.type = $${params.length}`); }
    if (assigned_to)  { params.push(toInt(assigned_to)); where.push(`us.assigned_to = $${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      where.push(`(us.jira_key ILIKE $${params.length} OR us.title ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM user_stories us ${whereSql}`,
      params
    );

    params.push(limit); params.push(offset);
    const { rows } = await pool.query(`
      SELECT us.*, u.name AS assigned_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
        FROM user_stories us
        LEFT JOIN users u  ON u.id  = us.assigned_to
        LEFT JOIN orgs  o1 ON o1.id = us.src_org_id
        LEFT JOIN orgs  o2 ON o2.id = us.tgt_org_id
        ${whereSql}
        ORDER BY
          CASE us.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
          us.updated_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ ok: true, total: countRes.rows[0].total, items: rows });
  } catch (e) {
    console.error('[explorer/stories GET]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/stories/:jiraKey
router.get('/explorer/stories/:jiraKey', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT us.*, u.name AS assigned_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
        FROM user_stories us
        LEFT JOIN users u  ON u.id  = us.assigned_to
        LEFT JOIN orgs  o1 ON o1.id = us.src_org_id
        LEFT JOIN orgs  o2 ON o2.id = us.tgt_org_id
       WHERE us.jira_key = $1
    `, [req.params.jiraKey]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Story not found' });

    // Deploy runs vinculados
    const deploys = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name
        FROM deploy_runs dr
        LEFT JOIN users u ON u.id = dr.deployed_by
       WHERE dr.us_id = $1
       ORDER BY dr.created_at DESC
    `, [rows[0].id]);

    res.json({ ok: true, story: rows[0], deploy_runs: deploys.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/stories
// body: { jira_key, title, type?, priority?, board_status?, src_org_id?, tgt_org_id?, sprint?, assigned_to? }
router.post('/explorer/stories', authMiddleware, async (req, res) => {
  try {
    const {
      jira_key, title,
      type = 'RELEASE', priority = 'media', board_status = 'todo',
      src_org_id = null, tgt_org_id = null,
      sprint = null, assigned_to = null
    } = req.body || {};
    if (!jira_key || !title)
      return res.status(400).json({ ok: false, error: 'jira_key and title are required' });

    const { rows } = await pool.query(`
      INSERT INTO user_stories
        (jira_key, title, type, priority, board_status, src_org_id, tgt_org_id, sprint, assigned_to, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, NOW(), NOW())
      ON CONFLICT (jira_key) DO NOTHING
      RETURNING *
    `, [jira_key, title, type, priority, board_status, src_org_id, tgt_org_id, sprint, assigned_to]);

    if (!rows.length)
      return res.status(409).json({ ok: false, error: 'jira_key already exists' });
    res.json({ ok: true, story: rows[0] });
  } catch (e) {
    console.error('[explorer/stories POST]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/explorer/stories/:jiraKey
router.patch('/explorer/stories/:jiraKey', authMiddleware, async (req, res) => {
  try {
    const allowed = [
      'title','type','priority','board_status','src_org_id','tgt_org_id',
      'sprint','assigned_to','oe_id'
    ];
    const sets = [];
    const params = [];
    for (const k of allowed) {
      if (k in req.body) {
        params.push(req.body[k]);
        sets.push(`${k} = $${params.length}`);
      }
    }
    if (!sets.length)
      return res.status(400).json({ ok: false, error: 'nothing to update' });
    sets.push(`updated_at = NOW()`);
    params.push(req.params.jiraKey);

    const { rows } = await pool.query(
      `UPDATE user_stories SET ${sets.join(', ')} WHERE jira_key = $${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Story not found' });
    res.json({ ok: true, story: rows[0] });
  } catch (e) {
    console.error('[explorer/stories PATCH]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// BE-1  BOARD  (Kanban agrupado por board_status)
// ============================================================
// GET /api/explorer/board?sprint=&assigned_to=
router.get('/explorer/board', authMiddleware, async (req, res) => {
  try {
    const { sprint, assigned_to } = req.query;
    const where = [];
    const params = [];
    if (sprint)      { params.push(sprint);             where.push(`us.sprint = $${params.length}`); }
    if (assigned_to) { params.push(toInt(assigned_to)); where.push(`us.assigned_to = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT us.id, us.jira_key, us.title, us.type, us.board_status,
             us.priority, us.sprint, us.oe_id, us.updated_at,
             u.name AS assigned_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
        FROM user_stories us
        LEFT JOIN users u  ON u.id  = us.assigned_to
        LEFT JOIN orgs  o1 ON o1.id = us.src_org_id
        LEFT JOIN orgs  o2 ON o2.id = us.tgt_org_id
        ${whereSql}
        ORDER BY
          CASE us.priority WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
          us.updated_at DESC
    `, params);

    const columns = ['todo', 'prog', 'review', 'deploy', 'done'];
    const board = Object.fromEntries(columns.map(c => [c, []]));
    for (const r of rows) {
      const col = board[r.board_status] !== undefined ? r.board_status : 'todo';
      board[col].push(r);
    }
    res.json({ ok: true, columns, board, total: rows.length });
  } catch (e) {
    console.error('[explorer/board]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// BE-2  DASHBOARD  (métricas agregadas)
// GET /api/explorer/dashboard?gold_org_id=36
// ============================================================
router.get('/explorer/dashboard', authMiddleware, async (req, res) => {
  try {
    const goldOrgId = toInt(req.query.gold_org_id, null);

    // Org gold (query ou is_default_gold)
    const goldRow = goldOrgId
      ? await pool.query(`SELECT id, name, drift_summary FROM orgs WHERE id = $1`, [goldOrgId])
      : await pool.query(`SELECT id, name, drift_summary FROM orgs WHERE is_default_gold = true LIMIT 1`);
    const gold = goldRow.rows[0] || null;

    // Stories por board_status
    const storiesByStatus = await pool.query(`
      SELECT board_status, COUNT(*)::int AS total
      FROM user_stories GROUP BY board_status ORDER BY board_status
    `);

    // Stories por type
    const storiesByType = await pool.query(`
      SELECT type, COUNT(*)::int AS total
      FROM user_stories GROUP BY type ORDER BY type
    `);

    // Deploy runs últimos 30 dias
    const deploys30 = await pool.query(`
      SELECT status, COUNT(*)::int AS total
      FROM deploy_runs
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY status
    `);

    // Equalizações últimos 30 dias
    const eq30 = await pool.query(`
      SELECT status, COUNT(*)::int AS total
      FROM eq_jobs
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY status
    `);

    // Pending merges
    const pendingRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM pending_merges`
    );

    // Últimos drift_results do gold (top 10)
    let latestDrifts = [];
    if (gold) {
      const ld = await pool.query(`
        SELECT dr.id, dr.component_name, dr.component_type,
               dr.status, dr.detected_at,
               o.name AS dest_org_name
          FROM drift_results dr
          JOIN orgs o ON o.id = dr.dest_org_id
         WHERE dr.gold_org_id = $1
         ORDER BY dr.detected_at DESC
         LIMIT 10
      `, [gold.id]);
      latestDrifts = ld.rows;
    }

    // Orgs do Explorer
    const orgsRes = await pool.query(`
      SELECT id, name, org_type, is_default_gold, drift_summary
      FROM orgs WHERE id IN (36, 100, 133) ORDER BY id
    `);

    res.json({
      ok: true,
      gold_org: gold ? { id: gold.id, name: gold.name } : null,
      stories_by_status: storiesByStatus.rows,
      stories_by_type:   storiesByType.rows,
      deploys_30d:       deploys30.rows,
      equalizations_30d: eq30.rows,
      pending_merges:    pendingRes.rows[0].total,
      drift_summary:     gold?.drift_summary || null,
      latest_drifts:     latestDrifts,
      explorer_orgs:     orgsRes.rows
    });
  } catch (e) {
    console.error('[explorer/dashboard]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
