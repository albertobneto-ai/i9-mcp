// src/routes/orgs.js — CRUD de orgs + seletor
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { testConnection, describeObject, runSoql, runToolingQuery, metadataCreate, metadataUpdate, metadataRead, activateRule, deployApexClass, deployFlow, updateProfileFLS, connectToOrg } from '../services/sf-multi.js';
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

    // Salvar sem testar conexão (conexão lazy na primeira chamada)
    let orgId = null;

    const result = await pool.query(
      'INSERT INTO orgs (name, login_url, username, password, security_token, org_type, org_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, login_url, username, org_type',
      [name, login_url, username, password, security_token || '', org_type || 'sandbox', orgId]
    );
    res.status(201).json({ status: 'created', org: result.rows[0], id: result.rows[0].id });
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

// ── POST /api/orgs/:id/batch-deploy — Deploy batch de fields/apex/metadata ──
// Endpoint aditivo para deploy em lote. Cada step é executado sequencialmente.
router.post('/:id/batch-deploy', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { steps = [] } = req.body;
    if (!steps.length) return res.status(400).json({ error: 'steps[] obrigatório' });

    const results = [];
    for (const step of steps) {
      try {
        if (step.action === 'create-field') {
          const fullName = step.object + '.' + step.field;
          const body = { fullName, label: step.label || step.field.replace('__c','').replace(/_/g,' '), type: step.type || 'Text' };
          if (['Text'].includes(body.type)) body.length = step.length || 255;
          if (body.type === 'LongTextArea') { body.length = step.length || 32768; body.visibleLines = 4; }
          if (['Number','Currency','Percent'].includes(body.type)) { body.precision = step.precision || 18; body.scale = step.scale ?? 2; }
          if (body.type === 'Lookup' && step.referenceTo) { body.referenceTo = step.referenceTo; body.relationshipLabel = step.relationshipLabel || body.label; body.relationshipName = step.relationshipName || step.field.replace('__c',''); }
          if (['Picklist','MultiselectPicklist'].includes(body.type)) {
            const vals = step.picklist || step.values || [];
            body.valueSet = { restricted: true, valueSetDefinition: { sorted: false, value: vals.map(v => typeof v === 'string' ? { fullName: v, default: false, label: v } : v) }};
            if (body.type === 'MultiselectPicklist') body.visibleLines = step.visibleLines || 4;
          }
          if (body.type === 'Checkbox') body.defaultValue = step.defaultValue === true || step.defaultValue === 'true';
          const r = await metadataCreate(org, 'CustomField', body);
          const item = Array.isArray(r) ? r[0] : r;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          const exists = errs.some(e => ((e.message||e.statusCode||'')+'').toLowerCase().includes('already') || ((e.message||e.statusCode||'')+'').toLowerCase().includes('duplicate'));
          results.push({ step: step.field || step.name, ok: ok || exists, exists, message: ok ? `✅ ${fullName}` : exists ? `ℹ️ já existe: ${fullName}` : `❌ ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` });
        } else if (step.action === 'metadata-create') {
          const r = await metadataCreate(org, step.type, step.body);
          const item = Array.isArray(r) ? r[0] : r;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          const exists = errs.some(e => ((e.message||e.statusCode||'')+'').toLowerCase().includes('already') || ((e.message||e.statusCode||'')+'').toLowerCase().includes('duplicate'));
          results.push({ step: step.body?.fullName || step.type, ok: ok || exists, exists, message: ok ? `✅ ${step.type}: ${step.body?.fullName}` : exists ? `ℹ️ já existe` : `❌ ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` });
        } else if (step.action === 'apex-class') {
          const r = await deployApexClass(org, step.name, step.body);
          const ok = r.success !== false;
          results.push({ step: step.name, ok, message: ok ? `✅ ${step.name}` : `❌ ${JSON.stringify(r.errors||r).substring(0,300)}` });
        } else if (step.action === 'flow') {
          const flowBody = step.body || {};
          const r = await deployFlow(org, step.fullName || step.name, flowBody);
          const item = Array.isArray(r) ? r[0] : r;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          results.push({ step: step.fullName || step.name, ok, message: ok ? `✅ Flow: ${step.fullName || step.name}` : `❌ ${errs.map(e=>e.message||JSON.stringify(e)).join(', ').substring(0,400)}` });
        } else if (step.action === 'profile-fls') {
          // updateProfileFLS usa org.connection (não connectToOrg interno)
          if (!org.connection) org.connection = await connectToOrg(org);
          const fieldPerms = (step.fieldPermissions || []).map(fp => typeof fp === 'string' ? { field: fp, readable: true, editable: true } : fp);
          const r = await updateProfileFLS(org, step.profileName, fieldPerms, step.objectPermissions || []);
          const ok = r?.success !== false && r?.status !== 'error';
          results.push({ step: step.profileName, ok, message: ok ? `✅ FLS: ${step.profileName}` : `❌ FLS ${step.profileName}: ${r?.message || JSON.stringify(r).substring(0,200)}` });
        } else if (step.action === 'metadata-update') {
          const r = await metadataUpdate(org, step.type, step.body);
          const item = Array.isArray(r) ? r[0] : r;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          results.push({ step: step.body?.fullName || step.type, ok, message: ok ? `✅ ${step.type}: ${step.body?.fullName} updated` : `❌ ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` });
        } else if (step.action === 'metadata-read') {
          const r = await metadataRead(org, step.type, step.fullName);
          const ok = r && r.fullName;
          results.push({ step: step.fullName, ok: !!ok, data: r, message: ok ? `✅ ${step.type}: ${step.fullName}` : `❌ não encontrado: ${step.fullName}` });
        } else if (step.action === 'activate-rule') {
          const r = await activateRule(org, step.ruleType, step.ruleName, step.activate !== false);
          const item = Array.isArray(r) ? r[0] : r;
          const ok = item?.success !== false;
          const errs = item?.errors ? (Array.isArray(item.errors) ? item.errors : [item.errors]) : [];
          results.push({ step: step.ruleName, ok, message: ok ? `✅ ${step.ruleType} ${step.activate !== false ? 'ativada' : 'desativada'}: ${step.ruleName}` : `❌ ${errs.map(e=>e.message||JSON.stringify(e)).join(', ')}` });
        } else if (step.action === 'tooling-update') {
          const conn = await connectToOrg(org);
          const r = await conn.tooling.update(step.type, step.body);
          const ok = r?.success !== false;
          results.push({ step: step.body?.Id || step.type, ok, message: ok ? `✅ Tooling update ${step.type}: ${step.body?.Id}` : `❌ ${JSON.stringify(r).substring(0, 300)}` });
        } else {
          results.push({ step: step.action, ok: false, message: '⚠️ action não suportada no batch: ' + step.action });
        }
      } catch (err) {
        results.push({ step: step.field || step.name || step.action, ok: false, message: '❌ ' + err.message });
      }
    }
    const ok = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    res.json({ total: results.length, ok, fail, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
