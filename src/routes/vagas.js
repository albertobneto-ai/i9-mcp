import { Router } from 'express';
import pool from '../config/db.js';

const router = Router();

const STATUSES = ['radar', 'aplicada', 'triagem', 'entrevista', 'proposta', 'descartada'];

// chave estavel de deduplicacao: as urls curtas do Indeed rotacionam a cada busca
function slugKey(title, company) {
  const norm = (t) => (t || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
  return norm(company).slice(0, 14) + '-' + norm(title).slice(0, 60);
}

// ── Init table ──
router.get('/init', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS vagas_radar (
      id           SERIAL PRIMARY KEY,
      external_id  VARCHAR(120),
      source       VARCHAR(40) NOT NULL DEFAULT 'indeed',
      title        VARCHAR(400) NOT NULL,
      company      VARCHAR(200),
      location     VARCHAR(200),
      work_model   VARCHAR(30),
      job_type     VARCHAR(60),
      url          TEXT,
      posted_on    DATE,
      fit          VARCHAR(10) NOT NULL DEFAULT 'media',
      fit_reason   TEXT,
      tags         TEXT,
      status       VARCHAR(20) NOT NULL DEFAULT 'radar',
      notes        TEXT,
      applied_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS perfis_radar (
      id          SERIAL PRIMARY KEY,
      nome        VARCHAR(120) NOT NULL,
      headline    VARCHAR(300),
      localizacao VARCHAR(160),
      keywords    TEXT,
      resumo      TEXT,
      cor         VARCHAR(20) DEFAULT '#16334d',
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`);

    // perfil padrao (Alberto) — id 1
    const seed = await pool.query('SELECT id FROM perfis_radar LIMIT 1');
    if (!seed.rows.length) {
      await pool.query(
        `INSERT INTO perfis_radar (nome, headline, localizacao, keywords, resumo)
         VALUES ($1,$2,$3,$4,$5)`,
        ['Alberto',
         'Salesforce Solution Architect — Revenue Cloud, Sales Cloud, Data Cloud, Agentforce, Telecom',
         'Santo Andre, SP — remoto ou Grande SP',
         'Arquiteto Salesforce, Solution Architect, Tech Lead Salesforce, Revenue Cloud, CPQ, Data Cloud, Agentforce, Vlocity, OmniStudio, MuleSoft, telecom BSS/OSS',
         '9+ anos em tecnologia de telecom. Arquiteto de solucao de CRM B2B em operadora nacional (16 estados, 900+ consultores). Revenue Cloud (CPQ/Billing/RLM), Sales Cloud, Data Cloud, Agentforce, MuleSoft. Vivencia BSS/OSS em Claro, TIM, Deloitte e Everis.']);
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS perfil_docs (
      id         SERIAL PRIMARY KEY,
      perfil_id  INTEGER NOT NULL,
      tipo       VARCHAR(20) NOT NULL,
      filename   VARCHAR(255) NOT NULL,
      mime       VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
      conteudo   TEXT NOT NULL,
      tamanho    INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_perfil_tipo ON perfil_docs(perfil_id, tipo)');

    // vagas escopadas por perfil
    await pool.query(`CREATE OR REPLACE FUNCTION unaccent_fallback(t text) RETURNS text AS $$
      SELECT translate($1,
        'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
        'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
    $$ LANGUAGE SQL IMMUTABLE`);
    await pool.query(`ALTER TABLE vagas_radar ADD COLUMN IF NOT EXISTS perfil_id INTEGER`);
    await pool.query(`UPDATE vagas_radar SET perfil_id = (SELECT MIN(id) FROM perfis_radar) WHERE perfil_id IS NULL`);
    await pool.query(`DROP INDEX IF EXISTS idx_vagas_url`);
    await pool.query(`DROP INDEX IF EXISTS idx_vagas_perfil_url`);
    await pool.query(`UPDATE vagas_radar SET external_id =
      left(regexp_replace(lower(unaccent_fallback(coalesce(company,''))), '[^a-z]', '', 'g'), 14) || '-' ||
      left(regexp_replace(lower(unaccent_fallback(title)), '[^a-z]', '', 'g'), 60)
      WHERE external_id IS NULL`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_vagas_perfil_extid ON vagas_radar(perfil_id, external_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_perfil ON vagas_radar(perfil_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_status ON vagas_radar(status)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_fit ON vagas_radar(fit)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_vagas_updated ON vagas_radar(updated_at DESC)');
    res.json({ status: 'ok', tables: ['perfis_radar', 'perfil_docs', 'vagas_radar'] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══════════ PERFIS ══════════

// GET /api/vagas/perfis — lista perfis com contagem de vagas
router.get('/perfis', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.*,
              COALESCE(v.total_vagas, 0) AS total_vagas,
              COALESCE(v.total_aplicadas, 0) AS total_aplicadas,
              COALESCE(d.docs, '[]'::json) AS docs
       FROM perfis_radar p
       LEFT JOIN (
         SELECT perfil_id, COUNT(*)::int AS total_vagas,
                COUNT(*) FILTER (WHERE status = 'aplicada')::int AS total_aplicadas
         FROM vagas_radar GROUP BY perfil_id
       ) v ON v.perfil_id = p.id
       LEFT JOIN (
         SELECT perfil_id, json_agg(json_build_object(
           'id', id, 'tipo', tipo, 'filename', filename, 'tamanho', tamanho
         ) ORDER BY tipo) AS docs
         FROM perfil_docs GROUP BY perfil_id
       ) d ON d.perfil_id = p.id
       ORDER BY p.id`);
    res.json({ perfis: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/vagas/perfis
router.post('/perfis', async (req, res) => {
  try {
    const { nome, headline, localizacao, keywords, resumo, cor } = req.body || {};
    if (!nome) return res.status(400).json({ error: 'nome is required' });
    const r = await pool.query(
      `INSERT INTO perfis_radar (nome, headline, localizacao, keywords, resumo, cor)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nome, headline || null, localizacao || null, keywords || null, resumo || null, cor || '#16334d']);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/vagas/perfis/:id
router.patch('/perfis/:id', async (req, res) => {
  try {
    const allowed = ['nome', 'headline', 'localizacao', 'keywords', 'resumo', 'cor'];
    const fields = [], params = [];
    let idx = 1;
    for (const k of allowed) {
      if (req.body[k] !== undefined) { fields.push(`${k} = $${idx++}`); params.push(req.body[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE perfis_radar SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vagas/perfis/:id — remove perfil e suas vagas
router.delete('/perfis/:id', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*)::int AS n FROM perfis_radar');
    if (total.rows[0].n <= 1) return res.status(400).json({ error: 'Nao e possivel remover o unico perfil' });
    await pool.query('DELETE FROM vagas_radar WHERE perfil_id = $1', [req.params.id]);
    await pool.query('DELETE FROM perfil_docs WHERE perfil_id = $1', [req.params.id]);
    const r = await pool.query('DELETE FROM perfis_radar WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Perfil not found' });
    res.json({ deleted: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ══════════ DOCUMENTOS DO PERFIL ══════════

// POST /api/vagas/perfis/:id/docs — envia curriculo ou carta (base64)
router.post('/perfis/:id/docs', async (req, res) => {
  try {
    const { tipo, filename, mime, content } = req.body || {};
    if (!tipo || !['cv', 'carta'].includes(tipo)) return res.status(400).json({ error: "tipo deve ser 'cv' ou 'carta'" });
    if (!filename || !content) return res.status(400).json({ error: 'filename e content sao obrigatorios' });

    const tamanho = Math.round((content.length * 3) / 4);
    if (tamanho > 8 * 1024 * 1024) return res.status(400).json({ error: 'arquivo acima de 8MB' });

    const r = await pool.query(
      `INSERT INTO perfil_docs (perfil_id, tipo, filename, mime, conteudo, tamanho)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (perfil_id, tipo) DO UPDATE SET
         filename = EXCLUDED.filename, mime = EXCLUDED.mime,
         conteudo = EXCLUDED.conteudo, tamanho = EXCLUDED.tamanho,
         created_at = NOW()
       RETURNING id, tipo, filename, tamanho`,
      [req.params.id, tipo, filename, mime || 'application/pdf', content, tamanho]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/vagas/docs/:docId — serve o arquivo
router.get('/docs/:docId', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM perfil_docs WHERE id = $1', [req.params.docId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    const d = r.rows[0];
    const buf = Buffer.from(d.conteudo, 'base64');
    const disp = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', d.mime);
    res.setHeader('Content-Disposition', `${disp}; filename="${d.filename}"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/vagas/docs/:docId
router.delete('/docs/:docId', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM perfil_docs WHERE id = $1 RETURNING id', [req.params.docId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Documento nao encontrado' });
    res.json({ deleted: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════ VAGAS ══════════

// ── GET /api/vagas — list + stats ──
router.get('/', async (req, res) => {
  try {
    const { perfil_id, status, fit, search, limit = 200, offset = 0 } = req.query;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (perfil_id) { conditions.push(`perfil_id = $${idx++}`); params.push(perfil_id); }
    if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
    if (fit) { conditions.push(`fit = $${idx++}`); params.push(fit); }
    if (search) {
      conditions.push(`(title ILIKE $${idx} OR company ILIKE $${idx} OR tags ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(parseInt(limit), parseInt(offset));
    const data = await pool.query(
      `SELECT * FROM vagas_radar ${where}
       ORDER BY CASE fit WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                posted_on DESC NULLS LAST, id DESC
       LIMIT $${idx++} OFFSET $${idx++}`, params);

    const stats = await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM vagas_radar
       ${perfil_id ? 'WHERE perfil_id = $1' : ''} GROUP BY status`,
      perfil_id ? [perfil_id] : []);
    const byStatus = {};
    STATUSES.forEach(s => { byStatus[s] = 0; });
    stats.rows.forEach(r => { byStatus[r.status] = r.n; });

    res.json({ count: data.rows.length, stats: byStatus, vagas: data.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vagas — create one ──
router.post('/', async (req, res) => {
  try {
    const v = req.body || {};
    if (!v.title) return res.status(400).json({ error: 'title is required' });
    const r = await pool.query(
      `INSERT INTO vagas_radar
        (perfil_id, external_id, source, title, company, location, work_model, job_type,
         url, posted_on, fit, fit_reason, tags, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (perfil_id, external_id) DO UPDATE SET
         title = EXCLUDED.title, company = EXCLUDED.company, url = EXCLUDED.url,
         location = EXCLUDED.location, fit = EXCLUDED.fit,
         fit_reason = EXCLUDED.fit_reason, tags = EXCLUDED.tags,
         updated_at = NOW()
       RETURNING *`,
      [v.perfil_id || 1, v.external_id || slugKey(v.title, v.company), v.source || 'indeed', v.title, v.company || null,
       v.location || null, v.work_model || null, v.job_type || null,
       v.url || null, v.posted_on || null, v.fit || 'media', v.fit_reason || null,
       v.tags || null, v.status || 'radar', v.notes || null]);
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/vagas/bulk — import a batch ──
router.post('/bulk', async (req, res) => {
  try {
    const list = Array.isArray(req.body) ? req.body : (req.body.vagas || []);
    const perfilId = req.body.perfil_id || 1;
    if (!list.length) return res.status(400).json({ error: 'empty payload' });

    let inserted = 0, updated = 0;
    for (const v of list) {
      if (!v.title) continue;
      const r = await pool.query(
        `INSERT INTO vagas_radar
          (perfil_id, external_id, source, title, company, location, work_model, job_type,
           url, posted_on, fit, fit_reason, tags, status, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (perfil_id, external_id) DO UPDATE SET
           title = EXCLUDED.title, company = EXCLUDED.company, url = EXCLUDED.url,
           location = EXCLUDED.location, work_model = EXCLUDED.work_model,
           job_type = EXCLUDED.job_type, posted_on = EXCLUDED.posted_on,
           fit = EXCLUDED.fit, fit_reason = EXCLUDED.fit_reason,
           tags = EXCLUDED.tags, updated_at = NOW()
         RETURNING (xmax = 0) AS is_new`,
        [v.perfil_id || perfilId, v.external_id || slugKey(v.title, v.company), v.source || 'indeed', v.title, v.company || null,
         v.location || null, v.work_model || null, v.job_type || null,
         v.url || null, v.posted_on || null, v.fit || 'media', v.fit_reason || null,
         v.tags || null, v.status || 'radar', v.notes || null]);
      if (r.rows[0] && r.rows[0].is_new) inserted++; else updated++;
    }
    res.json({ inserted, updated, total: list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /api/vagas/:id ──
router.patch('/:id', async (req, res) => {
  try {
    const allowed = ['title', 'company', 'location', 'work_model', 'job_type',
                     'url', 'fit', 'fit_reason', 'tags', 'status', 'notes'];
    const fields = [];
    const params = [];
    let idx = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        params.push(req.body[key]);
      }
    }
    if (req.body.status === 'aplicada') fields.push('applied_at = COALESCE(applied_at, NOW())');
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });

    fields.push('updated_at = NOW()');
    params.push(req.params.id);
    const r = await pool.query(
      `UPDATE vagas_radar SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Vaga not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/vagas/:id ──
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM vagas_radar WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Vaga not found' });
    res.json({ deleted: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
