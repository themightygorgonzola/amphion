/**
 * ingest.js — Document ingestion pipeline
 *
 * Takes a file path (or directory), parses it, chunks the text,
 * embeds each chunk via Ollama, and stores it in pgvector.
 *
 * Usage:
 *   node scripts/ingest.js --file ./docs/contract.pdf --domain legal
 *   node scripts/ingest.js --dir ./docs/proposals/ --domain proposals
 *
 * TODO (next session):
 *   - [ ] PDF parsing (pdf-parse)
 *   - [ ] DOCX parsing (mammoth)
 *   - [ ] Spreadsheet parsing (xlsx)
 *   - [ ] Text chunking with overlap
 *   - [ ] Ollama embed call (nomic-embed-text)
 *   - [ ] pgvector INSERT with domain tag
 *   - [ ] Deduplication by hash(source_path + chunk_index)
 */

console.log('[ingest] stub — not yet implemented')
