import jwt from 'jsonwebtoken';
import pool from '../config/db.js';
const SECRET = process.env.JWT_SECRET || 'i9mcp-dev-secret';

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token ausente' });
  let decoded;
  try { decoded = jwt.verify(header.split(' ')[1], SECRET); }
  catch { return res.status(401).json({ error: 'Token invalido', code: 'TOKEN_INVALID' }); }
  try {
    const r = await pool.query('SELECT id, role, session_version FROM users WHERE id = $1', [decoded.id]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Sessao encerrada', code: 'SESSION_ENDED' });
    if ((decoded.sv || 1) !== (user.session_version || 1))
      return res.status(401).json({ error: 'Sessao encerrada', code: 'SESSION_ENDED' });
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name, role: user.role || decoded.role, token_limit: decoded.token_limit ?? null };
    next();
  } catch (err) {
    console.error('auth DB fail:', err.message);
    req.user = decoded;
    next();
  }
}

export function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role || 'funcional', sv: user.session_version || 1, token_limit: user.token_limit ?? null },
    SECRET, { expiresIn: '8h' }
  );
}
