-- 012_practical_organization.sql
--
-- Practical organization layer on top of resources.
--
-- Goals:
--   - Keep the existing workspaces table as an internal scope container primitive.
--   - Allow hierarchical scopes without forcing everything into one silo.
--   - Allow one resource to belong to multiple scopes.
--   - Add a lightweight relational layer for reusable entities and typed links.

-- ---------------------------------------------------------------------------
-- Extend workspaces into internal scope containers.
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS parent_workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS workspace_type TEXT NOT NULL DEFAULT 'scope',
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS workspaces_parent_idx ON workspaces (parent_workspace_id);
CREATE INDEX IF NOT EXISTS workspaces_type_idx ON workspaces (workspace_type);
CREATE INDEX IF NOT EXISTS workspaces_active_open_idx
  ON workspaces (owner_user_id, updated_at DESC)
  WHERE is_active = true AND closed_at IS NULL;

COMMENT ON COLUMN workspaces.parent_workspace_id IS
  'Optional parent scope for nested project or matter organization.';
COMMENT ON COLUMN workspaces.workspace_type IS
  'Internal scope category: scope, project, matter, collection, archive, or other product-specific labels.';
COMMENT ON COLUMN workspaces.closed_at IS
  'Optional archival timestamp for scopes that should remain queryable but not active by default.';
COMMENT ON COLUMN workspaces.metadata IS
  'Flexible scope metadata such as client, stage, matter number, product line, or operational hints.';

-- ---------------------------------------------------------------------------
-- Resource-to-scope many-to-many membership.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_workspaces (
  id            BIGSERIAL PRIMARY KEY,
  resource_id   BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS resource_workspaces_workspace_idx ON resource_workspaces (workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS resource_workspaces_resource_idx ON resource_workspaces (resource_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS resource_workspaces_primary_idx
  ON resource_workspaces (resource_id)
  WHERE is_primary = true;

COMMENT ON TABLE resource_workspaces IS
  'Many-to-many scope membership for resources. A resource can participate in several scopes while retaining one primary home scope.';

-- ---------------------------------------------------------------------------
-- Lightweight entity layer for reusable cross-cutting facts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL,
  slug               TEXT,
  display_name       TEXT NOT NULL,
  description        TEXT,
  owner_user_id      TEXT NOT NULL DEFAULT 'default',
  home_workspace_id  INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities (kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS entities_home_workspace_idx ON entities (home_workspace_id);
CREATE INDEX IF NOT EXISTS entities_owner_idx ON entities (owner_user_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS entities_kind_slug_idx
  ON entities (kind, slug)
  WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS entities_name_fts_idx
  ON entities USING gin (to_tsvector('english', coalesce(display_name, '') || ' ' || coalesce(description, '')));

COMMENT ON TABLE entities IS
  'Reusable named things that can span multiple scopes: people, companies, projects, parts, vendors, contracts, tasks, and similar business objects.';

-- ---------------------------------------------------------------------------
-- Resource-to-entity links with typed relationship and confidence.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resource_entities (
  id             BIGSERIAL PRIMARY KEY,
  resource_id    BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  entity_id      BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL DEFAULT 'mentions',
  confidence     REAL NOT NULL DEFAULT 1.0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource_id, entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS resource_entities_entity_idx ON resource_entities (entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS resource_entities_resource_idx ON resource_entities (resource_id, updated_at DESC);

COMMENT ON TABLE resource_entities IS
  'Typed links from resources to reusable entities, preserving how a document or note relates to a person, company, part, or task.';

-- ---------------------------------------------------------------------------
-- Entity-to-entity relationships with optional provenance.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_links (
  id                 BIGSERIAL PRIMARY KEY,
  from_entity_id     BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_entity_id       BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type      TEXT NOT NULL,
  strength           REAL NOT NULL DEFAULT 1.0,
  source_resource_id BIGINT REFERENCES resources(id) ON DELETE SET NULL,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_entity_id, to_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS entity_links_from_idx ON entity_links (from_entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS entity_links_to_idx ON entity_links (to_entity_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS entity_links_source_idx ON entity_links (source_resource_id);

COMMENT ON TABLE entity_links IS
  'Typed relationships between reusable entities, optionally grounded in a source resource.';
