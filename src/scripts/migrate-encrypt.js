// src/scripts/migrate-encrypt.js — One-shot migration: encrypt existing plaintext credentials
// Usage: node src/scripts/migrate-encrypt.js
// Requires ENCRYPTION_KEY and DATABASE_URL in environment

import pg from 'pg';
import { encrypt, isEncrypted } from '../services/crypto.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function migrate() {
  console.log('🔐 Starting credential encryption migration...');
  
  const { rows: orgs } = await pool.query('SELECT id, name, password, security_token FROM orgs');
  console.log(`Found ${orgs.length} orgs to check`);
  
  let encrypted = 0;
  let skipped = 0;
  
  for (const org of orgs) {
    const pwdNeedsEncrypt = org.password && !isEncrypted(org.password);
    const tokNeedsEncrypt = org.security_token && !isEncrypted(org.security_token);
    
    if (!pwdNeedsEncrypt && !tokNeedsEncrypt) {
      console.log(`  ⏭️  ${org.name} (id=${org.id}) — already encrypted, skipping`);
      skipped++;
      continue;
    }
    
    const encPwd = pwdNeedsEncrypt ? encrypt(org.password) : org.password;
    const encTok = tokNeedsEncrypt ? encrypt(org.security_token) : org.security_token;
    
    await pool.query(
      'UPDATE orgs SET password = $1, security_token = $2 WHERE id = $3',
      [encPwd, encTok || '', org.id]
    );
    
    console.log(`  ✅ ${org.name} (id=${org.id}) — encrypted`);
    encrypted++;
  }
  
  console.log(`\n🔐 Migration complete: ${encrypted} encrypted, ${skipped} skipped`);
  await pool.end();
}

migrate().catch(err => { console.error('❌ Migration failed:', err); process.exit(1); });
