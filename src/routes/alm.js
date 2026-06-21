import { Router } from 'express';
import pool from '../config/db.js';

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

  await pool.query(`CREATE TABLE IF NOT EXISTS alm_trace (
    id SERIAL PRIMARY KEY,
    story_id VARCHAR(30) REFERENCES alm_stories(id) ON DELETE CASCADE,
    event VARCHAR(200) NOT NULL,
    stage VARCHAR(30),
    icon VARCHAR(10) DEFAULT '📋',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alm_trace_story ON alm_trace(story_id)');
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
  const res = await pool.query('SELECT id,name,file_type,version,file_date FROM alm_files WHERE story_id=$1 ORDER BY created_at', [storyId]);
  return res.rows.map(r => ({ id:r.id, name:r.name, type:r.file_type, version:r.version, date:r.file_date?r.file_date.toISOString().slice(0,10):null }));
}

async function addTrace(storyId, event, stage, icon) {
  await pool.query('INSERT INTO alm_trace(story_id,event,stage,icon) VALUES($1,$2,$3,$4)', [storyId,event,stage||null,icon||'📋']);
}

async function setArtifact(storyId, type, has) {
  await pool.query(`INSERT INTO alm_artifacts(story_id,artifact_type,has_artifact,updated_at) VALUES($1,$2,$3,NOW())
    ON CONFLICT(story_id,artifact_type) DO UPDATE SET has_artifact=$3, updated_at=NOW()`, [storyId,type,has!==false]);
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
    const {name,fileType,version,content} = req.body;
    const result = await pool.query('INSERT INTO alm_files(story_id,name,file_type,version,content) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [req.params.us, name, fileType||'other', version||'v1.0', content||null]);
    // Auto-set artifact flag
    if (['hf','spec','adr','cenario','zip'].includes(fileType)) {
      await setArtifact(req.params.us, fileType, true);
    }
    await addTrace(req.params.us, 'Upload: ' + name, null, '📎');
    res.json({status:'uploaded', fileId:result.rows[0].id});
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
    const {type,has} = req.body;
    await setArtifact(req.params.us, type, has);
    res.json({status:'updated'});
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
