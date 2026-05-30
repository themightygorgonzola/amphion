-- 011_resource_write_path.sql
--
-- Make resources the canonical parent for new ingest writes.

ALTER TABLE chunks
  ALTER COLUMN document_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chunks_resource_chunk_unique_idx
  ON chunks (resource_id, chunk_index)
  WHERE resource_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'chunks'::regclass
      AND conname = 'chunks_parent_ref_ck'
  ) THEN
    ALTER TABLE chunks
      ADD CONSTRAINT chunks_parent_ref_ck
      CHECK (resource_id IS NOT NULL OR document_id IS NOT NULL);
  END IF;
END $$;

UPDATE chunks ch
SET resource_id = r.id
FROM documents d
JOIN corpora c ON c.domain = d.domain
JOIN resources r ON r.corpus_id = c.id AND r.source_ref = d.source_path
WHERE ch.document_id = d.id
  AND ch.resource_id IS NULL;

COMMENT ON COLUMN chunks.document_id IS
  'Legacy compatibility parent. Resource-native ingest may leave this NULL.';

COMMENT ON COLUMN chunks.resource_id IS
  'Canonical parent resource for resource-native ingest and retrieval.';