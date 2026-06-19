// src/routes/deploys.js
// Endpoints para a página de auditoria de deploys.
// 100% read-only sobre deploy_log. Zero side effects.

import express from 'express';
import pool from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

// ── GET /api/deploys/list — lista agrupada por US com métricas ──
router.get('/list', authMiddleware, async (req, res) => {
  const { search = '', org = '', from = '', to = '', result = '', limit = 50, offset = 0 } = req.query;
  const limitN = Math.min(parseInt(limit, 10) || 50, 200);
  const offsetN = Math.max(parseInt(offset, 10) || 0, 0);

  const where = [];
  const params = [];

  if (search) {
    params.push(`%${search.toUpperCase()}%`);
    where.push(`UPPER(us_number) LIKE $${params.length}`);
  }
  if (org) {
    params.push(org);
    where.push(`org_name = $${params.length}`);
  }
  if (from) {
    params.push(from);
    where.push(`created_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    where.push(`created_at <= $${params.length}`);
  }
  if (result) {
    params.push(result);
    where.push(`result = $${params.length}`);
  }
  // Filtra registros sem US
  where.push(`us_number IS NOT NULL AND us_number != ''`);

  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    // Agregado por US
    const aggSql = `
      SELECT
        us_number,
        MAX(org_name) as org_name,
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE result = 'success') as success,
        COUNT(*) FILTER (WHERE result = 'error') as errors,
        COUNT(*) FILTER (WHERE result = 'exists') as exists_count,
        MIN(created_at) as first_at,
        MAX(created_at) as last_at,
        (array_agg(action ORDER BY created_at DESC))[1] as last_action
      FROM deploy_log
      ${whereClause}
      GROUP BY us_number
      ORDER BY MAX(created_at) DESC
      LIMIT ${limitN} OFFSET ${offsetN}
    `;
    const { rows } = await pool.query(aggSql, params);

    // Total de US distintas para paginação
    const countSql = `
      SELECT COUNT(DISTINCT us_number) as total
      FROM deploy_log
      ${whereClause}
    `;
    const countResult = await pool.query(countSql, params);
    const totalUs = parseInt(countResult.rows[0].total, 10) || 0;

    // Orgs distintas para filtro
    const orgsResult = await pool.query(
      `SELECT DISTINCT org_name FROM deploy_log WHERE org_name IS NOT NULL ORDER BY org_name`
    );

    res.json({
      total: totalUs,
      limit: limitN,
      offset: offsetN,
      orgs: orgsResult.rows.map(r => r.org_name),
      items: rows.map(r => ({
        us_number: r.us_number,
        org_name: r.org_name,
        total: parseInt(r.total, 10),
        success: parseInt(r.success, 10),
        errors: parseInt(r.errors, 10),
        exists: parseInt(r.exists_count, 10),
        first_at: r.first_at,
        last_at: r.last_at,
        last_action: r.last_action,
      })),
    });
  } catch (err) {
    console.error('[deploys/list] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/deploys/:us — detalhe completo dos steps de uma US ──
router.get('/:us', authMiddleware, async (req, res) => {
  const us = String(req.params.us || '').toUpperCase().trim();
  if (!us) return res.status(400).json({ error: 'US obrigatória' });

  try {
    const { rows } = await pool.query(
      `SELECT id, us_number, component, action, description, result, result_message,
              org_name, user_name, created_at
       FROM deploy_log
       WHERE UPPER(us_number) = $1
       ORDER BY created_at ASC, id ASC`,
      [us]
    );

    if (!rows.length) {
      return res.json({ us_number: us, components: [], total: 0 });
    }

    res.json({
      us_number: us,
      total: rows.length,
      first_at: rows[0].created_at,
      last_at: rows[rows.length - 1].created_at,
      org_name: rows[0].org_name,
      components: rows.map(r => ({
        id: r.id,
        component: r.component,
        action: r.action,
        description: r.description,
        result: r.result,
        result_message: r.result_message,
        org_name: r.org_name,
        user_name: r.user_name,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[deploys/:us] erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
