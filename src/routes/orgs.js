// src/routes/orgs.js — CRUD de orgs + seletor
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection, describeObject, runSoql, runToolingQuery } from '../services/sf-multi.js';
import pool from '../config/db.js';

const router = express.Router();

// Helper: busca org do Postgres com credenciais
async function getOrgById(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

// GET /api/orgs — Lista orgs do usuario (admin ve todas)
router.get('/', authMiddleware, async (req, res) => {
  try {
    let result;
    if (req.user.role === 'admin') {
      result = await pool.query('SELECT id, name, login_url, username, org_type, created_at FROM orgs ORDER BY name');
    } else {
      result = await pool.query('SELECT id, name, login_url, username, org_type, created_at FROM orgs ORDER BY name');
    }
    res.json({ orgs: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/orgs — Adicionar org (admin only)
router.post('/', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });
  try {
    const { name, login_url, username, password, security_token, org_type } = req.body;
    if (!name || !login_url || !username || !password) {
      return res.status(400).json({ error: 'name, login_url, username, password obrigatorios' });
    }

    // Testar conexão (com fallback se timeout)
    let orgId = null;
    try {
      const test = await testConnection({ login_url, username, password, security_token });
      if (test.status === 'connected') orgId = test.orgId;
    } catch (e) {
      // Se timeout, salva sem orgId (pode testar depois via /status)
    }

    const result = await pool.query(
      'INSERT INTO orgs (name, login_url, username, password, security_token, org_type, org_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, login_url, username, org_type',
      [name, login_url, username, password, security_token || '', org_type || 'sandbox', orgId]
    );
    res.status(201).json({ status: 'created', org: result.rows[0], connection: test });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/orgs/:id — Atualizar credenciais (admin, sem test connection)
router.put('/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });
  try {
    const { name, login_url, username, password, security_token, org_type } = req.body;
    const sets = [];
    const vals = [];
    let n = 1;
    if (name) { sets.push('name=$'+n); vals.push(name); n++; }
    if (login_url) { sets.push('login_url=$'+n); vals.push(login_url); n++; }
    if (username) { sets.push('username=$'+n); vals.push(username); n++; }
    if (password) { sets.push('password=$'+n); vals.push(password); n++; }
    if (security_token !== undefined) { sets.push('security_token=$'+n); vals.push(security_token); n++; }
    if (org_type) { sets.push('org_type=$'+n); vals.push(org_type); n++; }
    if (!sets.length) return res.status(400).json({ error: 'Nada para atualizar' });
    vals.push(req.params.id);
    const r = await pool.query('UPDATE orgs SET ' + sets.join(',') + ' WHERE id=$' + n + ' RETURNING id, name, username', vals);
    if (!r.rows.length) return res.status(404).json({ error: 'Org nao encontrada' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/orgs/:id — Remover org (admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas admin' });
  try {
    await pool.query('DELETE FROM orgs WHERE id = $1', [req.params.id]);
    res.json({ status: 'deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/test — Testar conexão
router.get('/:id/test', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org nao encontrada' });
    const test = await testConnection(org);
    res.json(test);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/describe/:objectName — Describe read-only
router.get('/:id/describe/:objectName', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org nao encontrada' });
    const desc = await describeObject(org, req.params.objectName);
    res.json(desc);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/soql?q= — SOQL read-only
router.get('/:id/soql', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org nao encontrada' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'query param q obrigatorio' });
    const result = await runSoql(org, q);
    res.json({ totalSize: result.totalSize, records: result.records });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// GET /api/orgs/:id/tooling?q= — Tooling API SOQL read-only (para Flows, ApexClass etc)
router.get('/:id/tooling', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org nao encontrada' });
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'query param q obrigatorio' });
    const result = await runToolingQuery(org, q);
    res.json({ totalSize: result.totalSize, records: result.records });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/orgs/:id/metadata-read/:type/:fullName — Read metadata (read-only)
router.get('/:id/metadata-read/:type/:fullName', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org nao encontrada' });
    const data = await metadataRead(org, req.params.type, req.params.fullName);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
