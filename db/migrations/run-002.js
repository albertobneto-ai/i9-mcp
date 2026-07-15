import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      BEGIN;
      ALTER TABLE orgs ADD COLUMN IF NOT EXISTS last_metadata_sync TIMESTAMPTZ;
      ALTER TABLE orgs ADD COLUMN IF NOT EXISTS metadata_cache JSONB;
      COMMIT;
    `);
    console.log('Migration 002 OK: last_metadata_sync + metadata_cache added to orgs');
  } catch (err) {
    console.error('Migration 002 error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
