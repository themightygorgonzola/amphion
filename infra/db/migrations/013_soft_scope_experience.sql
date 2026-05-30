-- 013_soft_scope_experience.sql
--
-- Scope-local retrieval reinforcement.
--
-- Goals:
--   - Track which resources repeatedly helped inside a scope.
--   - Keep the signal bounded, inspectable, and decoupled from explicit graph growth.
--   - Support lightweight reranking boosts without mutating the canonical resource model.

CREATE TABLE IF NOT EXISTS resource_scope_stats (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  first_hit_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_hit_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS resource_scope_stats_workspace_idx
  ON resource_scope_stats (workspace_id, last_hit_at DESC);

CREATE INDEX IF NOT EXISTS resource_scope_stats_resource_idx
  ON resource_scope_stats (resource_id, last_hit_at DESC);

COMMENT ON TABLE resource_scope_stats IS
  'Soft scope-local experience signals for resources that repeatedly supported successful retrieval in a given scope.';
