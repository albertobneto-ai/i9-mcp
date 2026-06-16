import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import pool from './config/db.js';
import authRoutes from './routes/auth.js';
import { authMiddleware } from './middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'running', server: 'i9-mcp', version: '1.0.0' });
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
    const check = await pool.query("SELECT id FROM users WHERE email = 'admin@everi9.com'");
    if (check.rows.length === 0) {
      const hash = await bcrypt.hash('admin2026', 10);
      await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)",
        ['Alberto Bottaro', 'admin@everi9.com', hash, 'admin']);
    }
    res.json({ status: 'ok', tables: ['users', 'conversations'] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auth routes
app.use('/api/auth', authRoutes);

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
app.get('*', (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), err => {
    if (err) res.status(404).json({ error: 'Frontend not found' });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[i9-mcp] SF Agent running on port ${PORT}`));
