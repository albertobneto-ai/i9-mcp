import express from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/db.js';
import { generateToken } from '../middleware/auth.js';
const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatorios' });
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Credenciais invalidas' });
    res.json({ token: generateToken(user), user: { id: user.id, name: user.name, email: user.email, role: user.role || 'funcional' } });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Erro interno' }); }
});

export default router;
