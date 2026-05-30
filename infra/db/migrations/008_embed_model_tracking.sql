-- 008_embed_model_tracking.sql
-- Stamps every chunk and document summary with the embedding model name used
-- to produce its vector.
--
-- Why: if OLLAMA_MODEL_EMBED changes (e.g. nomic-embed-text → mxbai-embed-large),
-- query vectors and stored vectors are in incompatible spaces. Semantic search
-- silently degrades with no error. This column makes the staleness detectable:
--
--   SELECT DISTINCT embed_model FROM chunks;   -- should always be exactly one value
--
-- scripts/reembed.js queries `WHERE embed_model != $currentModel` to find stale
-- rows and re-embeds them, then updates this column.
--
-- Default matches the current hardcoded default across all agents so existing
-- rows are treated as current until a model change is made.

ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS embed_model text NOT NULL DEFAULT 'nomic-embed-text';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS embed_model text NOT NULL DEFAULT 'nomic-embed-text';

-- Index so reembed.js can find stale rows efficiently
CREATE INDEX IF NOT EXISTS chunks_embed_model_idx
  ON chunks (embed_model);

CREATE INDEX IF NOT EXISTS documents_embed_model_idx
  ON documents (embed_model);

COMMENT ON COLUMN chunks.embed_model IS
  'Ollama model used to generate the embedding. Must match OLLAMA_MODEL_EMBED at query time.';

COMMENT ON COLUMN documents.embed_model IS
  'Ollama model used to generate summary_embedding. Must match OLLAMA_MODEL_EMBED at query time.';
