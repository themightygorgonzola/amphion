-- 001_create_knowledge_items.sql
-- Long-term memory: document chunks + their vector embeddings.
-- This is the RAG table. Every domain agent reads from and writes to this table,
-- filtered by the `domain` column so agents only see their own data.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS knowledge_items (
  id           bigserial      PRIMARY KEY,
  domain       text           NOT NULL,      -- 'research' | 'finance' | 'legal' | 'comms' | 'proposals'
  source_type  text,                         -- 'document' | 'email' | 'report' | 'note' | 'web'
  source_path  text,                         -- original file path or URL
  title        text,
  chunk_index  integer        NOT NULL DEFAULT 0,  -- which chunk of the source doc
  content      text           NOT NULL,
  metadata     jsonb,                        -- any extra structured data (date, author, tags, etc.)
  embedding    vector(768),                  -- nomic-embed-text dimensions
  created_at   timestamptz    NOT NULL DEFAULT NOW(),
  -- Dedup: same source + same chunk = same row. Re-ingest is idempotent.
  UNIQUE (source_path, chunk_index)
);

-- HNSW index for cosine similarity search — production-ready out of the box
CREATE INDEX IF NOT EXISTS knowledge_items_embedding_idx
  ON knowledge_items
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Fast domain-scoped queries (each agent filters by domain before vector search)
CREATE INDEX IF NOT EXISTS knowledge_items_domain_idx
  ON knowledge_items (domain);

-- Full-text search index for hybrid search (vector + keyword)
CREATE INDEX IF NOT EXISTS knowledge_items_fts_idx
  ON knowledge_items
  USING gin (to_tsvector('english', content));

COMMENT ON TABLE knowledge_items IS
  'Document chunks with embeddings. Domain-scoped RAG source for all agents.';
