// src/routes/devops.js
// Rotas REST para o engine /devops
// ADITIVO: registrar no index.js com app.use('/api/devops', ...)

import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import {
  analyzeDependencies,
  captureAsIs,
  formatDiff,
  preflightValidation,
  enableFieldHistory,
  capturePerformanceBaseline,
  compareBaselines,
  logDeployStep,
  getDeployAudit,
  diffSpecs,
  publishToAlm,
  ensureAlmArtifactsSchema
} from '../services/devops-engine.js';
import pool from '../config/db.js';

const router = express.Router();

// Garantir schema na inicialização
ensureAlmArtifactsSchema().catch(err => console.error('[devops] schema err:', err.message));

// Helper para buscar org
async function getOrgById(id) {
  const { rows } = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return rows[0] || null;
}

// ── K — POST /api/devops/:orgId/analyze-deps ──
// Body: { steps: [...] }
// Retorna: análise de dependências com blockers/warnings/safe
router.post('/:orgId/analyze-deps', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { steps = [] } = req.body;
    if (!steps.length) return res.status(400).json({ error: 'steps[] obrigatório' });
    const result = await analyzeDependencies(org, steps);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── C — POST /api/devops/:orgId/diff ──
// Body: { steps: [...] }
// Retorna: AS-IS vs TO-BE diff
router.post('/:orgId/diff', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { steps = [] } = req.body;
    const snapshot = await captureAsIs(org, steps);
    const diff = formatDiff(snapshot);
    res.json({ snapshot, diff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── N — POST /api/devops/:orgId/preflight ──
// Body: { steps: [...] }
// Retorna: validação sem aplicar
router.post('/:orgId/preflight', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { steps = [] } = req.body;
    const result = await preflightValidation(org, steps);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── J — POST /api/devops/:orgId/field-history ──
// Body: { object: "Account", fields: ["Campo1__c", "Campo2__c"] }
router.post('/:orgId/field-history', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { object, fields = [] } = req.body;
    if (!object || !fields.length) return res.status(400).json({ error: 'object e fields[] obrigatórios' });
    const result = await enableFieldHistory(org, object, fields);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── L — GET /api/devops/:orgId/performance/:object ──
// Captura performance baseline para objeto
router.get('/:orgId/performance/:object', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const result = await capturePerformanceBaseline(org, req.params.object);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── L — POST /api/devops/performance/compare ──
// Body: { before: {...}, after: {...} }
router.post('/performance/compare', authMiddleware, async (req, res) => {
  try {
    const { before, after } = req.body;
    if (!before || !after) return res.status(400).json({ error: 'before e after obrigatórios' });
    const diff = compareBaselines(before, after);
    res.json(diff);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── M — POST /api/devops/audit/log ──
// Body: { us, org, component, action, description, result, message, user, snapshot }
router.post('/audit/log', authMiddleware, async (req, res) => {
  try {
    const { us, org, component, action, description, result, message, user, snapshot } = req.body;
    await logDeployStep(us, org, component, action, description, result, message, user, snapshot);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── M — GET /api/devops/audit/:us ──
router.get('/audit/:us', authMiddleware, async (req, res) => {
  try {
    const result = await getDeployAudit(req.params.us);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── I — POST /api/devops/spec-diff ──
// Body: { specV1: "texto spec v1", specV2: "texto spec v2" }
router.post('/spec-diff', authMiddleware, async (req, res) => {
  try {
    const { specV1, specV2 } = req.body;
    if (!specV1 || !specV2) return res.status(400).json({ error: 'specV1 e specV2 obrigatórios' });
    const result = diffSpecs(specV1, specV2);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── O — POST /api/devops/publish-alm ──
// Body: { storyId: 123, artifacts: [{ type: "ADR", name: "...", url: "...", content: {...} }] }
router.post('/publish-alm', authMiddleware, async (req, res) => {
  try {
    const { storyId, artifacts = [] } = req.body;
    if (!storyId || !artifacts.length) return res.status(400).json({ error: 'storyId e artifacts[] obrigatórios' });
    const result = await publishToAlm(storyId, artifacts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PIPELINE COMPLETO — POST /api/devops/:orgId/pipeline ──
// Executa: K (deps) → C (diff) → N (preflight) → L (perf before)
// Retorna resultado consolidado para decisão de GO/NO-GO
router.post('/:orgId/pipeline', authMiddleware, async (req, res) => {
  try {
    const org = await getOrgById(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const { steps = [], object = 'Account', us = 'UNKNOWN' } = req.body;
    if (!steps.length) return res.status(400).json({ error: 'steps[] obrigatório' });

    // 1. Dependency Analysis (K)
    const deps = await analyzeDependencies(org, steps);

    // 2. AS-IS snapshot (C)
    const snapshot = await captureAsIs(org, steps);
    const diff = formatDiff(snapshot);

    // 3. Pre-flight (N)
    const preflight = await preflightValidation(org, steps);

    // 4. Performance baseline (L)
    let perfBefore = null;
    try {
      perfBefore = await capturePerformanceBaseline(org, object);
    } catch { perfBefore = { error: 'Could not capture baseline' }; }

    // GO/NO-GO decision
    const canDeploy = deps.summary.canDeploy && preflight.canDeploy;

    // Log pipeline execution (M)
    await logDeployStep(us, org.name || 'unknown', 'pipeline', 'preflight', 
      `K:${deps.summary.blockers}blk/${deps.summary.warnings}warn | N:${preflight.passed}/${preflight.total} | C:${diff.length} components`,
      canDeploy ? 'success' : 'blocked',
      canDeploy ? '✅ Pipeline GO' : `❌ Pipeline NO-GO: ${deps.summary.blockers} blockers, ${preflight.failed} preflight fails`,
      'system'
    );

    res.json({
      canDeploy,
      decision: canDeploy ? '🟢 GO — Todos checks passaram' : '🔴 NO-GO — Blockers ou falhas de pre-flight',
      dependencies: deps,
      diff,
      preflight,
      performanceBefore: perfBefore,
      us
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
