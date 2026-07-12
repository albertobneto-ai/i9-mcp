import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

router.get('/explorer/status', async (req, res) => {
  const status = {
    timestamp: new Date().toISOString(),
    tables: {}, workers: {}, routes: {}, snapshots: {}, sprints: {}
  };

  // Tabelas
  const TABLES = ['metadata_content_store','metadata_snapshots',
    'metadata_components','sync_operations','drift_policies','drift_alerts'];
  for (const t of TABLES) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
      status.tables[t] = { exists: true, rows: parseInt(rows[0].n) };
    } catch { status.tables[t] = { exists: false, rows: 0 }; }
  }

  // Snapshots por org
  try {
    const { rows } = await pool.query(`
      SELECT o.name, COUNT(s.id) AS total, MAX(s.created_at) AS last_at
      FROM metadata_snapshots s JOIN orgs o ON o.id = s.org_id
      GROUP BY o.name ORDER BY o.name`);
    status.snapshots = rows.map(r => ({
      org: r.name, total: parseInt(r.total), last: r.last_at
    }));
  } catch { status.snapshots = []; }

  // Workers registrados via pg-boss
  try {
    const { rows } = await pool.query(
      'SELECT DISTINCT name FROM pgboss.job GROUP BY name');
    status.workers = rows.map(r => r.name);
  } catch { status.workers = []; }

  // Rotas ativas
  const ROUTE_CHECKS = [
    { key: 'diff_orgs',         path: '/api/diff/orgs' },
    { key: 'sync',              path: '/api/sync' },
    { key: 'sync_history',      path: '/api/sync/history' },
    { key: 'drift',             path: '/api/drift' },
    { key: 'component_history', path: '/api/component/history' },
  ];
  for (const r of ROUTE_CHECKS) {
    status.routes[r.key] = typeof req.app._router !== 'undefined';
  }

  // Inferência de sprints concluídos
  const t = status.tables;
  status.sprints = {
    'BE-1_infra':    t.metadata_content_store?.exists && t.metadata_snapshots?.exists
                       ? 'done' : 'pending',
    'BE-2_retrieve': t.metadata_components?.exists && t.metadata_components?.rows > 0
                       ? 'done' : 'pending',
    'BE-3_diff':     'check code — cannot infer from DB',
    'BE-4_api':      t.metadata_snapshots?.exists ? 'check GET /api/diff/orgs' : 'pending',
    'BE-5_sync':     t.sync_operations?.exists
                       ? (t.sync_operations?.rows > 0 ? 'done' : 'deployed_not_tested')
                       : 'pending',
    'BE-6_drift_kb': t.drift_policies?.exists &&
                     status.workers?.includes?.('drift-check') ? 'done' : 'pending',
  };

  // Alertas e sync summary
  try {
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS n FROM drift_alerts WHERE acknowledged = false');
    status.drift_alerts_pending = parseInt(rows[0].n);
  } catch { status.drift_alerts_pending = null; }

  try {
    const { rows } = await pool.query(
      'SELECT status, COUNT(*) AS n FROM sync_operations GROUP BY status');
    status.sync_summary = Object.fromEntries(rows.map(r => [r.status, parseInt(r.n)]));
  } catch { status.sync_summary = {}; }

  res.json(status);
});

export default router;
