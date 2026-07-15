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
      CREATE TABLE IF NOT EXISTS us_components (
        id              SERIAL PRIMARY KEY,
        us_id           INT NOT NULL REFERENCES user_stories(id) ON DELETE CASCADE,
        component_name  TEXT NOT NULL,
        component_type  TEXT NOT NULL,
        action          TEXT DEFAULT 'deploy',
        added_by        INT REFERENCES users(id),
        added_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(us_id, component_name, component_type)
      );
      CREATE INDEX IF NOT EXISTS idx_us_components_us_id ON us_components(us_id);
      CREATE INDEX IF NOT EXISTS idx_us_components_name ON us_components(component_name);
      COMMIT;
    `);
    console.log('Migration 003 OK: us_components table + indexes created');
  } catch (err) {
    console.error('Migration 003 error:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
