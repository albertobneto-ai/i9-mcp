-- ============================================================================
-- I9 ORG EXPLORER — Migration 001
-- Spec v2.1 · Seção 4 (Modelo de Dados)
-- Projeto: CRMB2B · Algar Telecom B2B · Everymind
-- Data: 14/07/2026
-- ============================================================================
-- Pré-requisito: tabelas existentes (orgs, jobs, deploy_log, users,
--                kb_documents, kb_chunks) já presentes no banco.
-- Executar: psql $DATABASE_URL < db/migrations/001_explorer.sql
-- ============================================================================

BEGIN;

-- ─── 4.1  user_stories ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stories (
  id            SERIAL PRIMARY KEY,
  jira_key      VARCHAR(50)  NOT NULL,
  title         TEXT         NOT NULL,
  type          VARCHAR(20)  NOT NULL,                    -- RELEASE | BUGFIX | HOTFIX
  priority      VARCHAR(20)  DEFAULT 'media',
  board_status  VARCHAR(30)  DEFAULT 'todo',              -- todo | prog | review | deploy | done
  src_org_id    INTEGER      REFERENCES orgs(id),
  tgt_org_id    INTEGER      REFERENCES orgs(id),
  sprint        VARCHAR(20),
  assigned_to   INTEGER      REFERENCES users(id),
  oe_id         VARCHAR(20),
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── 4.2  deploy_runs ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deploy_runs (
  id            SERIAL PRIMARY KEY,
  oe_id         VARCHAR(20)  NOT NULL UNIQUE,
  us_id         INTEGER      REFERENCES user_stories(id),
  type          VARCHAR(20)  NOT NULL,                    -- RELEASE | BUGFIX | HOTFIX | ROLLBACK
  src_org_id    INTEGER      REFERENCES orgs(id),
  tgt_org_id    INTEGER      REFERENCES orgs(id),
  status        VARCHAR(20)  DEFAULT 'pending',           -- pending | running | success | failed | partial
  deployed_by   INTEGER      REFERENCES users(id),
  deployed_at   TIMESTAMPTZ,
  duration_sec  INTEGER,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── 4.3  deploy_components ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deploy_components (
  id              SERIAL PRIMARY KEY,
  deploy_run_id   INTEGER      REFERENCES deploy_runs(id) ON DELETE CASCADE,
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  action          VARCHAR(20)  NOT NULL,                  -- created | replaced | rollback
  snap_before     TEXT,
  snap_after      TEXT,
  result          VARCHAR(20)  DEFAULT 'pending',         -- pending | success | failed
  error_message   TEXT                                    -- motivo em caso de falha
);

-- ─── 4.4  pending_merges ───────────────────────────────────────────────
-- Armazena merges preparados (stage-then-deploy) que ainda não foram deployados.
-- Nunca é limpo automaticamente; só sucesso de deploy remove o registro.
CREATE TABLE IF NOT EXISTS pending_merges (
  id              SERIAL PRIMARY KEY,
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  dest_org_id     INTEGER      REFERENCES orgs(id),
  gold_org_id     INTEGER      REFERENCES orgs(id),
  merged_content  TEXT         NOT NULL,
  prepared_by     INTEGER      REFERENCES users(id),
  prepared_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(component_name, dest_org_id)
);

-- ─── 4.5  eq_jobs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eq_jobs (
  id              SERIAL PRIMARY KEY,
  gold_org_id     INTEGER      REFERENCES orgs(id),
  dest_org_ids    INTEGER[]    NOT NULL,
  scope_types     TEXT[]       NOT NULL,
  only_diff       BOOLEAN      DEFAULT false,
  status          VARCHAR(20)  DEFAULT 'pending',
  total_comps     INTEGER,
  synced_comps    INTEGER      DEFAULT 0,
  result_json     JSONB,
  executed_by     INTEGER      REFERENCES users(id),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── 4.6  eq_components ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eq_components (
  id              SERIAL PRIMARY KEY,
  eq_job_id       INTEGER      REFERENCES eq_jobs(id) ON DELETE CASCADE,
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  dest_org_id     INTEGER      REFERENCES orgs(id),
  status_before   VARCHAR(20),                            -- ok | diff | absent | extra
  action_taken    VARCHAR(20),                            -- synced | skipped | failed
  snap_gold       TEXT,
  snap_dest       TEXT,
  synced_at       TIMESTAMPTZ
);

-- ─── 4.7  drift_snapshots ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drift_snapshots (
  id              SERIAL PRIMARY KEY,
  org_id          INTEGER      REFERENCES orgs(id),
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  content_hash    CHAR(64)     NOT NULL,                  -- SHA-256 hex
  captured_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── 4.8  drift_results ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS drift_results (
  id              SERIAL PRIMARY KEY,
  gold_org_id     INTEGER      REFERENCES orgs(id),
  dest_org_id     INTEGER      REFERENCES orgs(id),
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  status          VARCHAR(20)  NOT NULL,                  -- ok | diff | absent | extra
  detected_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── 4.9  Extensões à tabela orgs ──────────────────────────────────────
-- drift_summary: { "ok":N, "diff":N, "absent":N, "extra":N,
--                  "gold_org_id":36, "last_check":"..." }
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS drift_summary JSONB;

-- Apenas uma org por vez tem is_default_gold=true.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS is_default_gold BOOLEAN DEFAULT false;

-- ─── 4.10  component_meta ──────────────────────────────────────────────
-- Metadados de auditoria por componente+org (picker da Nova US).
CREATE TABLE IF NOT EXISTS component_meta (
  id              SERIAL PRIMARY KEY,
  component_name  VARCHAR(255) NOT NULL,
  component_type  VARCHAR(100) NOT NULL,
  org_id          INTEGER      REFERENCES orgs(id),
  created_date    TIMESTAMPTZ,
  last_modified   TIMESTAMPTZ,
  last_modified_by VARCHAR(100),
  last_snapshot_at TIMESTAMPTZ,
  UNIQUE(component_name, org_id)
);

-- ─── 4.12  Índices recomendados ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_us_jira_key       ON user_stories(jira_key);
CREATE INDEX IF NOT EXISTS idx_us_board          ON user_stories(board_status);
CREATE INDEX IF NOT EXISTS idx_dr_oe_id          ON deploy_runs(oe_id);
CREATE INDEX IF NOT EXISTS idx_dr_us_id          ON deploy_runs(us_id);
CREATE INDEX IF NOT EXISTS idx_dc_run_id         ON deploy_components(deploy_run_id);
CREATE INDEX IF NOT EXISTS idx_pm_dest           ON pending_merges(dest_org_id);
CREATE INDEX IF NOT EXISTS idx_eq_gold           ON eq_jobs(gold_org_id);
CREATE INDEX IF NOT EXISTS idx_eqc_job           ON eq_components(eq_job_id);
CREATE INDEX IF NOT EXISTS idx_drift_snap_org    ON drift_snapshots(org_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_drift_res_dest    ON drift_results(dest_org_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_cm_org            ON component_meta(org_id);

-- ─── Seed: marcar ORG ARQUITETURA como gold default ────────────────────
UPDATE orgs SET is_default_gold = false;
UPDATE orgs SET is_default_gold = true WHERE id = 36;

COMMIT;
