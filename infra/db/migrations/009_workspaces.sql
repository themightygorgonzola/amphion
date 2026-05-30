-- 009_workspaces.sql
-- Introduces the workspace abstraction: a grouping above "domain" that
-- can own a set of documents, artifacts, and conversations — scoped to
-- one person or one purpose (e.g. "Jayden's school", "Dad's CAD bench").
--
-- Design decisions:
--   - workspace_id is NULLABLE everywhere — null = "global / unscoped" (backward compat)
--   - slug is the human-facing key used by the self-organizing agent (e.g. "school-jayden")
--   - owner_user_id ties the workspace to one user but is not enforced via FK
--     (users aren't in PG — they're in SQLite)

-- -----------------------------------------------------------------------
-- workspaces — one row per named workspace
-- -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workspaces (
  id             SERIAL PRIMARY KEY,
  slug           TEXT   NOT NULL UNIQUE,
  display_name   TEXT   NOT NULL,
  owner_user_id  TEXT   NOT NULL DEFAULT 'default',
  description    TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id);
CREATE INDEX IF NOT EXISTS workspaces_slug_idx  ON workspaces (slug);

-- -----------------------------------------------------------------------
-- Add workspace_id FK to documents
-- -----------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_workspace_idx ON documents (workspace_id);

-- -----------------------------------------------------------------------
-- Add workspace_id FK to artifacts
-- -----------------------------------------------------------------------
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS artifacts_workspace_idx ON artifacts (workspace_id);
