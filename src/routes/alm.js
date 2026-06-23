import { Router } from 'express';
import pool from '../config/db.js';
import mammoth from 'mammoth';

const router = Router();

/* ═══ INIT ALM TABLES ═══ */
export async function initAlmTables() {
  await pool.query(`CREATE TABLE IF NOT EXISTS alm_epics (
    id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    owner VARCHAR(100),
    color VARCHAR(10) DEFAULT '#4F46E5',
    start_date DATE,
    end_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS alm_stories (
    id VARCHAR(30) PRIMARY KEY,
    title VARCHAR(500) NOT NULL,
    epic_id VARCHAR(20) REFERENCES alm_epics(id),
    stage VARCHAR(30) DEFAULT 'backlog',
    prev_stage VARCHAR(30),
    priority VARCHAR(10) DEFAULT 'medium',
    assignee VARCHAR(100),
    sprint VARCHAR(50),
    planned_date DATE,
    actual_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_stories_epic ON alm_stories(epic_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_stories_stage ON alm_stories(stage)');

  await pool.query(`CREATE TABLE IF NOT EXISTS alm_artifacts (
    id SERIAL PRIMARY KEY,
    story_id VARCHAR(30) REFERENCES alm_stories(id) ON DELETE CASCADE,
    artifact_type VARCHAR(30) NOT NULL,
    has_artifact BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_alm_art_unique ON alm_artifacts(story_id, artifact_type)');

  await pool.query(`CREATE TABLE IF NOT EXISTS alm_files (
    id SERIAL PRIMARY KEY,
    story_id VARCHAR(30) REFERENCES alm_stories(id) ON DELETE CASCADE,
    name VARCHAR(500) NOT NULL,
    file_type VARCHAR(30),
    version VARCHAR(20) DEFAULT 'v1.0',
    file_date DATE DEFAULT CURRENT_DATE,
    content TEXT,
    github_path VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_files_story ON alm_files(story_id)');

  // DevOps pipeline: processing_status for HF files
  try { await pool.query('ALTER TABLE alm_files ADD COLUMN IF NOT EXISTS processing_status VARCHAR(20) DEFAULT \'none\''); } catch {}
  try { await pool.query('ALTER TABLE alm_files ADD COLUMN IF NOT EXISTS binary_content TEXT'); } catch {}
  try { await pool.query('ALTER TABLE alm_files ADD COLUMN IF NOT EXISTS extracted_text TEXT'); } catch {}
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_files_procstatus ON alm_files(processing_status)');

  await pool.query(`CREATE TABLE IF NOT EXISTS alm_trace (
    id SERIAL PRIMARY KEY,
    story_id VARCHAR(30) REFERENCES alm_stories(id) ON DELETE CASCADE,
    event VARCHAR(200) NOT NULL,
    stage VARCHAR(30),
    icon VARCHAR(10) DEFAULT '📋',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_trace_story ON alm_trace(story_id)');

  // Pipeline artifacts: content storage + versioning (jun/2026)
  try { await pool.query('ALTER TABLE alm_artifacts ADD COLUMN IF NOT EXISTS content TEXT'); } catch {}
  try { await pool.query('ALTER TABLE alm_artifacts ADD COLUMN IF NOT EXISTS version INT DEFAULT 1'); } catch {}
  try { await pool.query('ALTER TABLE alm_artifacts ADD COLUMN IF NOT EXISTS agent VARCHAR(30)'); } catch {}

  // Pipeline status on stories (BA → SA → DEV → QA_TECH → QA_FUNC)
  try { await pool.query("ALTER TABLE alm_stories ADD COLUMN IF NOT EXISTS pipeline_status VARCHAR(30) DEFAULT 'none'"); } catch(e) { console.log("ALM migration pipeline_status:", e.message); }
  try { await pool.query("ALTER TABLE alm_stories ADD COLUMN IF NOT EXISTS pipeline_iteration INT DEFAULT 0"); } catch(e) { console.log("ALM migration pipeline_iteration:", e.message); }
}

/* ═══ HELPER ═══ */
function row2epic(r) {
  return { id:r.id, name:r.name, desc:r.description, owner:r.owner, color:r.color, startDate:r.start_date, endDate:r.end_date };
}
function row2story(r, artifacts, files) {
  return {
    us:r.id, title:r.title, epicId:r.epic_id, stage:r.stage, prevStage:r.prev_stage,
    priority:r.priority, assignee:r.assignee, sprint:r.sprint,
    plannedDate:r.planned_date?r.planned_date.toISOString().slice(0,10):null,
    actualDate:r.actual_date?r.actual_date.toISOString().slice(0,10):null,
    created:r.created_at?r.created_at.toISOString().slice(0,10):null,
    pipelineStatus:r.pipeline_status||'none',
    pipelineIteration:r.pipeline_iteration||0,
    artifacts: artifacts || {hf:false,spec:false,deploy:false,qa:false,adr:false,cenario:false,zip:false},
    files: files || [],
  };
}

async function getArtifacts(storyId) {
  const res = await pool.query('SELECT artifact_type, has_artifact FROM alm_artifacts WHERE story_id=$1', [storyId]);
  const arts = {hf:false,spec:false,deploy:false,qa:false,adr:false,cenario:false,zip:false};
  res.rows.forEach(r => { if (arts.hasOwnProperty(r.artifact_type)) arts[r.artifact_type] = r.has_artifact; });
  return arts;
}

async function getFiles(storyId) {
  const res = await pool.query('SELECT id,name,file_type,version,file_date,processing_status FROM alm_files WHERE story_id=$1 ORDER BY created_at', [storyId]);
  return res.rows.map(r => ({ id:r.id, name:r.name, type:r.file_type, version:r.version, date:r.file_date?r.file_date.toISOString().slice(0,10):null, processingStatus:r.processing_status||'none' }));
}

async function addTrace(storyId, event, stage, icon) {
  await pool.query('INSERT INTO alm_trace(story_id,event,stage,icon) VALUES($1,$2,$3,$4)', [storyId,event,stage||null,icon||'📋']);
}

async function setArtifact(storyId, type, has, content, version, agent) {
  if (content !== undefined && content !== null) {
    // Pipeline mode: store content + version
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
    const ver = version || 1;
    const ag = agent || null;
    await pool.query(`INSERT INTO alm_artifacts(story_id,artifact_type,has_artifact,content,version,agent,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT(story_id,artifact_type) DO UPDATE SET has_artifact=$3, content=$4, version=$5, agent=$6, updated_at=NOW()`,
      [storyId, type, has!==false, contentStr, ver, ag]);
  } else {
    // Legacy mode: flag only (retrocompatible)
    await pool.query(`INSERT INTO alm_artifacts(story_id,artifact_type,has_artifact,updated_at) VALUES($1,$2,$3,NOW())
      ON CONFLICT(story_id,artifact_type) DO UPDATE SET has_artifact=$3, updated_at=NOW()`, [storyId,type,has!==false]);
  }
}

/* ═══ EPICS ═══ */
router.get('/epics', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM alm_epics ORDER BY created_at');
    res.json(result.rows.map(row2epic));
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/epics', async (req, res) => {
  try {
    const {id,name,desc,owner,color,startDate,endDate} = req.body;
    await pool.query('INSERT INTO alm_epics(id,name,description,owner,color,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id,name,desc||'',owner||'',color||'#4F46E5',startDate||null,endDate||null]);
    res.json({status:'created',id});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/epics/:id', async (req, res) => {
  try {
    const {name,desc,owner,color,startDate,endDate} = req.body;
    await pool.query('UPDATE alm_epics SET name=COALESCE($1,name),description=COALESCE($2,description),owner=COALESCE($3,owner),color=COALESCE($4,color),start_date=COALESCE($5,start_date),end_date=COALESCE($6,end_date) WHERE id=$7',
      [name,desc,owner,color,startDate,endDate,req.params.id]);
    res.json({status:'updated'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ STORIES ═══ */
router.get('/stories', async (req, res) => {
  try {
    const filter = req.query.epic_id ? ' WHERE epic_id=$1' : '';
    const params = req.query.epic_id ? [req.query.epic_id] : [];
    const result = await pool.query('SELECT * FROM alm_stories' + filter + ' ORDER BY created_at', params);
    const stories = [];
    for (const r of result.rows) {
      const arts = await getArtifacts(r.id);
      const files = await getFiles(r.id);
      stories.push(row2story(r, arts, files));
    }
    res.json(stories);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/stories/:us', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM alm_stories WHERE id=$1', [req.params.us]);
    if (!result.rows.length) return res.status(404).json({error:'Story not found'});
    const r = result.rows[0];
    const arts = await getArtifacts(r.id);
    const files = await getFiles(r.id);
    const trace = await pool.query('SELECT event,stage,icon,created_at FROM alm_trace WHERE story_id=$1 ORDER BY created_at', [r.id]);
    const story = row2story(r, arts, files);
    story.timeline = trace.rows.map(t => ({event:t.event,stage:t.stage,icon:t.icon,date:t.created_at?t.created_at.toISOString().slice(0,10):null}));
    res.json(story);
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/stories', async (req, res) => {
  try {
    const {us,title,epicId,priority,assignee,sprint,plannedDate} = req.body;
    await pool.query('INSERT INTO alm_stories(id,title,epic_id,priority,assignee,sprint,planned_date) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [us,title,epicId||null,priority||'medium',assignee||'',sprint||'',plannedDate||null]);
    await addTrace(us, 'US criada', 'backlog', '📋');
    res.json({status:'created',us});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.put('/stories/:us', async (req, res) => {
  try {
    const {title,epicId,priority,assignee,sprint,plannedDate} = req.body;
    await pool.query('UPDATE alm_stories SET title=COALESCE($1,title),epic_id=COALESCE($2,epic_id),priority=COALESCE($3,priority),assignee=COALESCE($4,assignee),sprint=COALESCE($5,sprint),planned_date=COALESCE($6,planned_date),updated_at=NOW() WHERE id=$7',
      [title,epicId,priority,assignee,sprint,plannedDate,req.params.us]);
    res.json({status:'updated'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ STAGE TRANSITIONS ═══ */
const STAGE_ORDER = ['backlog','refinamento','hf','spec','dev','testes','deploy','homologacao'];
const STAGE_LABELS = {backlog:'Backlog',refinamento:'Refinamento Funcional',hf:'Escrita HF',spec:'Escrita Spec',dev:'Desenvolvimento',testes:'Testes',deploy:'Deploy',homologacao:'Homologação',bugfix:'Em Bugfix'};
const STAGE_ICONS = {backlog:'📋',refinamento:'🔍',hf:'📄',spec:'📐',dev:'⚙️',testes:'🧪',deploy:'🚀',homologacao:'✅',bugfix:'🐛'};

router.post('/stories/:us/advance', async (req, res) => {
  try {
    const r = await pool.query('SELECT stage FROM alm_stories WHERE id=$1', [req.params.us]);
    if (!r.rows.length) return res.status(404).json({error:'Story not found'});
    const cur = r.rows[0].stage;
    const idx = STAGE_ORDER.indexOf(cur);
    if (idx < 0 || idx >= STAGE_ORDER.length - 1) return res.status(400).json({error:'Cannot advance from ' + cur});
    const next = STAGE_ORDER[idx + 1];
    const updates = next === 'homologacao'
      ? 'stage=$1, actual_date=CURRENT_DATE, updated_at=NOW()'
      : 'stage=$1, updated_at=NOW()';
    await pool.query('UPDATE alm_stories SET ' + updates + ' WHERE id=$2', [next, req.params.us]);
    await addTrace(req.params.us, STAGE_LABELS[next], next, STAGE_ICONS[next]);
    res.json({status:'advanced', from:cur, to:next});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/stories/:us/bugfix', async (req, res) => {
  try {
    const r = await pool.query('SELECT stage FROM alm_stories WHERE id=$1', [req.params.us]);
    if (!r.rows.length) return res.status(404).json({error:'Story not found'});
    await pool.query('UPDATE alm_stories SET prev_stage=stage, stage=$1, updated_at=NOW() WHERE id=$2', ['bugfix', req.params.us]);
    await addTrace(req.params.us, 'Bug reportado', 'bugfix', '🐛');
    res.json({status:'bugfix', prevStage:r.rows[0].stage});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.post('/stories/:us/bugfix-resolve', async (req, res) => {
  try {
    const r = await pool.query('SELECT prev_stage FROM alm_stories WHERE id=$1', [req.params.us]);
    if (!r.rows.length) return res.status(404).json({error:'Story not found'});
    const back = r.rows[0].prev_stage || 'dev';
    await pool.query('UPDATE alm_stories SET stage=$1, prev_stage=NULL, updated_at=NOW() WHERE id=$2', [back, req.params.us]);
    await addTrace(req.params.us, 'Bugfix resolvido → ' + STAGE_LABELS[back], back, '✅');
    res.json({status:'resolved', stage:back});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ FILES ═══ */
router.post('/stories/:us/files', async (req, res) => {
  try {
    const {name,fileType,version,content,binaryBase64} = req.body;
    const procStatus = fileType === 'hf' ? 'pendente' : 'none';
    let extractedText = null;

    // If docx binary provided, extract text with mammoth
    if (binaryBase64 && (name.endsWith('.docx') || name.endsWith('.DOCX'))) {
      try {
        const buf = Buffer.from(binaryBase64, 'base64');
        const result = await mammoth.extractRawText({ buffer: buf });
        extractedText = result.value;
      } catch (ex) { console.error('mammoth extract error:', ex.message); }
    }

    const result = await pool.query(
      `INSERT INTO alm_files(story_id,name,file_type,version,content,binary_content,extracted_text,processing_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.params.us, name, fileType||'other', version||'v1.0', content||extractedText||null, binaryBase64||null, extractedText||null, procStatus]
    );
    // Auto-set artifact flag
    if (['hf','spec','adr','cenario','zip'].includes(fileType)) {
      await setArtifact(req.params.us, fileType, true);
    }
    await addTrace(req.params.us, 'Upload: ' + name, null, '📎');
    res.json({status:'uploaded', fileId:result.rows[0].id, processingStatus:procStatus, textExtracted:!!extractedText});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.get('/stories/:us/files', async (req, res) => {
  try {
    const files = await getFiles(req.params.us);
    res.json(files);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ ARTIFACTS ═══ */
router.post('/stories/:us/artifacts', async (req, res) => {
  try {
    const {type, has, content, version, agent} = req.body;
    await setArtifact(req.params.us, type, has, content, version, agent);
    const resp = {status:'updated', storyId:req.params.us, type};
    if (content) resp.hasContent = true;
    if (version) resp.version = version;
    if (agent) resp.agent = agent;
    res.json(resp);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ PIPELINE ARTIFACTS (read) ═══ */
router.get('/stories/:us/artifacts', async (req, res) => {
  try {
    const { type } = req.query;
    let query = 'SELECT artifact_type, has_artifact, content, version, agent, updated_at FROM alm_artifacts WHERE story_id=$1';
    const params = [req.params.us];
    if (type) { query += ' AND artifact_type=$2'; params.push(type); }
    query += ' ORDER BY updated_at DESC';
    const result = await pool.query(query, params);
    const artifacts = result.rows.map(r => ({
      type: r.artifact_type,
      has: r.has_artifact,
      content: r.content ? (function(){ try { return JSON.parse(r.content); } catch { return r.content; } })() : null,
      version: r.version,
      agent: r.agent,
      updatedAt: r.updated_at ? r.updated_at.toISOString() : null
    }));
    // If single type requested, return just that artifact
    if (type && artifacts.length > 0) return res.json(artifacts[0]);
    res.json(artifacts);
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ PIPELINE STATUS ═══ */
router.put('/stories/:us/pipeline', async (req, res) => {
  try {
    const { status, iteration } = req.body;
    const validPipeline = ['none','ba','sa','dev','qa_tech','qa_func','done','blocked'];
    if (status && !validPipeline.includes(status)) {
      return res.status(400).json({error:'Invalid pipeline status. Use: ' + validPipeline.join(', ')});
    }
    const updates = [];
    const params = [];
    let idx = 1;
    if (status) { updates.push(`pipeline_status=$${idx++}`); params.push(status); }
    if (iteration !== undefined) { updates.push(`pipeline_iteration=$${idx++}`); params.push(iteration); }
    updates.push('updated_at=NOW()');
    params.push(req.params.us);
    await pool.query(`UPDATE alm_stories SET ${updates.join(',')} WHERE id=$${idx}`, params);
    await addTrace(req.params.us, `Pipeline: ${status || '?'}${iteration ? ' (iteracao '+iteration+')' : ''}`, null, '⚙️');
    res.json({status:'updated', pipeline: status, iteration});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ TIMELINE ═══ */
router.get('/stories/:us/timeline', async (req, res) => {
  try {
    const result = await pool.query('SELECT event,stage,icon,created_at FROM alm_trace WHERE story_id=$1 ORDER BY created_at', [req.params.us]);
    res.json(result.rows.map(t => ({event:t.event,stage:t.stage,icon:t.icon,date:t.created_at?t.created_at.toISOString().slice(0,10):null})));
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ DASHBOARD METRICS ═══ */
router.get('/dashboard', async (req, res) => {
  try {
    const stories = await pool.query('SELECT stage, planned_date, actual_date FROM alm_stories');
    const total = stories.rows.length;
    const byStage = {};
    let hom = 0, late = 0, bugs = 0;
    const now = new Date();
    stories.rows.forEach(r => {
      byStage[r.stage] = (byStage[r.stage]||0) + 1;
      if (r.stage === 'homologacao') hom++;
      if (r.stage === 'bugfix') bugs++;
      if (r.planned_date && !r.actual_date && new Date(r.planned_date) < now) late++;
    });
    res.json({total, homologadas:hom, atrasadas:late, bugfix:bugs, byStage});
  } catch(e) { res.status(500).json({error:e.message}); }
});


/* ═══ DELETE ═══ */
router.delete('/stories/:us', async (req, res) => {
  try {
    await pool.query('DELETE FROM alm_trace WHERE story_id=$1', [req.params.us]);
    await pool.query('DELETE FROM alm_files WHERE story_id=$1', [req.params.us]);
    await pool.query('DELETE FROM alm_artifacts WHERE story_id=$1', [req.params.us]);
    await pool.query('DELETE FROM alm_stories WHERE id=$1', [req.params.us]);
    res.json({status:'deleted', us:req.params.us});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/epics/:id', async (req, res) => {
  try {
    // Check if epic has stories
    const check = await pool.query('SELECT COUNT(*) as cnt FROM alm_stories WHERE epic_id=$1', [req.params.id]);
    if (parseInt(check.rows[0].cnt) > 0) {
      return res.status(400).json({error:'Épico possui histórias vinculadas. Remova as histórias primeiro.'});
    }
    await pool.query('DELETE FROM alm_epics WHERE id=$1', [req.params.id]);
    res.json({status:'deleted', id:req.params.id});
  } catch(e) { res.status(500).json({error:e.message}); }
});

router.delete('/stories/:us/files/:fileId', async (req, res) => {
  try {
    await pool.query('DELETE FROM alm_files WHERE id=$1 AND story_id=$2', [req.params.fileId, req.params.us]);
    res.json({status:'deleted'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ DEVOPS PIPELINE — HF Processing ═══ */

// List stories with pending HF files (for /devops command)
router.get('/pending-devops', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT s.id as story_id, s.title, s.epic_id, s.stage, s.priority,
             f.id as file_id, f.name as file_name, f.file_type, f.processing_status, f.created_at as file_uploaded
      FROM alm_stories s
      JOIN alm_files f ON f.story_id = s.id
      WHERE f.file_type = 'hf' AND f.processing_status = 'pendente'
      ORDER BY f.created_at ASC
    `);
    const stories = {};
    result.rows.forEach(r => {
      if (!stories[r.story_id]) {
        stories[r.story_id] = {
          us: r.story_id, title: r.title, epicId: r.epic_id, stage: r.stage, priority: r.priority, hfFiles: []
        };
      }
      stories[r.story_id].hfFiles.push({
        fileId: r.file_id, name: r.file_name, uploaded: r.file_uploaded ? r.file_uploaded.toISOString().slice(0,10) : null
      });
    });
    res.json({ pending: Object.values(stories), count: Object.keys(stories).length });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Extract text from a file (mammoth for docx, plain for text)
router.get('/files/:id/extract', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, file_type, content, binary_content, extracted_text FROM alm_files WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({error:'File not found'});
    const f = result.rows[0];

    // If already extracted, return cached
    if (f.extracted_text) {
      return res.json({ fileId: f.id, name: f.name, type: f.file_type, text: f.extracted_text, source: 'cached' });
    }

    // If binary docx, extract now
    if (f.binary_content && (f.name.endsWith('.docx') || f.name.endsWith('.DOCX'))) {
      const buf = Buffer.from(f.binary_content, 'base64');
      const mammothResult = await mammoth.extractRawText({ buffer: buf });
      const text = mammothResult.value;
      // Cache the extracted text
      await pool.query('UPDATE alm_files SET extracted_text=$1 WHERE id=$2', [text, f.id]);
      return res.json({ fileId: f.id, name: f.name, type: f.file_type, text, source: 'mammoth' });
    }

    // Fallback to content field
    if (f.content) {
      return res.json({ fileId: f.id, name: f.name, type: f.file_type, text: f.content, source: 'content' });
    }

    res.status(400).json({error:'No extractable content found'});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Update file processing status
router.put('/files/:id/status', async (req, res) => {
  try {
    const { status } = req.body; // pendente, processando, concluido, erro
    const valid = ['none','pendente','processando','concluido','erro'];
    if (!valid.includes(status)) return res.status(400).json({error:'Invalid status. Use: ' + valid.join(', ')});
    await pool.query('UPDATE alm_files SET processing_status=$1 WHERE id=$2', [status, req.params.id]);
    res.json({status:'updated', processingStatus:status});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Set story stage directly (for post-devops transition)
router.post('/stories/:us/set-stage', async (req, res) => {
  try {
    const { stage } = req.body;
    const validStages = ['backlog','refinamento','hf','spec','dev','testes','deploy','homologacao','bugfix'];
    if (!validStages.includes(stage)) return res.status(400).json({error:'Invalid stage'});
    const r = await pool.query('SELECT stage FROM alm_stories WHERE id=$1', [req.params.us]);
    if (!r.rows.length) return res.status(404).json({error:'Story not found'});
    const prev = r.rows[0].stage;
    await pool.query('UPDATE alm_stories SET stage=$1, prev_stage=$2, updated_at=NOW() WHERE id=$3', [stage, prev, req.params.us]);
    await addTrace(req.params.us, (STAGE_LABELS[stage]||stage) + ' (devops)', stage, STAGE_ICONS[stage]||'⚙️');
    res.json({status:'moved', from:prev, to:stage});
  } catch(e) { res.status(500).json({error:e.message}); }
});

/* ═══ SEED (populate from mock data) ═══ */
router.post('/seed', async (req, res) => {
  try {
    const {epics, stories} = req.body;
    for (const ep of (epics||[])) {
      await pool.query('INSERT INTO alm_epics(id,name,description,owner,color,start_date,end_date) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING',
        [ep.id, ep.name, ep.desc||'', ep.owner||'', ep.color||'#4F46E5', ep.startDate||ep.s||null, ep.endDate||ep.e||null]);
    }
    for (const st of (stories||[])) {
      await pool.query(`INSERT INTO alm_stories(id,title,epic_id,stage,prev_stage,priority,assignee,sprint,planned_date,actual_date)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
        [st.us, st.title, st.epicId, st.stage, st.prevStage||null, st.priority, st.assignee||'', st.sprint||'', st.plannedDate||null, st.actualDate||null]);
      if (st.artifacts) {
        for (const [type, has] of Object.entries(st.artifacts)) {
          if (has) await setArtifact(st.us, type, true);
        }
      }
      if (st.files) {
        for (const f of st.files) {
          await pool.query('INSERT INTO alm_files(story_id,name,file_type,version,file_date) VALUES($1,$2,$3,$4,$5)',
            [st.us, f.name, f.type, f.version||'v1.0', f.date||null]);
        }
      }
    }
    res.json({status:'seeded', epics:(epics||[]).length, stories:(stories||[]).length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

export default router;
