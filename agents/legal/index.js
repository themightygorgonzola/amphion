/**
 * agents/legal/index.js — Legal Agent
 *
 * Searches the knowledge base (domain=legal) for statutes, regulations, RCW citations,
 * contracts, compliance docs. Uses the same two-tier hybrid retrieval as the research agent.
 *
 * MCP Tools:
 *   search_statutes  — hybrid chunk-level search: semantic + BM25 keyword (RRF merged)
 *   get_chapter      — fetch a full RCW chapter by title keyword or document ID
 *   review_contract  — legacy alias → search_statutes
 *   flag_risks       — legacy alias → search_statutes with risk framing
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { BaseAgent } from '../_base/index.js'
import {
  formatChunkRow,
  getResourcePool,
  loadResourceRecord,
  searchResourceChunks,
} from '../_shared/resource-retrieval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class LegalAgent extends BaseAgent {
  constructor () {
    super()
    this.domain = 'legal'
  }

  get name () { return this.domain }

  get description () {
    return this.domain === 'legal'
      ? 'Washington state statutes (RCW), contracts, compliance, and legal document search'
      : `Statute corpus agent for domain: ${this.domain}`
  }

  get tools () {
    return [
      {
        name: 'search_statutes',
        description: 'Hybrid search over the legal knowledge base using both semantic similarity and keyword matching (RRF merged). Searches Washington state RCW statutes, regulations, and legal documents. Use this for any question about what the law says.',
        inputSchema: {
          type: 'object',
          properties: {
            query:     { type: 'string',  description: 'Natural language legal question or RCW citation (e.g. "RCW 9A.36.011" or "assault first degree")' },
            k:         { type: 'integer', description: 'Number of chunks to return (default 8, max 20)' },
            neighbors: { type: 'boolean', description: 'Include neighboring statute chunks for context (default true)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_section',
        description: 'Retrieve specific statute sections by exact RCW section number or title. Use when the user asks for a specific RCW section. Pass the chapter number as title (e.g. "46.63") and the full section number as section_header (e.g. "46.63.220"). Returns matching chunks in order.',
        inputSchema: {
          type: 'object',
          properties: {
            title:          { type: 'string',  description: 'Chapter number only, e.g. "46.63" or "9A.36" — NOT the full section number' },
            section_header: { type: 'string',  description: 'Full section number to match, e.g. "46.63.220" or "9A.36.011"' },
            k:              { type: 'integer', description: 'Max chunks to return (default 20)' },
          },
        },
      },
      {
        name: 'get_chapter',
        description: 'Retrieve a full RCW chapter by document ID or title keyword. Returns all statute sections in order. Use when you need the complete text of a chapter.',
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'integer', description: 'Exact document ID' },
            title:       { type: 'string',  description: 'Chapter title keyword, e.g. "9A.36" or "ASSAULT" or "landlord tenant"' },
          },
        },
      },
      // Legacy aliases
      {
        name: 'review_contract',
        description: 'Find relevant legal documents for a topic (alias for search_statutes).',
        inputSchema: { type: 'object', properties: { topic: { type: 'string' }, k: { type: 'integer' } }, required: ['topic'] },
      },
      {
        name: 'flag_risks',
        description: 'Surface legal risk documentation for a situation (alias for search_statutes).',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_statutes': return this._searchStatutes(args)
      case 'get_section':     return this._getSection(args)
      case 'get_chapter':     return this._getChapter(args)
      case 'review_contract': return this._searchStatutes({ query: args.topic, k: args.k })
      case 'flag_risks':      return this._searchStatutes({ query: `legal risk: ${args.description}` })
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  // ---------------------------------------------------------------------------
  // Hybrid chunk search — semantic + BM25 RRF, scoped to this.domain
  // ---------------------------------------------------------------------------
  async _searchStatutes ({ query, k = 8, neighbors = true }) {
    k = Math.min(Math.max(1, k ?? 8), 20)
    this.log(`search_statutes(${this.domain}): "${query.slice(0, 80)}" k=${k}`)

    const merged = await searchResourceChunks({ query, corpus: this.domain, k, neighbors })

    if (!merged.length) {
      return JSON.stringify({ results: [], message: `No matching content found in ${this.domain}. The relevant statute title may not be ingested yet.` })
    }

    return JSON.stringify({
      results: merged.map(r => ({
        doc_id:         r.doc_id,
        resource_id:    r.resource_id,
        chunk_id:       r.chunk_id,
        chunk_index:    r.chunk_index,
        title:          r.title,
        domain:         r.domain,
        corpus:         r.corpus,
        section_header: r.section_header ?? null,
        rrf_score:      r.rrf_score,
        is_neighbor:    r.is_neighbor ?? false,
        content:        r.content,
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // get_section — exact match by title + optional section header
  // Returns results in the same { results: [...] } format as search_statutes
  // ---------------------------------------------------------------------------
  async _getSection ({ title, section_header, k = 20 }) {
    k = Math.min(Math.max(1, k ?? 20), 50)
    const pool = getResourcePool()

    // Smart parsing: if title looks like a full RCW citation (e.g. "RCW 46.63.220" or "46.63.220"),
    // extract the chapter part as title and the section part as section_header
    let effectiveTitle         = title
    let effectiveSectionHeader = section_header
    if (title && !section_header) {
      const sectionMatch = title.match(/(\d+[A-Z]?\.\d+\.\d+[A-Z]?)/i)
      if (sectionMatch) {
        effectiveSectionHeader = sectionMatch[1]
        // Derive chapter from first two parts: "46.63.220" → "46.63"
        const parts = sectionMatch[1].split('.')
        effectiveTitle = parts.slice(0, 2).join('.')
      }
    }

    // Resolve matching document IDs by chapter title
    let docIds = []
    if (effectiveTitle) {
      const { rows } = await pool.query(
        `SELECT r.id AS resource_id
         FROM resources r
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE (co.slug = $1 OR co.domain = $1) AND r.title ILIKE $2
         ORDER BY r.updated_at DESC`,
        [this.domain, `%${effectiveTitle}%`],
      )
      docIds = rows.map(r => Number(r.resource_id))
    }

    if (docIds.length === 0 && !effectiveSectionHeader) {
      return JSON.stringify({ results: [], reason: 'No matching document found' })
    }

    let rows
    if (docIds.length > 0 && effectiveSectionHeader) {
      ;({ rows } = await pool.query(
        `SELECT c.id AS chunk_id, c.resource_id, c.chunk_index, c.section_header,
                COALESCE(c.section_path, CASE WHEN c.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.section_header] END) AS section_path,
                c.content, c.start_line, c.end_line, c.char_start, c.char_end,
                r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type, r.size_bytes, r.metadata,
                COALESCE(co.slug, co.domain) AS corpus, co.domain,
                NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
                NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
                0::float AS rrf_score, false AS is_neighbor
         FROM chunks c
         JOIN resources r ON r.id = c.resource_id
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE c.resource_id = ANY($1) AND c.section_header ILIKE $2
         ORDER BY c.resource_id, c.chunk_index
         LIMIT $3`,

        [docIds, `%${effectiveSectionHeader}%`, k],
      ))
    } else if (docIds.length > 0) {
      ;({ rows } = await pool.query(
        `SELECT c.id AS chunk_id, c.resource_id, c.chunk_index, c.section_header,
                COALESCE(c.section_path, CASE WHEN c.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.section_header] END) AS section_path,
                c.content, c.start_line, c.end_line, c.char_start, c.char_end,
                r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type, r.size_bytes, r.metadata,
                COALESCE(co.slug, co.domain) AS corpus, co.domain,
                NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
                NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
                0::float AS rrf_score, false AS is_neighbor
         FROM chunks c
         JOIN resources r ON r.id = c.resource_id
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE c.resource_id = ANY($1)
         ORDER BY c.resource_id, c.chunk_index
         LIMIT $2`,

        [docIds, k],
      ))
    } else {
      // section_header only — search across all docs in this corpus
      ;({ rows } = await pool.query(
        `SELECT c.id AS chunk_id, c.resource_id, c.chunk_index, c.section_header,
                COALESCE(c.section_path, CASE WHEN c.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.section_header] END) AS section_path,
                c.content, c.start_line, c.end_line, c.char_start, c.char_end,
                r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type, r.size_bytes, r.metadata,
                COALESCE(co.slug, co.domain) AS corpus, co.domain,
                NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
                NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
                0::float AS rrf_score, false AS is_neighbor
         FROM chunks c
         JOIN resources r ON r.id = c.resource_id
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE (co.slug = $1 OR co.domain = $1) AND c.section_header ILIKE $2
         ORDER BY c.resource_id, c.chunk_index
         LIMIT $3`,

        [this.domain, `%${effectiveSectionHeader}%`, k],
      ))
    }

    this.log(`get_section(${this.domain}): title="${effectiveTitle}" section="${effectiveSectionHeader}" → ${rows.length} chunks`)

    const results = rows.map(formatChunkRow)

    return JSON.stringify({
      results: results.map(r => ({
        chunk_id:       r.chunk_id,
        resource_id:    r.resource_id,
        doc_id:         r.doc_id,
        chunk_index:    r.chunk_index,
        section_header: r.section_header ?? null,
        content:        r.content,
        title:          r.title,
        source_path:    r.source_path ?? null,
        start_line:     r.start_line ?? null,
        end_line:       r.end_line ?? null,
        char_start:     r.char_start ?? null,
        char_end:       r.char_end ?? null,
        rrf_score:      r.rrf_score,
        is_neighbor:    r.is_neighbor,
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // get_chapter — fetch full chapter by document ID or title keyword
  // ---------------------------------------------------------------------------
  async _getChapter ({ document_id, title }) {
    const loaded = await loadResourceRecord({ resourceId: document_id, title, corpus: this.domain })

    if (!loaded) return JSON.stringify({ error: 'Chapter not found', document_id, title })

    const { resource, chunks } = loaded

    this.log(`get_chapter(${this.domain}): id=${resource.resource_id} "${resource.title}" (${chunks.length} chunks)`)

    return JSON.stringify({
      document: {
        id:          resource.resource_id,
        resource_id: resource.resource_id,
        doc_id:      resource.doc_id,
        title:       resource.title,
        chunk_count: resource.chunk_count,
        source_path: resource.source_path,
      },
      chunks: chunks.map(c => ({ chunk_id: c.chunk_id, chunk_index: c.chunk_index, section_header: c.section_header, content: c.content, start_line: c.start_line ?? null, end_line: c.end_line ?? null, char_start: c.char_start ?? null, char_end: c.char_end ?? null })),
    })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new LegalAgent().run()
}
