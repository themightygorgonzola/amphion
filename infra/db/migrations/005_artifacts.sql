-- 005_artifacts.sql
-- Adds the artifacts table — the file-level atom.
--
-- An artifact is a managed copy of a file stored under data/artifacts/{id}/{filename}.
-- Every ingested document links to an artifact. The artifact survives even if the
-- original source path moves or is deleted.
--
-- Artifacts are the foundation for:
--   - File retrieval ("here is your essay, asdjklas.docx")
--   - Cross-domain corpus grouping (school projects, legal corpus, etc.)
--   - Future: device push, sharing, multimedia indexing

-- ---------------------------------------------------------------------------
-- artifacts table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifacts (
  id             bigserial    PRIMARY KEY,
  filename       text         NOT NULL,                    -- original filename e.g. "asdjklas.docx"
  mime_type      text         NOT NULL DEFAULT 'text/plain',
  stored_path    text         NOT NULL UNIQUE,             -- managed path: data/artifacts/{id}/{filename}
  domain         text         NOT NULL,                    -- same domain system as documents
  owner          text,                                     -- user/context identifier (for multi-user later)
  size_bytes     bigint,
  corpus         text,                                     -- optional grouping e.g. "school-projects", "rcw"
  description    text,                                     -- human-readable description (set at ingest or by AI)
  tags           text[]       NOT NULL DEFAULT '{}',
  metadata       jsonb,                                    -- flexible: { source_url, author, date, ... }
  created_at     timestamptz  NOT NULL DEFAULT NOW(),
  updated_at     timestamptz  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS artifacts_domain_idx   ON artifacts (domain);
CREATE INDEX IF NOT EXISTS artifacts_corpus_idx   ON artifacts (corpus) WHERE corpus IS NOT NULL;
CREATE INDEX IF NOT EXISTS artifacts_filename_idx ON artifacts USING gin (to_tsvector('simple', filename));
CREATE INDEX IF NOT EXISTS artifacts_tags_idx     ON artifacts USING gin (tags);

COMMENT ON TABLE artifacts IS
  'Managed file store. One row per ingested file. The stored_path column is the canonical location under data/artifacts/. documents.artifact_id links here.';

-- ---------------------------------------------------------------------------
-- Link documents → artifacts
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS artifact_id bigint REFERENCES artifacts (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS documents_artifact_id_idx ON documents (artifact_id) WHERE artifact_id IS NOT NULL;

COMMENT ON COLUMN documents.artifact_id IS
  'FK to artifacts. NULL for documents ingested before 005 migration or ingested with --no-copy flag.';
