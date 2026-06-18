const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  try {
    const cols = await p.query("SELECT column_name FROM information_schema.columns WHERE table_name='jobs' ORDER BY ordinal_position");
    console.log('COLS:', cols.rows.map(r=>r.column_name).join(','));
    
    const jobs = await p.query(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1`);
    console.log('SAMPLE COLS:', Object.keys(jobs.rows[0] || {}));
    
    // tentar agora com kind
    const recent = await p.query(`
      SELECT id, kind, status,
        EXTRACT(EPOCH FROM (updated_at - created_at))::int as dur_s,
        created_at::text as ts,
        LENGTH(COALESCE(result, '')) as result_len,
        meta->>'model' as model
      FROM jobs
      WHERE kind IN ('spec','runbook','spec-adjust','runbook-parse')
      ORDER BY created_at DESC LIMIT 15
    `);
    console.log('RECENT:', JSON.stringify(recent.rows, null, 2));
    p.end();
  } catch (e) {
    console.error('ERR:', e.message);
    p.end();
  }
})();
