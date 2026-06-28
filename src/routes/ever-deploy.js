// src/routes/ever-deploy.js — Ever DevOps: deploy entre orgs Salesforce
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { connectToOrg, metadataRead, testConnection } from '../services/sf-multi.js';
import pool from '../config/db.js';
import Anthropic from '@anthropic-ai/sdk';

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getOrg(id) {
  const r = await pool.query('SELECT * FROM orgs WHERE id = $1', [id]);
  return r.rows[0] || null;
}

async function ensureDeployTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ed_deploys (
      id SERIAL PRIMARY KEY,
      us_number VARCHAR(30) NOT NULL,
      us_name VARCHAR(200),
      origin_org_id INT NOT NULL,
      dest_org_id INT NOT NULL,
      status VARCHAR(30) DEFAULT 'pending',
      components JSONB DEFAULT '[]',
      git_commit VARCHAR(100),
      git_tag VARCHAR(100),
      error_component VARCHAR(200),
      error_message TEXT,
      paused_at_step INT DEFAULT 0,
      completed_steps JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ed_deploy_log (
      id SERIAL PRIMARY KEY,
      deploy_id INT REFERENCES ed_deploys(id) ON DELETE CASCADE,
      step INT,
      component VARCHAR(200),
      action VARCHAR(50),
      status VARCHAR(20),
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

// Inicializar tabelas ao subir
ensureDeployTables().catch(e => console.error('[EverDeploy] table init error:', e.message));

// ── GET /api/ever-deploy/orgs — lista orgs disponíveis ───────────────────────
router.get('/orgs', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, login_url, username, org_type FROM orgs ORDER BY name'
    );
    res.json({ orgs: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ever-deploy/orgs/:id/test — testa conexão ───────────────────────
router.get('/orgs/:id/test', authMiddleware, async (req, res) => {
  try {
    const org = await getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    const result = await testConnection(org);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ever-deploy/deploys — histórico ─────────────────────────────────
router.get('/deploys', authMiddleware, async (req, res) => {
  try {
    const { org_id, status, limit = 50 } = req.query;
    let q = `
      SELECT d.*,
        o1.name as origin_name, o2.name as dest_name
      FROM ed_deploys d
      LEFT JOIN orgs o1 ON o1.id = d.origin_org_id
      LEFT JOIN orgs o2 ON o2.id = d.dest_org_id
    `;
    const params = [];
    const where = [];
    if (org_id) { params.push(org_id); where.push(`(d.origin_org_id=$${params.length} OR d.dest_org_id=$${params.length})`); }
    if (status) { params.push(status); where.push(`d.status=$${params.length}`); }
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY d.created_at DESC LIMIT $' + (params.length + 1);
    params.push(parseInt(limit));
    const r = await pool.query(q, params);
    res.json({ deploys: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ever-deploy/deploys/:id — detalhe deploy ────────────────────────
router.get('/deploys/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.*, o1.name as origin_name, o2.name as dest_name
      FROM ed_deploys d
      LEFT JOIN orgs o1 ON o1.id = d.origin_org_id
      LEFT JOIN orgs o2 ON o2.id = d.dest_org_id
      WHERE d.id = $1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Deploy não encontrado' });

    const logs = await pool.query(
      'SELECT * FROM ed_deploy_log WHERE deploy_id=$1 ORDER BY id',
      [req.params.id]
    );
    res.json({ deploy: r.rows[0], logs: logs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ever-deploy/diff — analisa diff entre orgs ─────────────────────
router.post('/diff', authMiddleware, async (req, res) => {
  const { us_number, us_name, origin_org_id, dest_org_id, components } = req.body;
  if (!us_number || !origin_org_id || !dest_org_id || !components?.length) {
    return res.status(400).json({ error: 'us_number, origin_org_id, dest_org_id, components obrigatórios' });
  }
  try {
    const [originOrg, destOrg] = await Promise.all([
      getOrg(origin_org_id),
      getOrg(dest_org_id)
    ]);
    if (!originOrg) return res.status(404).json({ error: 'Org origem não encontrada' });
    if (!destOrg)   return res.status(404).json({ error: 'Org destino não encontrada' });

    // Para cada componente, verificar se existe no destino
    const diffResults = await Promise.all(components.map(async (comp) => {
      try {
        const existing = await metadataRead(destOrg, comp.type, comp.fullName);
        return {
          ...comp,
          existsInDest: !!existing,
          existingValue: existing || null,
          conflict: !!existing,
          action: existing ? 'update' : 'create'
        };
      } catch {
        return { ...comp, existsInDest: false, existingValue: null, conflict: false, action: 'create' };
      }
    }));

    // Análise Claude do diff
    const conflicts = diffResults.filter(c => c.conflict);
    const additions = diffResults.filter(c => !c.conflict);

    let claudeAnalysis = '';
    try {
      const prompt = `Você é um arquiteto Salesforce analisando um diff de deploy.

US: ${us_number} — ${us_name || ''}
Org origem: ${originOrg.name}
Org destino: ${destOrg.name}

Componentes novos (${additions.length}): ${additions.map(c => c.fullName).join(', ') || 'nenhum'}
Componentes com conflito (${conflicts.length}): ${conflicts.map(c => c.fullName).join(', ') || 'nenhum'}

Analise o impacto em 3-4 linhas em português. Seja direto e técnico.`;

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });
      claudeAnalysis = msg.content[0]?.text || '';
    } catch (e) {
      claudeAnalysis = 'Análise indisponível no momento.';
    }

    res.json({
      us_number,
      us_name,
      origin: { id: originOrg.id, name: originOrg.name },
      dest: { id: destOrg.id, name: destOrg.name },
      diff: diffResults,
      summary: {
        total: diffResults.length,
        additions: additions.length,
        conflicts: conflicts.length,
        removals: 0
      },
      claude_analysis: claudeAnalysis
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ever-deploy/deploy — inicia deploy ─────────────────────────────
router.post('/deploy', authMiddleware, async (req, res) => {
  const { us_number, us_name, origin_org_id, dest_org_id, components } = req.body;
  if (!us_number || !origin_org_id || !dest_org_id || !components?.length) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }
  try {
    const r = await pool.query(`
      INSERT INTO ed_deploys
        (us_number, us_name, origin_org_id, dest_org_id, status, components)
      VALUES ($1,$2,$3,$4,'running',$5)
      RETURNING id
    `, [us_number, us_name || '', origin_org_id, dest_org_id, JSON.stringify(components)]);

    const deployId = r.rows[0].id;
    res.json({ deploy_id: deployId, status: 'running' });

    // Execução assíncrona
    runDeploy(deployId, origin_org_id, dest_org_id, components, us_number).catch(e =>
      console.error(`[EverDeploy] deploy ${deployId} error:`, e.message)
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function runDeploy(deployId, originOrgId, destOrgId, components, usNumber) {
  const destOrg = await getOrg(destOrgId);
  const completedSteps = [];

  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    try {
      // Log início
      await pool.query(
        'INSERT INTO ed_deploy_log (deploy_id,step,component,action,status,message) VALUES ($1,$2,$3,$4,$5,$6)',
        [deployId, i + 1, comp.fullName, comp.action || 'deploy', 'running', `Deployando ${comp.type} ${comp.fullName}`]
      );

      // Executar deploy do componente na org destino
      await deployComponent(destOrg, comp);

      completedSteps.push(i + 1);

      // Log sucesso
      await pool.query(
        'INSERT INTO ed_deploy_log (deploy_id,step,component,action,status,message) VALUES ($1,$2,$3,$4,$5,$6)',
        [deployId, i + 1, comp.fullName, comp.action || 'deploy', 'ok', `${comp.fullName} deployado com sucesso`]
      );

      // Atualizar progresso
      const pct = Math.round(((i + 1) / components.length) * 100);
      await pool.query(
        'UPDATE ed_deploys SET completed_steps=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(completedSteps), deployId]
      );

    } catch (err) {
      // Erro — parar
      await pool.query(
        'INSERT INTO ed_deploy_log (deploy_id,step,component,action,status,message) VALUES ($1,$2,$3,$4,$5,$6)',
        [deployId, i + 1, comp.fullName, comp.action || 'deploy', 'error', err.message]
      );
      await pool.query(
        `UPDATE ed_deploys SET
          status='error', error_component=$1, error_message=$2,
          paused_at_step=$3, completed_steps=$4, updated_at=NOW()
        WHERE id=$5`,
        [comp.fullName, err.message, i + 1, JSON.stringify(completedSteps), deployId]
      );
      return;
    }
  }

  // Tudo OK — criar tag
  const tag = `${usNumber}-${destOrg.name.replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0,10)}`;
  await pool.query(
    `UPDATE ed_deploys SET status='ok', git_tag=$1, completed_steps=$2, updated_at=NOW() WHERE id=$3`,
    [tag, JSON.stringify(completedSteps), deployId]
  );
  await pool.query(
    'INSERT INTO ed_deploy_log (deploy_id,step,component,action,status,message) VALUES ($1,$2,$3,$4,$5,$6)',
    [deployId, components.length + 1, 'git', 'tag', 'ok', `Tag criada: ${tag}`]
  );
}

async function deployComponent(org, comp) {
  const { metadataCreate, metadataUpdate, deployField } = await import('../services/sf-multi.js');
  if (comp.type === 'CustomField') {
    await deployField(org, comp.metadata);
  } else if (comp.action === 'update') {
    await metadataUpdate(org, comp.type, comp.metadata);
  } else {
    await metadataCreate(org, comp.type, comp.metadata);
  }
}

// ── POST /api/ever-deploy/deploy/:id/resume — retomar deploy após correção ───
router.post('/deploy/:id/resume', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ed_deploys WHERE id=$1', [req.params.id]);
    const deploy = r.rows[0];
    if (!deploy) return res.status(404).json({ error: 'Deploy não encontrado' });
    if (deploy.status !== 'error') return res.status(400).json({ error: 'Deploy não está pausado com erro' });

    const components = deploy.components;
    const pausedAt = deploy.paused_at_step; // índice base 1
    const remaining = components.slice(pausedAt - 1); // retoma do que falhou

    await pool.query(
      'UPDATE ed_deploys SET status=\'running\', error_component=NULL, error_message=NULL, updated_at=NOW() WHERE id=$1',
      [deploy.id]
    );

    res.json({ deploy_id: deploy.id, status: 'running', resuming_from_step: pausedAt });

    runDeploy(deploy.id, deploy.origin_org_id, deploy.dest_org_id, remaining, deploy.us_number).catch(e =>
      console.error(`[EverDeploy] resume ${deploy.id} error:`, e.message)
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/ever-deploy/deploy/:id/rollback — rollback ─────────────────────
router.post('/deploy/:id/rollback', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM ed_deploys WHERE id=$1', [req.params.id]);
    const deploy = r.rows[0];
    if (!deploy) return res.status(404).json({ error: 'Deploy não encontrado' });

    await pool.query(
      'UPDATE ed_deploys SET status=\'rolledback\', updated_at=NOW() WHERE id=$1',
      [deploy.id]
    );
    await pool.query(
      'INSERT INTO ed_deploy_log (deploy_id,step,component,action,status,message) VALUES ($1,$2,$3,$4,$5,$6)',
      [deploy.id, 0, 'system', 'rollback', 'ok', `Rollback iniciado por ${req.user?.email || 'usuário'}`]
    );

    res.json({ status: 'rolledback', deploy_id: deploy.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/ever-deploy/deploy/:id/status — polling status ──────────────────
router.get('/deploy/:id/status', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT d.*, o1.name as origin_name, o2.name as dest_name
      FROM ed_deploys d
      LEFT JOIN orgs o1 ON o1.id=d.origin_org_id
      LEFT JOIN orgs o2 ON o2.id=d.dest_org_id
      WHERE d.id=$1
    `, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Não encontrado' });

    const logs = await pool.query(
      'SELECT * FROM ed_deploy_log WHERE deploy_id=$1 ORDER BY id',
      [req.params.id]
    );

    const deploy = r.rows[0];
    const total = (deploy.components || []).length;
    const done = (deploy.completed_steps || []).length;

    res.json({
      deploy: r.rows[0],
      logs: logs.rows,
      progress: { total, done, pct: total ? Math.round((done / total) * 100) : 0 }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
