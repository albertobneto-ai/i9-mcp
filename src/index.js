import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import pool from './config/db.js';
import authRoutes from './routes/auth.js';
import orgRoutes from './routes/orgs.js';
import downloadRoutes from './routes/download.js';
import { authMiddleware } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-org-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', server: 'i9-mcp', version: '1.0.1' });
});

// Init DB
app.get('/api/init-db', async (req, res) => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) DEFAULT 'funcional', session_version INT DEFAULT 1,
      token_limit BIGINT DEFAULT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255), messages JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id)');
    await pool.query(`CREATE TABLE IF NOT EXISTS orgs (
      id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
      login_url VARCHAR(255) NOT NULL, username VARCHAR(255) NOT NULL,
      password VARCHAR(255) NOT NULL, security_token VARCHAR(100) DEFAULT '',
      org_type VARCHAR(20) DEFAULT 'sandbox', org_id VARCHAR(50),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY, user_id INT, kind VARCHAR(40),
      status VARCHAR(20) DEFAULT 'pending', input TEXT,
      result TEXT, error TEXT, meta JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS deploy_log (
      id SERIAL PRIMARY KEY,
      us_number VARCHAR(40),
      component VARCHAR(255),
      action VARCHAR(60),
      description TEXT,
      result VARCHAR(20),
      result_message TEXT,
      org_id INT,
      org_name VARCHAR(100),
      user_id INT,
      user_name VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_deploylog_us ON deploy_log(us_number)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_deploylog_created ON deploy_log(created_at DESC)');
    // Additive: snapshot column for rollback
    try { await pool.query('ALTER TABLE deploy_log ADD COLUMN IF NOT EXISTS previous_state TEXT'); } catch {}
    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('admin2026', 10);
      await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['Alberto Bottaro', 'admin@everi9.com', hash, 'admin']);
    }
    res.json({ status: 'ok', tables: ['users', 'conversations', 'orgs', 'jobs', 'deploy_log'] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/orgs', orgRoutes);
app.use('/api/download', downloadRoutes);

// Job status polling
app.get('/api/jobs/:id', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, kind, status, result, error, meta FROM jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Job não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// KB Assistant (Haiku) — floating agent endpoint
import { knowledgeBase } from './config/knowledge-base.js';
import { callHaikuWithSearch } from './services/claude.js';
app.post('/api/kb-chat', authMiddleware, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });

    const systemPrompt = `Você é o assistente de conhecimento do projeto Salesforce Algar Telecom B2B. Responda perguntas com base na documentação abaixo. Seja conciso e direto. Se não souber, diga que não tem essa informação na base.

${knowledgeBase}

Regras:
- Responda em português do Brasil
- Seja objetivo (2-4 parágrafos no máximo)
- Use formatação markdown quando útil
- Se a pergunta não for sobre Salesforce ou o projeto, diga educadamente que você é especializado em Salesforce
- Você tem acesso a pesquisa web. Use-a para complementar respostas quando a base de conhecimento não tiver a informação completa
- Ao usar informações da web, mencione brevemente a fonte`;

    const userMsgs = messages.slice(-6); // últimas 6 mensagens para contexto
    const response = await callHaikuWithSearch(systemPrompt, userMsgs, 2048);
    res.json({ choices: [{ message: { content: response } }], model: 'haiku' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Chat route (lazy load)
let chatRouter = null;
app.use('/api/chat', authMiddleware, async (req, res, next) => {
  if (!chatRouter) {
    const mod = await import('./routes/chat.js');
    chatRouter = mod.default;
  }
  chatRouter(req, res, next);
});

// Static frontend
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), err => {
    if (err) res.status(404).json({ error: 'Frontend not found' });
  });
});

// Global safety nets — prevent any uncaught error from killing the dyno
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[i9-mcp] SF Agent v1.2 on port ${PORT}`));
