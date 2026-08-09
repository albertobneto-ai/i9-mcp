// src/routes/pipeline.js — F5: Pipeline Tracker
// Tracks implementation pipelines from HF to delivery
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import pool from '../config/db.js';

const router = express.Router();

const STEPS = [
  { id: 1, name: 'captura', label: 'Captura HF' },
  { id: 2, name: 'scan', label: 'Scan Duplo' },
  { id: 3, name: 'gap', label: 'Gap Analysis' },
  { id: 4, name: 'spec', label: 'Spec Técnica' },
  { id: 5, name: 'deploy', label: 'Deploy' },
  { id: 6, name: 'qa', label: 'QA Tester' },
  { id: 7, name: 'docs', label: 'Documentação' },
  { id: 8, name: 'github', label: 'GitHub Push' }
];

// Ensure table exists
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipelines (
      id SERIAL PRIMARY KEY,
      story_id VARCHAR(50),
      title VARCHAR(255) NOT NULL,
      deploy_org_id INTEGER,
      ref_org_id INTEGER,
      current_step INTEGER DEFAULT 1,
      status VARCHAR(20) DEFAULT 'active',
      mode VARCHAR(20) DEFAULT 'full',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pipeline_steps (
      id SERIAL PRIMARY KEY,
      pipeline_id INTEGER REFERENCES pipelines(id),
      step_number INTEGER NOT NULL,
      step_name VARCHAR(50) NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      result JSONB,
      artifacts TEXT[],
      started_at TIMESTAMP,
      completed_at TIMESTAMP
    )
  `);
}

// ══════════════════════════════════════════════
// START PIPELINE
// ══════════════════════════════════════════════
// POST /api/pipeline/start
// Body: { storyId, title, deployOrgId, refOrgId, mode: 'full'|'spec-only' }
router.post('/start', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const { storyId, title, deployOrgId, refOrgId, mode } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const pipelineMode = mode || 'full';
    const maxStep = pipelineMode === 'spec-only' ? 4 : 8;

    const result = await pool.query(
      'INSERT INTO pipelines (story_id, title, deploy_org_id, ref_org_id, mode) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [storyId || null, title, deployOrgId || 36, refOrgId || 100, pipelineMode]
    );
    const pipelineId = result.rows[0].id;

    // Create step records
    const stepsToCreate = STEPS.slice(0, maxStep);
    for (const step of stepsToCreate) {
      await pool.query(
        'INSERT INTO pipeline_steps (pipeline_id, step_number, step_name, status) VALUES ($1, $2, $3, $4)',
        [pipelineId, step.id, step.name, step.id === 1 ? 'active' : 'pending']
      );
    }

    res.json({
      id: pipelineId,
      storyId,
      title,
      mode: pipelineMode,
      deployOrg: deployOrgId || 36,
      refOrg: refOrgId || 100,
      totalSteps: maxStep,
      currentStep: 1,
      steps: stepsToCreate.map(s => ({ ...s, status: s.id === 1 ? 'active' : 'pending' }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// GET PIPELINE STATUS
// ══════════════════════════════════════════════
// GET /api/pipeline/:id/status
router.get('/:id/status', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const pipelineId = req.params.id;

    const pipeline = await pool.query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
    if (pipeline.rows.length === 0) return res.status(404).json({ error: 'Pipeline not found' });

    const steps = await pool.query(
      'SELECT * FROM pipeline_steps WHERE pipeline_id = $1 ORDER BY step_number', [pipelineId]
    );

    const p = pipeline.rows[0];
    const stepData = steps.rows.map(s => {
      const def = STEPS.find(d => d.id === s.step_number) || {};
      return {
        number: s.step_number,
        name: s.step_name,
        label: def.label || s.step_name,
        status: s.status,
        result: s.result,
        artifacts: s.artifacts,
        startedAt: s.started_at,
        completedAt: s.completed_at
      };
    });

    res.json({
      id: p.id,
      storyId: p.story_id,
      title: p.title,
      mode: p.mode,
      status: p.status,
      deployOrg: p.deploy_org_id,
      refOrg: p.ref_org_id,
      currentStep: p.current_step,
      totalSteps: stepData.length,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      steps: stepData
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// ADVANCE PIPELINE (complete current step, move to next)
// ══════════════════════════════════════════════
// POST /api/pipeline/:id/advance
// Body: { result: {}, artifacts: ["file1.docx"] }
router.post('/:id/advance', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const pipelineId = req.params.id;
    const { result, artifacts } = req.body;

    const pipeline = await pool.query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
    if (pipeline.rows.length === 0) return res.status(404).json({ error: 'Pipeline not found' });

    const p = pipeline.rows[0];
    if (p.status === 'completed') return res.status(400).json({ error: 'Pipeline already completed' });

    const currentStep = p.current_step;
    const maxStep = p.mode === 'spec-only' ? 4 : 8;

    // Complete current step
    await pool.query(
      'UPDATE pipeline_steps SET status = $1, result = $2, artifacts = $3, completed_at = NOW() WHERE pipeline_id = $4 AND step_number = $5',
      ['completed', result ? JSON.stringify(result) : null, artifacts || null, pipelineId, currentStep]
    );

    if (currentStep >= maxStep) {
      // Pipeline complete
      await pool.query(
        'UPDATE pipelines SET status = $1, current_step = $2, updated_at = NOW() WHERE id = $3',
        ['completed', currentStep, pipelineId]
      );
      res.json({ id: pipelineId, status: 'completed', completedStep: currentStep, message: 'Pipeline finalizado' });
    } else {
      // Move to next step
      const nextStep = currentStep + 1;
      await pool.query(
        'UPDATE pipelines SET current_step = $1, updated_at = NOW() WHERE id = $2',
        [nextStep, pipelineId]
      );
      await pool.query(
        'UPDATE pipeline_steps SET status = $1, started_at = NOW() WHERE pipeline_id = $2 AND step_number = $3',
        ['active', pipelineId, nextStep]
      );

      const nextDef = STEPS.find(s => s.id === nextStep) || {};
      res.json({
        id: pipelineId,
        status: 'active',
        completedStep: currentStep,
        nextStep: { number: nextStep, name: nextDef.name, label: nextDef.label },
        remaining: maxStep - nextStep
      });
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// LIST PIPELINES
// ══════════════════════════════════════════════
// GET /api/pipeline/list?status=active
router.get('/list', authMiddleware, async (req, res) => {
  try {
    await ensureTable();
    const statusFilter = req.query.status;
    let query = 'SELECT * FROM pipelines ORDER BY updated_at DESC LIMIT 20';
    let params = [];
    if (statusFilter) {
      query = 'SELECT * FROM pipelines WHERE status = $1 ORDER BY updated_at DESC LIMIT 20';
      params = [statusFilter];
    }
    const result = await pool.query(query, params);

    res.json({
      total: result.rows.length,
      pipelines: result.rows.map(p => ({
        id: p.id,
        storyId: p.story_id,
        title: p.title,
        mode: p.mode,
        status: p.status,
        currentStep: p.current_step,
        deployOrg: p.deploy_org_id,
        updatedAt: p.updated_at
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
