// src/routes/migrate.js — Temporary: encrypt existing plaintext credentials
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { encrypt, isEncrypted } from '../services/crypto.js';
import pool from '../config/db.js';

const router = express.Router();

// POST /api/migrate/encrypt-credentials — One-shot migration
router.post('/encrypt-credentials', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { rows: orgs } = await pool.query('SELECT id, name, password, security_token FROM orgs');
    const results = [];
    for (const org of orgs) {
      const pwdNeed = org.password && !isEncrypted(org.password);
      const tokNeed = org.security_token && !isEncrypted(org.security_token);
      if (!pwdNeed && !tokNeed) {
        results.push({ id: org.id, name: org.name, status: 'skipped', reason: 'already encrypted' });
        continue;
      }
      const encPwd = pwdNeed ? encrypt(org.password) : org.password;
      const encTok = tokNeed ? encrypt(org.security_token) : org.security_token;
      await pool.query('UPDATE orgs SET password = $1, security_token = $2 WHERE id = $3', [encPwd, encTok || '', org.id]);
      results.push({ id: org.id, name: org.name, status: 'encrypted' });
    }
    res.json({ total: orgs.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
