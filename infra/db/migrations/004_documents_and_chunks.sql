-- 004_documents_and_chunks.sql
-- Two-tier document storage: documents (first-class entities) + chunks (children).
--
-- Replaces the flat knowledge_items table with a proper document model:
--   documents  — one row per ingested file, with summary + summary_embedding + content_hash
--   chunks     — one row per chunk, FK → document, with section_header + tsvector + embedding
--
-- knowledge_items is kept as a compatibility view so old code doesn't break immediately.

-- ---------------------------------------------------------------------------
-- documents table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id               bigserial     PRIMARY KEY,
  domain           text          NOT NULL,
  doc_type         text          NOT NULL DEFAULT 'document',  -- document | email | report | note | web | spec | guide
  source_path      text          NOT NULL UNIQUE,              -- absolute path or URL (canonical dedup key)
  title            text          NOT NULL,
  summary          text,                                       -- LLM-generated 3-5 sentence summary
  summary_embedding vector(768),                               -- embed of summary for doc-level search
  content_hash     text          NOT NULL,                     -- SHA-256 of raw file content (staleness detection)
  chunk_count      integer       NOT NULL DEFAULT 0,
  metadata         jsonb,
  created_at       timestamptz   NOT NULL DEFAULT NOW(),
  updated_at       timestamptz   NOT NULL DEFAULT NOW()
);

-- HNSW on summary_embedding for fast doc-level semantic search
CREATE INDEX IF NOT EXISTS documents_summary_embedding_idx
  ON documents
  USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE summary_embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_domain_idx ON documents (domain);
CREATE INDEX IF NOT EXISTS documents_doc_type_idx ON documents (doc_type);

-- FTS on title + summary for keyword-based document lookup
CREATE INDEX IF NOT EXISTS documents_fts_idx
  ON documents
  USING gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '')));

COMMENT ON TABLE documents IS
  'First-class document registry. One row per source file. Tracks summary, hash, and doc-level embedding.';

-- ---------------------------------------------------------------------------
-- chunks table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id               bigserial     PRIMARY KEY,
  document_id      bigint        NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  chunk_index      integer       NOT NULL,
  section_header   text,                   -- nearest heading above this chunk (e.g. "## Installation")
  content          text          NOT NULL,
  content_tsv      tsvector      GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding        vector(768),
  created_at       timestamptz   NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);

-- HNSW on chunk embeddings — primary semantic retrieval index
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE embedding IS NOT NULL;

-- GIN for BM25-style full-text search on chunks
CREATE INDEX IF NOT EXISTS chunks_fts_idx
  ON chunks
  USING gin (content_tsv);

-- Fast parent-document lookup (fetch all chunks for a doc)
CREATE INDEX IF NOT EXISTS chunks_document_id_idx ON chunks (document_id, chunk_index);

COMMENT ON TABLE chunks IS
  'Document chunks, children of documents. Stores section_header context, tsvector for keyword search, and vector embedding.';

-- ---------------------------------------------------------------------------
-- Compatibility view — keeps old knowledge_items queries working
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW knowledge_items_v AS
  SELECT
    c.id,
    d.domain,
    d.doc_type            AS source_type,
    d.source_path,
    d.title,
    c.chunk_index,
    c.content,
    d.metadata,
    c.embedding,
    c.created_at
  FROM chunks c
  JOIN documents d ON d.id = c.document_id;

COMMENT ON VIEW knowledge_items_v IS
  'Backward-compatibility view over documents + chunks. Mirrors old knowledge_items columns.';
