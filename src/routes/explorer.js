// src/routes/explorer.js
// Sprint 1+2+3 — BE-1 to BE-8 + VA + Dashboard Wiring (Stories, Board, Dashboard, Equalize, Merge, Deploy, Rollback, Drift, Components, History, Log, Vector Agent)

import { Router } from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { computeLcsDiff, diffStatus, groupOpsIntoSegments } from '../utils/diff.js';
import { nextOeId } from '../utils/oeId.js';
import { buildMetadataZip, buildPackageXml, metadataPath } from '../utils/metadataZip.js';
import {
  listMetadataByTypes, readMetadataContent, deployMetadataPackage,
  connectToOrg,
  readComponentMeta
} from '../services/sf-multi.js';
import crypto from 'crypto';
import { analyze as vectorAgentAnalyze } from '../vectorAgent/index.js';


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
      SELECT id, name, org_type, is_default_gold, drift_summary, last_metadata_sync, metadata_cache
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

// ============================================================
// SPRINT 2 — BE-3 (Equalização) + BE-4 (Merge Staged + Deploy)
// ============================================================


// ── helper: buscar org do banco ──
async function getOrg(orgId) {
  const { rows } = await pool.query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  return rows[0] || null;
}

// ============================================================
// BE-3  EQUALIZE
// ============================================================

// POST /api/explorer/equalize/analyze
// Body: { gold_org_id, dest_org_ids[], scope_types[] }
router.post('/explorer/equalize/analyze', authMiddleware, async (req, res) => {
  try {
    const { gold_org_id, dest_org_ids, scope_types } = req.body || {};
    if (!gold_org_id || !dest_org_ids?.length || !scope_types?.length)
      return res.status(400).json({ ok: false, error: 'gold_org_id, dest_org_ids[] and scope_types[] required' });

    const goldOrg = await getOrg(gold_org_id);
    if (!goldOrg) return res.status(404).json({ ok: false, error: 'Gold org not found' });

    // 1. List metadata from gold
    const goldList = await listMetadataByTypes(goldOrg, scope_types);
    const goldNames = goldList.map(c => ({ type: c.type, fullName: c.fullName }));

    // 2. Collect all unique fullNames across types
    const byType = {};
    for (const c of goldList) {
      if (!byType[c.type]) byType[c.type] = [];
      byType[c.type].push(c.fullName);
    }

    // 3. Read gold content
    const goldContents = {};
    for (const [type, names] of Object.entries(byType)) {
      const items = await readMetadataContent(goldOrg, type, names);
      for (const item of items) {
        const key = `${type}::${item.fullName}`;
        goldContents[key] = JSON.stringify(item, null, 2);
      }
    }

    // 4. For each dest org: list, read, compare
    const components = [];
    for (const destOrgId of dest_org_ids) {
      const destOrg = await getOrg(destOrgId);
      if (!destOrg) continue;

      const destList = await listMetadataByTypes(destOrg, scope_types);
      const destByType = {};
      for (const c of destList) {
        if (!destByType[c.type]) destByType[c.type] = [];
        destByType[c.type].push(c.fullName);
      }

      // Read dest content
      const destContents = {};
      for (const [type, names] of Object.entries(destByType)) {
        const items = await readMetadataContent(destOrg, type, names);
        for (const item of items) {
          destContents[`${type}::${item.fullName}`] = JSON.stringify(item, null, 2);
        }
      }

      // All unique keys (gold + dest)
      const allKeys = new Set([...Object.keys(goldContents), ...Object.keys(destContents)]);

      // Check pending merges for this dest
      const pmRes = await pool.query(
        'SELECT component_name, component_type FROM pending_merges WHERE dest_org_id = $1',
        [destOrgId]
      );
      const mergedSet = new Set(pmRes.rows.map(r => `${r.component_type}::${r.component_name}`));

      for (const key of allKeys) {
        const [type, fullName] = key.split('::');
        const goldContent = goldContents[key] || null;
        const destContent = destContents[key] || null;

        // Se tem pending merge, status = 'merged'
        let status = mergedSet.has(key) ? 'merged' : diffStatus(goldContent, destContent);

        let lcsDiff = null;
        if (status === 'diff') {
          lcsDiff = computeLcsDiff(goldContent, destContent);
        }

        // Find or append component in results
        let comp = components.find(c => c.name === fullName && c.type === type);
        if (!comp) {
          comp = {
            name: fullName, type,
            statuses: {},
            gold_content: goldContent,
            dest_contents: {},
            lcs_diff: {}
          };
          components.push(comp);
        }
        comp.statuses[destOrgId] = status;
        comp.dest_contents[destOrgId] = destContent;
        if (lcsDiff) comp.lcs_diff[destOrgId] = lcsDiff;
      }
    }

    res.json({ ok: true, components });
  } catch (e) {
    console.error('[equalize/analyze]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/equalize/run
// Body: { gold_org_id, dest_org_ids[], scope_types[], only_diff }
router.post('/explorer/equalize/run', authMiddleware, async (req, res) => {
  try {
    const { gold_org_id, dest_org_ids, scope_types, only_diff = false } = req.body || {};
    if (!gold_org_id || !dest_org_ids?.length || !scope_types?.length)
      return res.status(400).json({ ok: false, error: 'gold_org_id, dest_org_ids[] and scope_types[] required' });

    // Create eq_job
    const { rows } = await pool.query(`
      INSERT INTO eq_jobs (gold_org_id, dest_org_ids, scope_types, only_diff, status, executed_by, started_at, created_at)
      VALUES ($1, $2, $3, $4, 'running', $5, NOW(), NOW())
      RETURNING id
    `, [gold_org_id, dest_org_ids, scope_types, only_diff, req.user.id]);
    const eqJobId = rows[0].id;

    // Launch async (não bloqueia o request)
    runEqualization(eqJobId, gold_org_id, dest_org_ids, scope_types, only_diff)
      .catch(e => console.error('[equalize/run async]', e.message));

    res.json({ ok: true, eq_job_id: eqJobId, status: 'running' });
  } catch (e) {
    console.error('[equalize/run]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Async equalization worker
async function runEqualization(eqJobId, goldOrgId, destOrgIds, scopeTypes, onlyDiff) {
  try {
    const goldOrg = await getOrg(goldOrgId);
    const goldList = await listMetadataByTypes(goldOrg, scopeTypes);
    const byType = {};
    for (const c of goldList) {
      if (!byType[c.type]) byType[c.type] = [];
      byType[c.type].push(c.fullName);
    }
    const goldContents = {};
    for (const [type, names] of Object.entries(byType)) {
      const items = await readMetadataContent(goldOrg, type, names);
      for (const item of items) goldContents[`${type}::${item.fullName}`] = JSON.stringify(item, null, 2);
    }

    let totalComps = 0, syncedComps = 0;

    for (const destOrgId of destOrgIds) {
      const destOrg = await getOrg(destOrgId);
      if (!destOrg) continue;

      // Check pending merges — skip those
      const pmRes = await pool.query(
        'SELECT component_name, component_type FROM pending_merges WHERE dest_org_id = $1',
        [destOrgId]
      );
      const mergedSet = new Set(pmRes.rows.map(r => `${r.component_type}::${r.component_name}`));

      const destList = await listMetadataByTypes(destOrg, scopeTypes);
      const destByType = {};
      for (const c of destList) {
        if (!destByType[c.type]) destByType[c.type] = [];
        destByType[c.type].push(c.fullName);
      }
      const destContents = {};
      for (const [type, names] of Object.entries(destByType)) {
        const items = await readMetadataContent(destOrg, type, names);
        for (const item of items) destContents[`${type}::${item.fullName}`] = JSON.stringify(item, null, 2);
      }

      const allKeys = new Set([...Object.keys(goldContents), ...Object.keys(destContents)]);

      for (const key of allKeys) {
        const [type, fullName] = key.split('::');
        if (mergedSet.has(key)) continue; // Respeita pending merges

        const goldContent = goldContents[key] || null;
        const destContent = destContents[key] || null;
        const status = diffStatus(goldContent, destContent);

        if (onlyDiff && status === 'ok') continue;

        totalComps++;
        const actionTaken = status === 'ok' ? 'skipped' : 'synced';

        await pool.query(`
          INSERT INTO eq_components (eq_job_id, component_name, component_type, dest_org_id, status_before, action_taken, snap_gold, snap_dest, synced_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        `, [eqJobId, fullName, type, destOrgId, status, actionTaken,
            goldContent?.substring(0, 10000), destContent?.substring(0, 10000)]);

        if (actionTaken === 'synced') syncedComps++;
      }
    }

    await pool.query(`
      UPDATE eq_jobs SET status = 'done', total_comps = $1, synced_comps = $2, finished_at = NOW()
      WHERE id = $3
    `, [totalComps, syncedComps, eqJobId]);
  } catch (e) {
    console.error('[runEqualization]', e.message);
    await pool.query(`UPDATE eq_jobs SET status = 'failed', result_json = $1, finished_at = NOW() WHERE id = $2`,
      [JSON.stringify({ error: e.message }), eqJobId]);
  }
}

// GET /api/explorer/equalize/status/:eqJobId
router.get('/explorer/equalize/status/:eqJobId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM eq_jobs WHERE id = $1', [req.params.eqJobId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Job not found' });

    const comps = await pool.query(`
      SELECT ec.*, o.name AS dest_org_name
      FROM eq_components ec
      LEFT JOIN orgs o ON o.id = ec.dest_org_id
      WHERE ec.eq_job_id = $1
      ORDER BY ec.component_type, ec.component_name
    `, [req.params.eqJobId]);

    res.json({ ok: true, job: rows[0], components: comps.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// BE-4  MERGE STAGED
// ============================================================

// POST /api/explorer/merge/stage
router.post('/explorer/merge/stage', authMiddleware, async (req, res) => {
  try {
    const { component_name, component_type, dest_org_id, gold_org_id, merged_content } = req.body || {};
    if (!component_name || !component_type || !dest_org_id || !gold_org_id || merged_content === undefined)
      return res.status(400).json({ ok: false, error: 'component_name, component_type, dest_org_id, gold_org_id, merged_content required' });

    const { rows } = await pool.query(`
      INSERT INTO pending_merges (component_name, component_type, dest_org_id, gold_org_id, merged_content, prepared_by, prepared_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (component_name, dest_org_id)
      DO UPDATE SET merged_content = $5, gold_org_id = $4, prepared_by = $6, prepared_at = NOW()
      RETURNING id, prepared_at
    `, [component_name, component_type, dest_org_id, gold_org_id, merged_content, req.user.id]);

    res.json({ ok: true, pending_merge_id: rows[0].id, staged_at: rows[0].prepared_at });
  } catch (e) {
    console.error('[merge/stage]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/merge/pending?dest_org_id=
router.get('/explorer/merge/pending', authMiddleware, async (req, res) => {
  try {
    const where = [];
    const params = [];
    if (req.query.dest_org_id) {
      params.push(toInt(req.query.dest_org_id));
      where.push(`pm.dest_org_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT pm.*, o1.name AS dest_org_name, o2.name AS gold_org_name, u.name AS prepared_by_name
      FROM pending_merges pm
      LEFT JOIN orgs o1 ON o1.id = pm.dest_org_id
      LEFT JOIN orgs o2 ON o2.id = pm.gold_org_id
      LEFT JOIN users u ON u.id = pm.prepared_by
      ${whereSql}
      ORDER BY pm.prepared_at DESC
    `, params);

    res.json({ ok: true, total: rows.length, items: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/explorer/merge/cancel/:id
router.delete('/explorer/merge/cancel/:id', authMiddleware, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM pending_merges WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: 'Pending merge not found' });
    res.json({ ok: true, deleted: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// BE-4  DEPLOY (via merge staged)
// ============================================================

// POST /api/explorer/merge/deploy
// Body: { pending_merge_ids: [id1, id2, ...] }
router.post('/explorer/merge/deploy', authMiddleware, async (req, res) => {
  try {
    const { pending_merge_ids } = req.body || {};
    if (!pending_merge_ids?.length)
      return res.status(400).json({ ok: false, error: 'pending_merge_ids[] required' });

    // Load pending merges
    const { rows: merges } = await pool.query(
      `SELECT * FROM pending_merges WHERE id = ANY($1)`,
      [pending_merge_ids]
    );
    if (!merges.length) return res.status(404).json({ ok: false, error: 'No pending merges found' });

    // Group by dest_org_id (deploy one batch per org)
    const byOrg = {};
    for (const m of merges) {
      if (!byOrg[m.dest_org_id]) byOrg[m.dest_org_id] = [];
      byOrg[m.dest_org_id].push(m);
    }

    const oeId = await nextOeId(pool);
    const allResults = [];
    let successCount = 0, failedCount = 0;

    for (const [destOrgId, orgMerges] of Object.entries(byOrg)) {
      const destOrg = await getOrg(parseInt(destOrgId));
      if (!destOrg) {
        for (const m of orgMerges) {
          allResults.push({ component_name: m.component_name, status: 'failed', error_message: 'Org not found' });
          failedCount++;
        }
        continue;
      }

      // Create deploy_run
      const drRes = await pool.query(`
        INSERT INTO deploy_runs (oe_id, us_id, type, src_org_id, tgt_org_id, status, deployed_by, deployed_at, created_at)
        VALUES ($1, NULL, 'RELEASE', $2, $3, 'running', $4, NOW(), NOW())
        RETURNING id
      `, [oeId, orgMerges[0].gold_org_id, destOrgId, req.user.id]);
      const deployRunId = drRes.rows[0].id;

      // Build ZIP
      const zipFiles = [
        { path: 'package.xml', content: buildPackageXml(orgMerges.map(m => ({ type: m.component_type, fullName: m.component_name }))) }
      ];
      for (const m of orgMerges) {
        const p = metadataPath(m.component_type, m.component_name);
        zipFiles.push({ path: p, content: m.merged_content });
      }
      const zipBuffer = buildMetadataZip(zipFiles);

      try {
        const deployResult = await deployMetadataPackage(destOrg, zipBuffer, {
          rollbackOnError: true,
          pollTimeoutMs: 300000
        });

        const runStatus = deployResult.success ? 'success' : 'failed';
        const duration = Math.round((Date.now() - drRes.rows[0]?.created_at?.getTime?.() || Date.now()) / 1000);

        await pool.query(
          `UPDATE deploy_runs SET status = $1, duration_sec = $2 WHERE id = $3`,
          [runStatus, duration, deployRunId]
        );

        // Process per-component results
        const failures = {};
        if (deployResult.details?.componentFailures) {
          const cf = Array.isArray(deployResult.details.componentFailures)
            ? deployResult.details.componentFailures
            : [deployResult.details.componentFailures];
          for (const f of cf) {
            failures[f.fullName || f.fileName] = f.problem || f.problemType || 'Unknown error';
          }
        }

        for (const m of orgMerges) {
          const compFailed = failures[m.component_name] || null;
          const compStatus = compFailed ? 'failed' : 'success';

          await pool.query(`
            INSERT INTO deploy_components (deploy_run_id, component_name, component_type, action, snap_before, snap_after, result, error_message)
            VALUES ($1, $2, $3, 'replaced', NULL, $4, $5, $6)
          `, [deployRunId, m.component_name, m.component_type, m.merged_content?.substring(0, 10000), compStatus, compFailed]);

          if (compStatus === 'success') {
            // Remove from pending_merges on success
            await pool.query('DELETE FROM pending_merges WHERE id = $1', [m.id]);
            successCount++;
          } else {
            // Keep in pending_merges for retry
            failedCount++;
          }

          allResults.push({ component_name: m.component_name, status: compStatus, error_message: compFailed });
        }
      } catch (deployErr) {
        // Whole deploy failed
        await pool.query('UPDATE deploy_runs SET status = $1 WHERE id = $2', ['failed', deployRunId]);
        for (const m of orgMerges) {
          allResults.push({ component_name: m.component_name, status: 'failed', error_message: deployErr.message });
          failedCount++;
        }
      }
    }

    res.json({
      ok: true,
      oe_id: oeId,
      total: allResults.length,
      success_count: successCount,
      failed_count: failedCount,
      percent_success: allResults.length ? Math.round((successCount / allResults.length) * 100) : 0,
      results: allResults
    });
  } catch (e) {
    console.error('[merge/deploy]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// DEPLOY SNAPSHOT (captura estado atual para drift/rollback)
// ============================================================

// POST /api/explorer/deploy/snapshot
// Body: { org_id, scope_types[] }
router.post('/explorer/deploy/snapshot', authMiddleware, async (req, res) => {
  try {
    const { org_id, scope_types } = req.body || {};
    if (!org_id || !scope_types?.length)
      return res.status(400).json({ ok: false, error: 'org_id and scope_types[] required' });

    const org = await getOrg(org_id);
    if (!org) return res.status(404).json({ ok: false, error: 'Org not found' });

    const metaList = await listMetadataByTypes(org, scope_types);
    let snapshotCount = 0;

    for (const item of metaList) {
      const contents = await readMetadataContent(org, item.type, [item.fullName]);
      const content = contents[0] ? JSON.stringify(contents[0], null, 2) : '';
      const hash = crypto.createHash('sha256').update(content).digest('hex');

      await pool.query(`
        INSERT INTO drift_snapshots (org_id, component_name, component_type, content_hash, captured_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [org_id, item.fullName, item.type, hash]);

      // Upsert component_meta
      await pool.query(`
        INSERT INTO component_meta (component_name, component_type, org_id, last_modified, last_snapshot_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (component_name, org_id)
        DO UPDATE SET last_modified = $4, last_snapshot_at = NOW()
      `, [item.fullName, item.type, org_id, item.lastModifiedDate]);

      snapshotCount++;
    }

    res.json({ ok: true, org_id, snapshot_count: snapshotCount });
  } catch (e) {
    console.error('[deploy/snapshot]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/deploy/status/:oeId
router.get('/explorer/deploy/status/:oeId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
      FROM deploy_runs dr
      LEFT JOIN users u ON u.id = dr.deployed_by
      LEFT JOIN orgs o1 ON o1.id = dr.src_org_id
      LEFT JOIN orgs o2 ON o2.id = dr.tgt_org_id
      WHERE dr.oe_id = $1
    `, [req.params.oeId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Deploy run not found' });

    const comps = await pool.query(`
      SELECT * FROM deploy_components WHERE deploy_run_id = $1
      ORDER BY component_type, component_name
    `, [rows[0].id]);

    res.json({ ok: true, deploy_run: rows[0], components: comps.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// SPRINT 3 — BE-5 (Rollback) + BE-6 (Drift Manual)
// ============================================================

// Default scope_types para drift (seção 7 da spec v2.1)
const DEFAULT_SCOPE_TYPES = [
  'Flow', 'ApexClass', 'ApexTrigger', 'LightningComponentBundle',
  'PermissionSet', 'CustomField', 'Layout', 'ValidationRule',
  'Bot', 'BotVersion'
];

// ============================================================
// BE-5  ROLLBACK
// ============================================================

// GET /api/explorer/rollback/deploys/:orgId?limit=
router.get('/explorer/rollback/deploys/:orgId', authMiddleware, async (req, res) => {
  try {
    const orgId = toInt(req.params.orgId);
    const limit = Math.min(toInt(req.query.limit, 20), 100);

    const { rows } = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
        FROM deploy_runs dr
        LEFT JOIN users u  ON u.id = dr.deployed_by
        LEFT JOIN orgs  o1 ON o1.id = dr.src_org_id
        LEFT JOIN orgs  o2 ON o2.id = dr.tgt_org_id
       WHERE dr.tgt_org_id = $1
       ORDER BY dr.created_at DESC
       LIMIT $2
    `, [orgId, limit]);

    // Join deploy_components per run
    for (const run of rows) {
      const comps = await pool.query(
        'SELECT * FROM deploy_components WHERE deploy_run_id = $1 ORDER BY component_type, component_name',
        [run.id]
      );
      run.components = comps.rows;
    }

    res.json({ ok: true, total: rows.length, deploy_runs: rows });
  } catch (e) {
    console.error('[rollback/deploys]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/rollback/start
// Body: { deploy_run_id, source_org_id }
router.post('/explorer/rollback/start', authMiddleware, async (req, res) => {
  try {
    const { deploy_run_id, source_org_id } = req.body || {};
    if (!deploy_run_id || !source_org_id)
      return res.status(400).json({ ok: false, error: 'deploy_run_id and source_org_id required' });

    // 1. Read original deploy_run components
    const drRes = await pool.query('SELECT * FROM deploy_runs WHERE id = $1', [deploy_run_id]);
    if (!drRes.rows.length) return res.status(404).json({ ok: false, error: 'Deploy run not found' });
    const deployRun = drRes.rows[0];

    const compsRes = await pool.query(
      'SELECT * FROM deploy_components WHERE deploy_run_id = $1',
      [deploy_run_id]
    );
    if (!compsRes.rows.length) return res.status(404).json({ ok: false, error: 'No components in deploy run' });

    // 2. For each component, read current content from source_org_id
    const sourceOrg = await getOrg(source_org_id);
    if (!sourceOrg) return res.status(404).json({ ok: false, error: 'Source org not found' });

    const pendingMergeIds = [];
    for (const comp of compsRes.rows) {
      // Read content from source org (the version to rollback TO)
      let rollbackContent = null;
      try {
        const items = await readMetadataContent(sourceOrg, comp.component_type, [comp.component_name]);
        if (items.length) rollbackContent = JSON.stringify(items[0], null, 2);
      } catch (readErr) {
        console.warn(`[rollback] Could not read ${comp.component_name} from org ${source_org_id}:`, readErr.message);
      }

      if (rollbackContent === null) continue; // Skip if can't read source

      // 3. Create pending_merge (same as equalization flow)
      const pmRes = await pool.query(`
        INSERT INTO pending_merges (component_name, component_type, dest_org_id, gold_org_id, merged_content, prepared_by, prepared_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (component_name, dest_org_id)
        DO UPDATE SET merged_content = $5, gold_org_id = $4, prepared_by = $6, prepared_at = NOW()
        RETURNING id
      `, [comp.component_name, comp.component_type, deployRun.tgt_org_id, source_org_id, rollbackContent, req.user.id]);

      pendingMergeIds.push(pmRes.rows[0].id);
    }

    res.json({ ok: true, pending_merge_ids: pendingMergeIds, total: pendingMergeIds.length });
  } catch (e) {
    console.error('[rollback/start]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// BE-6  DRIFT DETECTION (Manual)
// ============================================================

// GET /api/explorer/drift/summary?gold_org_id=
router.get('/explorer/drift/summary', authMiddleware, async (req, res) => {
  try {
    const goldOrgId = toInt(req.query.gold_org_id, null);

    // Resolve gold
    const goldRow = goldOrgId
      ? await pool.query('SELECT id, name FROM orgs WHERE id = $1', [goldOrgId])
      : await pool.query('SELECT id, name FROM orgs WHERE is_default_gold = true LIMIT 1');
    const gold = goldRow.rows[0] || null;

    // Return drift_summary from all explorer orgs
    const { rows } = await pool.query(`
      SELECT id, name, org_type, is_default_gold, drift_summary, last_metadata_sync, metadata_cache
      FROM orgs WHERE id IN (36, 100, 133) ORDER BY id
    `);

    res.json({ ok: true, gold_org: gold, orgs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/drift/detail/:orgId?gold_org_id=&type=&status=
router.get('/explorer/drift/detail/:orgId', authMiddleware, async (req, res) => {
  try {
    const destOrgId = toInt(req.params.orgId);
    const goldOrgId = toInt(req.query.gold_org_id, null);
    const { type, status } = req.query;

    // Resolve gold
    let goldId = goldOrgId;
    if (!goldId) {
      const gRow = await pool.query('SELECT id FROM orgs WHERE is_default_gold = true LIMIT 1');
      goldId = gRow.rows[0]?.id;
    }
    if (!goldId) return res.status(400).json({ ok: false, error: 'No gold org found' });

    const where = ['dr.gold_org_id = $1', 'dr.dest_org_id = $2'];
    const params = [goldId, destOrgId];

    if (type) { params.push(type); where.push(`dr.component_type = $${params.length}`); }
    if (status) { params.push(status); where.push(`dr.status = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT dr.*
      FROM drift_results dr
      WHERE ${where.join(' AND ')}
      ORDER BY dr.detected_at DESC
    `, params);

    res.json({ ok: true, gold_org_id: goldId, dest_org_id: destOrgId, total: rows.length, results: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/drift/run
// Body: { gold_org_id, dest_org_ids[], scope_types[]? }
router.post('/explorer/drift/run', authMiddleware, async (req, res) => {
  try {
    const { gold_org_id, dest_org_ids, scope_types } = req.body || {};
    if (!gold_org_id || !dest_org_ids?.length)
      return res.status(400).json({ ok: false, error: 'gold_org_id and dest_org_ids[] required' });

    const types = scope_types?.length ? scope_types : DEFAULT_SCOPE_TYPES;

    const goldOrg = await getOrg(gold_org_id);
    if (!goldOrg) return res.status(404).json({ ok: false, error: 'Gold org not found' });

    // 1. List + hash gold metadata
    const goldList = await listMetadataByTypes(goldOrg, types);
    const goldHashes = {};
    for (const item of goldList) {
      try {
        const contents = await readMetadataContent(goldOrg, item.type, [item.fullName]);
        const content = contents[0] ? JSON.stringify(contents[0], null, 2) : '';
        goldHashes[`${item.type}::${item.fullName}`] = {
          hash: crypto.createHash('sha256').update(content).digest('hex'),
          type: item.type,
          fullName: item.fullName
        };
      } catch (e) {
        console.warn(`[drift] gold read fail: ${item.fullName}`, e.message);
      }
    }

    const orgsProcessed = [];

    // 2. For each dest org
    for (const destOrgId of dest_org_ids) {
      const destOrg = await getOrg(destOrgId);
      if (!destOrg) continue;

      const destList = await listMetadataByTypes(destOrg, types);
      const destHashes = {};
      for (const item of destList) {
        try {
          const contents = await readMetadataContent(destOrg, item.type, [item.fullName]);
          const content = contents[0] ? JSON.stringify(contents[0], null, 2) : '';
          destHashes[`${item.type}::${item.fullName}`] = {
            hash: crypto.createHash('sha256').update(content).digest('hex'),
            type: item.type,
            fullName: item.fullName
          };
        } catch (e) {
          console.warn(`[drift] dest read fail: ${item.fullName}`, e.message);
        }
      }

      // Compare and record
      const allKeys = new Set([...Object.keys(goldHashes), ...Object.keys(destHashes)]);
      const summary = { ok: 0, diff: 0, absent: 0, extra: 0 };

      // Clear previous results for this pair
      await pool.query(
        'DELETE FROM drift_results WHERE gold_org_id = $1 AND dest_org_id = $2',
        [gold_org_id, destOrgId]
      );

      for (const key of allKeys) {
        const g = goldHashes[key];
        const d = destHashes[key];
        const [type, fullName] = key.split('::');
        let status;

        if (g && !d) { status = 'absent'; }
        else if (!g && d) { status = 'extra'; }
        else if (g.hash === d.hash) { status = 'ok'; }
        else { status = 'diff'; }

        summary[status]++;

        // Insert drift_result
        await pool.query(`
          INSERT INTO drift_results (gold_org_id, dest_org_id, component_name, component_type, status, detected_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
        `, [gold_org_id, destOrgId, fullName, type, status]);

        // Upsert drift_snapshot for dest
        const hash = d ? d.hash : 'absent';
        await pool.query(`
          INSERT INTO drift_snapshots (org_id, component_name, component_type, content_hash, captured_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [destOrgId, fullName, type, hash]);
      }

      // Update drift_summary on org
      const driftSummary = {
        ...summary,
        gold_org_id: gold_org_id,
        last_check: new Date().toISOString(),
        total_components: allKeys.size
      };
      await pool.query(
        'UPDATE orgs SET drift_summary = $1 WHERE id = $2',
        [JSON.stringify(driftSummary), destOrgId]
      );

      orgsProcessed.push(destOrgId);
    }

    res.json({ ok: true, orgs_processed: orgsProcessed, total_orgs: orgsProcessed.length });
  } catch (e) {
    console.error('[drift/run]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================================
// SPRINT 4 — BE-7 (Picker de Componentes) + BE-8 (Log + Histórico)
// ============================================================

// ── BE-7: Components ──

// GET /api/explorer/components/list?org_id=&type=
router.get('/explorer/components/list', authMiddleware, async (req, res) => {
  try {
    const orgId = toInt(req.query.org_id);
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id required' });

    const org = await getOrg(orgId);
    if (!org) return res.status(404).json({ ok: false, error: 'Org not found' });

    const typeFilter = req.query.type;
    const types = typeFilter ? [typeFilter] : DEFAULT_SCOPE_TYPES;

    const metaList = await listMetadataByTypes(org, types);

    // Join with component_meta from DB
    const cmRes = await pool.query(
      'SELECT * FROM component_meta WHERE org_id = $1', [orgId]
    );
    const cmMap = {};
    for (const cm of cmRes.rows) cmMap[`${cm.component_type}::${cm.component_name}`] = cm;

    const components = metaList.map(item => {
      const cm = cmMap[`${item.type}::${item.fullName}`];
      return {
        name: item.fullName,
        type: item.type,
        id: item.id,
        last_modified_date: item.lastModifiedDate || cm?.last_modified || null,
        created_date: item.createdDate || cm?.created_date || null,
        last_modified_by: cm?.last_modified_by || null,
        last_snapshot_at: cm?.last_snapshot_at || null
      };
    });

    res.json({ ok: true, org_id: orgId, total: components.length, components });
  } catch (e) {
    console.error('[components/list]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/components/refresh-snapshot
// Body: { component_name, component_type, org_id }
router.post('/explorer/components/refresh-snapshot', authMiddleware, async (req, res) => {
  try {
    const { component_name, component_type, org_id } = req.body || {};
    if (!component_name || !org_id)
      return res.status(400).json({ ok: false, error: 'component_name and org_id required' });

    const org = await getOrg(org_id);
    if (!org) return res.status(404).json({ ok: false, error: 'Org not found' });

    // Read component content
    const type = component_type || 'CustomField';
    const contents = await readMetadataContent(org, type, [component_name]);
    const content = contents[0] ? JSON.stringify(contents[0], null, 2) : '';
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    // Upsert drift_snapshot
    await pool.query(`
      INSERT INTO drift_snapshots (org_id, component_name, component_type, content_hash, captured_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [org_id, component_name, type, hash]);

    // Read meta info (created_date, last_modified, last_modified_by)
    let meta = null;
    try {
      meta = await readComponentMeta(org, type, component_name);
    } catch (e) { /* meta is optional */ }

    // Upsert component_meta
    await pool.query(`
      INSERT INTO component_meta (component_name, component_type, org_id, created_date, last_modified, last_modified_by, last_snapshot_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (component_name, org_id)
      DO UPDATE SET last_modified = $5, last_modified_by = $6, last_snapshot_at = NOW()
    `, [component_name, type, org_id, meta?.created_date || null, meta?.last_modified || null, meta?.last_modified_by || null]);

    res.json({ ok: true, last_snapshot_at: new Date().toISOString() });
  } catch (e) {
    console.error('[components/refresh-snapshot]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/explorer/us/prepare-deploy
// Body: { jira_key, source_org_id, dest_org_id, component_names[] }
router.post('/explorer/us/prepare-deploy', authMiddleware, async (req, res) => {
  try {
    const { jira_key, source_org_id, dest_org_id, component_names } = req.body || {};
    if (!source_org_id || !dest_org_id || !component_names?.length)
      return res.status(400).json({ ok: false, error: 'source_org_id, dest_org_id and component_names[] required' });

    const srcOrg = await getOrg(source_org_id);
    const destOrg = await getOrg(dest_org_id);
    if (!srcOrg || !destOrg)
      return res.status(404).json({ ok: false, error: 'Source or dest org not found' });

    // For each component, identify type from component_meta or listMetadata
    const srcList = await listMetadataByTypes(srcOrg, DEFAULT_SCOPE_TYPES);
    const srcByName = {};
    for (const item of srcList) srcByName[item.fullName] = item;

    const results = [];
    for (const name of component_names) {
      const srcItem = srcByName[name];
      if (!srcItem) {
        results.push({ name, type: null, status: 'not_found_in_source', gold_content: null, dest_content: null, lcs_diff: null });
        continue;
      }

      // Read source (gold) content
      let goldContent = null;
      try {
        const items = await readMetadataContent(srcOrg, srcItem.type, [name]);
        if (items.length) goldContent = JSON.stringify(items[0], null, 2);
      } catch (e) { /* */ }

      // Read dest content
      let destContent = null;
      try {
        const items = await readMetadataContent(destOrg, srcItem.type, [name]);
        if (items.length) destContent = JSON.stringify(items[0], null, 2);
      } catch (e) { /* */ }

      const status = diffStatus(goldContent, destContent);
      const lcsDiff = status === 'diff' ? computeLcsDiff(goldContent, destContent) : null;

      results.push({
        name, type: srcItem.type, status,
        gold_content: goldContent, dest_content: destContent,
        lcs_diff: lcsDiff
      });
    }

    res.json({ ok: true, jira_key: jira_key || null, components: results });
  } catch (e) {
    console.error('[us/prepare-deploy]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── BE-8: Log + Histórico ──

// GET /api/explorer/log?limit=&status=&org_id=&from_date=&to_date=
router.get('/explorer/log', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(toInt(req.query.limit, 100), 500);
    const { status, org_id, from_date, to_date } = req.query;

    const where = [];
    const params = [];

    if (status)    { params.push(status);           where.push(`dr.status = $${params.length}`); }
    if (org_id)    { params.push(toInt(org_id));     where.push(`dr.tgt_org_id = $${params.length}`); }
    if (from_date) { params.push(from_date);         where.push(`dr.created_at >= $${params.length}`); }
    if (to_date)   { params.push(to_date);           where.push(`dr.created_at <= $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name,
             us.jira_key, us.title AS story_title
        FROM deploy_runs dr
        LEFT JOIN users u ON u.id = dr.deployed_by
        LEFT JOIN orgs o1 ON o1.id = dr.src_org_id
        LEFT JOIN orgs o2 ON o2.id = dr.tgt_org_id
        LEFT JOIN user_stories us ON us.id = dr.us_id
        ${whereSql}
        ORDER BY dr.created_at DESC
        LIMIT $${params.length + 1}
    `, [...params, limit]);

    res.json({ ok: true, total: rows.length, deploy_runs: rows });
  } catch (e) {
    console.error('[log]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/history/by-story/:jiraKey
router.get('/explorer/history/by-story/:jiraKey', authMiddleware, async (req, res) => {
  try {
    const usRes = await pool.query('SELECT id FROM user_stories WHERE jira_key = $1', [req.params.jiraKey]);
    if (!usRes.rows.length) return res.status(404).json({ ok: false, error: 'Story not found' });

    const { rows } = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name
        FROM deploy_runs dr
        LEFT JOIN users u ON u.id = dr.deployed_by
        LEFT JOIN orgs o1 ON o1.id = dr.src_org_id
        LEFT JOIN orgs o2 ON o2.id = dr.tgt_org_id
       WHERE dr.us_id = $1
       ORDER BY dr.created_at DESC
    `, [usRes.rows[0].id]);

    for (const run of rows) {
      const comps = await pool.query(
        'SELECT * FROM deploy_components WHERE deploy_run_id = $1 ORDER BY component_type, component_name',
        [run.id]
      );
      run.components = comps.rows;
    }

    res.json({ ok: true, jira_key: req.params.jiraKey, total: rows.length, deploy_runs: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/history/by-component/:name
router.get('/explorer/history/by-component/:name', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dc.*, dr.oe_id, dr.type AS deploy_type, dr.status AS run_status,
             dr.deployed_at, o.name AS tgt_org_name
        FROM deploy_components dc
        JOIN deploy_runs dr ON dr.id = dc.deploy_run_id
        LEFT JOIN orgs o ON o.id = dr.tgt_org_id
       WHERE dc.component_name = $1
       ORDER BY dr.deployed_at DESC
    `, [req.params.name]);

    res.json({ ok: true, component_name: req.params.name, total: rows.length, history: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/history/by-oe/:oeId
router.get('/explorer/history/by-oe/:oeId', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT dr.*, u.name AS deployed_by_name,
             o1.name AS src_org_name, o2.name AS tgt_org_name,
             us.jira_key, us.title AS story_title
        FROM deploy_runs dr
        LEFT JOIN users u ON u.id = dr.deployed_by
        LEFT JOIN orgs o1 ON o1.id = dr.src_org_id
        LEFT JOIN orgs o2 ON o2.id = dr.tgt_org_id
        LEFT JOIN user_stories us ON us.id = dr.us_id
       WHERE dr.oe_id = $1
    `, [req.params.oeId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Deploy run not found' });

    const comps = await pool.query(
      'SELECT * FROM deploy_components WHERE deploy_run_id = $1 ORDER BY component_type, component_name',
      [rows[0].id]
    );

    res.json({ ok: true, deploy_run: rows[0], components: comps.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// SPRINT 5 — Vector Agent (VA-1 a VA-4, motor determinístico)
// ============================================================



// POST /api/explorer/vector-agent/analyze
// Body: { component_name, component_type, gold_content, dest_content }
router.post('/explorer/vector-agent/analyze', authMiddleware, async (req, res) => {
  try {
    const { component_name, component_type, gold_content, dest_content } = req.body || {};
    if (!component_name || !component_type)
      return res.status(400).json({ ok: false, error: 'component_name and component_type required' });

    const result = vectorAgentAnalyze({
      component_name,
      component_type,
      gold_content: gold_content || null,
      dest_content: dest_content || null
    });

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[vector-agent/analyze]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ============================================================
// SPRINT 6b — Dashboard Wiring (cache + last_sync)
// ============================================================

const DASHBOARD_SCOPE_TYPES = [
  'Flow', 'ApexClass', 'ApexTrigger', 'LightningComponentBundle',
  'PermissionSet', 'CustomField', 'Layout', 'ValidationRule',
  'Bot', 'BotVersion', 'CustomObject', 'Profile', 'RecordType',
  'NamedCredential', 'ExternalCredential', 'CustomPermission',
  'FlexiPage', 'QuickAction', 'ConnectedApp', 'CustomMetadata',
  'ApprovalProcess', 'DuplicateRule', 'MatchingRule',
  'CustomApplication', 'CustomTab', 'CustomLabels',
  'EmailTemplate', 'Role', 'Queue',
  'GlobalValueSet', 'StandardValueSet',
  'Network', 'CustomSite', 'ExperienceBundle'
];

// Estado in-memory dos jobs de sync (evita bater no timeout do Heroku)
const syncJobsState = new Map(); // orgId → { status, started_at, error }

async function runSyncMetadataJob(orgId) {
  syncJobsState.set(orgId, { status: 'running', started_at: new Date().toISOString(), error: null });
  try {
    const org = await getOrg(orgId);
    if (!org) throw new Error('Org not found');

    const metaList = await listMetadataByTypes(org, DASHBOARD_SCOPE_TYPES);

    const byType = {};
    let totalCount = 0;
    for (const item of metaList) {
      if (!byType[item.type]) byType[item.type] = { count: 0, components: [] };
      byType[item.type].count++;
      byType[item.type].components.push({
        fullName: item.fullName,
        lastModifiedDate: item.lastModifiedDate || null,
        createdDate: item.createdDate || null
      });
      totalCount++;
    }

    const cache = {
      total: totalCount,
      by_type: Object.fromEntries(
        Object.entries(byType).map(([type, data]) => [type, { count: data.count, components: data.components }])
      ),
      types_queried: DASHBOARD_SCOPE_TYPES.length
    };

    const now = new Date().toISOString();
    await pool.query(
      `UPDATE orgs SET metadata_cache = $1, last_metadata_sync = $2 WHERE id = $3`,
      [JSON.stringify(cache), now, orgId]
    );

    // Upsert component_meta em batch (usa UNNEST para performance)
    if (metaList.length > 0) {
      const names = metaList.map(m => m.fullName);
      const types = metaList.map(m => m.type);
      const modDates = metaList.map(m => m.lastModifiedDate || null);
      const orgIds = metaList.map(() => orgId);
      await pool.query(`
        INSERT INTO component_meta (component_name, component_type, org_id, last_modified, last_snapshot_at)
        SELECT * FROM UNNEST($1::text[], $2::text[], $3::int[], $4::timestamptz[]) AS t(cn, ct, oi, lm), (SELECT NOW()) AS s
        ON CONFLICT (component_name, org_id)
        DO UPDATE SET component_type = EXCLUDED.component_type, last_modified = EXCLUDED.last_modified, last_snapshot_at = NOW()
      `, [names, types, orgIds, modDates]);
    }

    syncJobsState.set(orgId, {
      status: 'done',
      started_at: syncJobsState.get(orgId).started_at,
      finished_at: now,
      total_components: totalCount,
      types_found: Object.keys(byType).length,
      by_type: Object.fromEntries(Object.entries(byType).map(([t, d]) => [t, d.count])),
      failed_types: metaList.__failed_types || [],
      error: null
    });
  } catch (e) {
    console.error('[sync/metadata job]', e.message);
    syncJobsState.set(orgId, {
      status: 'failed',
      started_at: syncJobsState.get(orgId)?.started_at,
      finished_at: new Date().toISOString(),
      error: e.message
    });
  }
}

// POST /api/explorer/sync/metadata
// Body: { org_id }
// Retorna imediatamente { ok, job_started, org_id } e roda em background
router.post('/explorer/sync/metadata', authMiddleware, async (req, res) => {
  try {
    const orgId = toInt(req.body?.org_id);
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id required' });

    const org = await getOrg(orgId);
    if (!org) return res.status(404).json({ ok: false, error: 'Org not found' });

    // Se já tem job rodando pra essa org, avisa
    const current = syncJobsState.get(orgId);
    if (current?.status === 'running') {
      return res.json({ ok: true, job_started: false, already_running: true, org_id: orgId, started_at: current.started_at });
    }

    // Dispara background — NÃO faz await
    runSyncMetadataJob(orgId).catch(e => console.error('[sync job unhandled]', e.message));

    res.json({ ok: true, job_started: true, org_id: orgId, org_name: org.name, poll_url: '/api/explorer/sync/job/' + orgId });
  } catch (e) {
    console.error('[sync/metadata trigger]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/explorer/sync/job/:orgId
// Consulta status do último job de sync pra uma org
router.get('/explorer/sync/job/:orgId', authMiddleware, async (req, res) => {
  const orgId = toInt(req.params.orgId);
  const state = syncJobsState.get(orgId);
  if (!state) return res.json({ ok: true, status: 'idle', has_previous: false });
  res.json({ ok: true, ...state });
});

// GET /api/explorer/sync/status
// Retorna last_metadata_sync de cada org do Explorer
router.get('/explorer/sync/status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, last_metadata_sync, metadata_cache
      FROM orgs WHERE id IN (36, 100, 133) ORDER BY id
    `);
    const orgs = rows.map(r => ({
      id: r.id,
      name: r.name,
      last_sync: r.last_metadata_sync,
      total_components: r.metadata_cache?.total || 0,
      by_type: r.metadata_cache?.by_type
        ? Object.fromEntries(Object.entries(r.metadata_cache.by_type).map(([t, d]) => [t, d.count]))
        : null
    }));
    res.json({ ok: true, orgs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
