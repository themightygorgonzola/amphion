-- 010_resources.sql
-- Resource core model.
--
-- This migration is additive/non-destructive. It creates the new generalized
-- resource layer and backfills it from the older documents/artifacts tables,
-- while leaving those tables in place for compatibility.

-- ---------------------------------------------------------------------------
-- Enhance corpora: a corpus is now a typed collection of resources.
-- ---------------------------------------------------------------------------
ALTER TABLE corpora
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS resource_type text,
  ADD COLUMN IF NOT EXISTS schema_hint jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'managed';

UPDATE corpora
SET slug = domain
WHERE slug IS NULL;

UPDATE corpora
SET resource_type = CASE
  WHEN agent_type = 'statutes' THEN 'statutes'
  WHEN agent_type = 'recall' THEN 'conversations'
  WHEN agent_type = 'artifacts' THEN 'files'
  ELSE 'documents'
END
WHERE resource_type IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS corpora_slug_idx ON corpora (slug);
CREATE INDEX IF NOT EXISTS corpora_resource_type_idx ON corpora (resource_type);
CREATE INDEX IF NOT EXISTS corpora_access_mode_idx ON corpora (access_mode);

COMMENT ON COLUMN corpora.slug IS
  'Human/stable corpus key. Defaults to the legacy domain value for compatibility.';
COMMENT ON COLUMN corpora.resource_type IS
  'General resource family held by this corpus: documents, statutes, files, conversations, mixed, external.';
COMMENT ON COLUMN corpora.schema_hint IS
  'Optional corpus-specific structure hints. Example: {"hierarchy":["chapter","section"]} for RCW.';
COMMENT ON COLUMN corpora.access_mode IS
  'managed = content is held locally; streaming/external = future tool-backed corpora.';

-- Ensure every legacy document/artifact domain has a corpus row.
INSERT INTO corpora (domain, slug, display_name, agent_type, resource_type, dispatcher_description, scope_notes, not_in_corpus, access_mode)
SELECT DISTINCT d.domain, d.domain, initcap(replace(d.domain, '-', ' ')), 'documents', 'documents',
       'General resource corpus.', 'Resources migrated from legacy documents table.', '', 'managed'
FROM documents d
WHERE NOT EXISTS (SELECT 1 FROM corpora c WHERE c.domain = d.domain)
ON CONFLICT (domain) DO NOTHING;

INSERT INTO corpora (domain, slug, display_name, agent_type, resource_type, dispatcher_description, scope_notes, not_in_corpus, access_mode)
SELECT DISTINCT COALESCE(a.corpus, a.domain), COALESCE(a.corpus, a.domain), initcap(replace(COALESCE(a.corpus, a.domain), '-', ' ')),
       'documents', 'files', 'General resource corpus.', 'File resources migrated from legacy artifacts table.', '', 'managed'
FROM artifacts a
WHERE NOT EXISTS (SELECT 1 FROM corpora c WHERE c.domain = COALESCE(a.corpus, a.domain))
ON CONFLICT (domain) DO NOTHING;

INSERT INTO corpora (domain, slug, display_name, agent_type, resource_type, dispatcher_description, scope_notes, not_in_corpus, access_mode, schema_hint)
VALUES (
  'conversations', 'conversations', 'Conversation Records', 'documents', 'conversations',
  'Past conversation records and assistant/user turns.',
  'Conversation records created by Amphion. Useful for remembering what was discussed and connecting prior decisions to current work.',
  '', 'managed', '{"source":"sqlite-conversations"}'::jsonb
)
ON CONFLICT (domain) DO UPDATE SET
  slug = EXCLUDED.slug,
  display_name = EXCLUDED.display_name,
  resource_type = EXCLUDED.resource_type,
  dispatcher_description = EXCLUDED.dispatcher_description,
  scope_notes = EXCLUDED.scope_notes,
  access_mode = EXCLUDED.access_mode,
  schema_hint = EXCLUDED.schema_hint,
  updated_at = NOW();

-- RCW hierarchy belongs to the RCW corpus metadata, not to the global schema.
UPDATE corpora
SET schema_hint = schema_hint || '{"hierarchy":["chapter","section"],"citation":"RCW"}'::jsonb
WHERE domain = 'legal';

-- ---------------------------------------------------------------------------
-- resources: one row per first-class digital entity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS resources (
  id                 bigserial PRIMARY KEY,
  corpus_id          integer REFERENCES corpora(id) ON DELETE SET NULL,
  type               text NOT NULL DEFAULT 'document',
  title              text NOT NULL,
  source_ref         text NOT NULL,
  source_kind        text NOT NULL DEFAULT 'path',
  content_hash       text,
  summary            text,
  summary_embedding  vector(768),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  size_bytes         bigint,
  mime_type          text,
  stored_path        text,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  updated_at         timestamptz NOT NULL DEFAULT NOW(),
  embed_model        text NOT NULL DEFAULT 'nomic-embed-text'
);

CREATE UNIQUE INDEX IF NOT EXISTS resources_corpus_source_idx ON resources (corpus_id, source_ref);
CREATE INDEX IF NOT EXISTS resources_corpus_idx ON resources (corpus_id);
CREATE INDEX IF NOT EXISTS resources_type_idx ON resources (type);
CREATE INDEX IF NOT EXISTS resources_updated_idx ON resources (updated_at DESC);
CREATE INDEX IF NOT EXISTS resources_summary_embedding_idx
  ON resources USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE summary_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS resources_fts_idx
  ON resources USING gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(source_ref, '')));

COMMENT ON TABLE resources IS
  'First-class digital entities known to Amphion: files, documents, conversations, web pages, emails, future external references.';

-- Backfill documents as resources.
INSERT INTO resources (
  corpus_id, type, title, source_ref, source_kind, content_hash, summary,
  summary_embedding, metadata, created_at, updated_at, embed_model,
  size_bytes, mime_type, stored_path
)
SELECT
  c.id,
  COALESCE(NULLIF(d.doc_type, ''), 'document'),
  d.title,
  d.source_path,
  CASE WHEN d.source_path ~ '^[a-zA-Z]:[\\/]' OR d.source_path LIKE '/%' THEN 'path' ELSE 'ref' END,
  d.content_hash,
  d.summary,
  d.summary_embedding,
  jsonb_build_object(
    'legacy_document_id', d.id,
    'legacy_domain', d.domain,
    'doc_type', d.doc_type,
    'artifact_id', d.artifact_id
  ) || COALESCE(d.metadata, '{}'::jsonb),
  d.created_at,
  d.updated_at,
  COALESCE(d.embed_model, 'nomic-embed-text'),
  a.size_bytes,
  a.mime_type,
  a.stored_path
FROM documents d
JOIN corpora c ON c.domain = d.domain
LEFT JOIN artifacts a ON a.id = d.artifact_id
ON CONFLICT (corpus_id, source_ref) DO UPDATE SET
  type = EXCLUDED.type,
  title = EXCLUDED.title,
  content_hash = EXCLUDED.content_hash,
  summary = EXCLUDED.summary,
  summary_embedding = EXCLUDED.summary_embedding,
  metadata = EXCLUDED.metadata,
  updated_at = EXCLUDED.updated_at,
  embed_model = EXCLUDED.embed_model,
  size_bytes = EXCLUDED.size_bytes,
  mime_type = EXCLUDED.mime_type,
  stored_path = EXCLUDED.stored_path;

-- Backfill standalone artifacts as resources too. If an artifact already appeared
-- through documents.artifact_id, this creates/updates a file-shaped resource keyed
-- by its managed stored path.
INSERT INTO resources (
  corpus_id, type, title, source_ref, source_kind, content_hash, summary,
  metadata, size_bytes, mime_type, stored_path, created_at, updated_at
)
SELECT
  c.id,
  'file',
  a.filename,
  a.stored_path,
  'path',
  NULL,
  a.description,
  jsonb_build_object(
    'legacy_artifact_id', a.id,
    'legacy_domain', a.domain,
    'legacy_corpus', a.corpus,
    'tags', a.tags
  ) || COALESCE(a.metadata, '{}'::jsonb),
  a.size_bytes,
  a.mime_type,
  a.stored_path,
  a.created_at,
  a.updated_at
FROM artifacts a
JOIN corpora c ON c.domain = COALESCE(a.corpus, a.domain)
ON CONFLICT (corpus_id, source_ref) DO UPDATE SET
  title = EXCLUDED.title,
  summary = COALESCE(EXCLUDED.summary, resources.summary),
  metadata = EXCLUDED.metadata,
  size_bytes = EXCLUDED.size_bytes,
  mime_type = EXCLUDED.mime_type,
  stored_path = EXCLUDED.stored_path,
  updated_at = EXCLUDED.updated_at;

-- Link chunks to resources while keeping the legacy document_id column intact.
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS resource_id bigint REFERENCES resources(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS section_path text[];

UPDATE chunks ch
SET resource_id = r.id
FROM documents d
JOIN corpora c ON c.domain = d.domain
JOIN resources r ON r.corpus_id = c.id AND r.source_ref = d.source_path
WHERE ch.document_id = d.id
  AND ch.resource_id IS NULL;

UPDATE chunks
SET section_path = CASE
  WHEN section_header IS NULL OR length(trim(section_header)) = 0 THEN ARRAY[]::text[]
  ELSE ARRAY[regexp_replace(section_header, '^#{1,6}\s+', '')]
END
WHERE section_path IS NULL;

CREATE INDEX IF NOT EXISTS chunks_resource_idx ON chunks (resource_id, chunk_index);
CREATE INDEX IF NOT EXISTS chunks_section_path_idx ON chunks USING gin (section_path);

COMMENT ON COLUMN chunks.resource_id IS
  'New parent resource. document_id remains for compatibility until old callers are removed.';
COMMENT ON COLUMN chunks.section_path IS
  'Generic hierarchy path for the chunk. RCW sections are one possible corpus-specific interpretation.';
