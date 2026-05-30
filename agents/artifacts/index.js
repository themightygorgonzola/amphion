/**
 * agents/artifacts/index.js — Artifacts Agent
 *
 * Cross-domain file management and knowledge scope awareness.
 * Treats files as first-class citizens independent of their text content.
 *
 * MCP Tools:
 *   search_artifacts  — find files by name, description, tags, corpus, or semantic query
 *   get_artifact_ref  — get metadata + download URL for a specific artifact
 *   probe_knowledge   — lightweight scope check: does the knowledge base contain X?
 *                       Returns title/wordcount/sections WITHOUT content — no cards emitted
 *   list_corpus       — list all artifacts in a named corpus grouping
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { BaseAgent } from '../_base/index.js'
import {
  findResourcesByReference,
  formatResourceRow,
  getResourcePool,
  loadResourceRecord,
  probeCorpusKnowledge,
  searchResourceChunks,
} from '../_shared/resource-retrieval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BROKER_URL  = process.env.BROKER_URL          ?? 'http://127.0.0.1:3000'

function resourceToArtifactRef (resource, chunkCount = null) {
  return {
    artifact_id:  resource.resource_id,
    resource_id:  resource.resource_id,
    document_id:  resource.doc_id ?? null,
    filename:     resource.filename,
    mime_type:    resource.mime_type,
    domain:       resource.domain,
    corpus:       resource.corpus ?? null,
    description:  resource.summary ?? null,
    tags:         resource.metadata?.tags ?? [],
    size_bytes:   resource.size_bytes ?? null,
    title:        resource.title ?? resource.filename,
    summary:      resource.summary ?? null,
    chunk_count:  chunkCount ?? resource.chunk_count ?? null,
    created_at:   resource.created_at,
    download_url: `${BROKER_URL}/artifacts/${resource.resource_id}/${encodeURIComponent(resource.filename)}`,
    result_type:  'artifact_ref',
  }
}

function scopeMatchesDomain (resource, domain) {
  return !domain || resource.domain === domain
}

class ArtifactsAgent extends BaseAgent {
  get name () { return 'artifacts' }
  get description () { return 'File management and knowledge scope awareness across all domains' }

  get tools () {
    return [
      {
        name: 'search_artifacts',
        description: 'Find files by name, description, tags, corpus, or topic. Use when the user asks about a specific file they own or saved, or wants to find documents by name/type.',
        inputSchema: {
          type: 'object',
          properties: {
            query:   { type: 'string', description: 'Search query — filename, topic, or description' },
            corpus:  { type: 'string', description: 'Optional corpus/collection filter e.g. "school-projects", "rcw"' },
            domain:  { type: 'string', description: 'Optional domain filter: research, legal, finance, comms, proposals' },
            k:       { type: 'number', description: 'Max results (default 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_artifact_ref',
        description: 'Get file metadata and a download URL for a specific artifact. Returns the filename, type, size, and a URL the user can use to access the file. Does NOT return file content.',
        inputSchema: {
          type: 'object',
          properties: {
            artifact_id: { type: 'number', description: 'Artifact ID from search_artifacts results' },
          },
          required: ['artifact_id'],
        },
      },
      {
        name: 'probe_knowledge',
        description: 'Quickly check whether the knowledge base contains documents about a topic. Returns document titles, approximate word counts, and section lists. Does NOT return content — use this to inform the user of scope before committing to a full retrieval, or to rebut claims like "there are no laws about X".',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string', description: 'Topic or keyword to check for' },
            domain: { type: 'string', description: 'Optional domain to scope the check: legal, research, etc.' },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_corpus',
        description: 'List all artifacts in a named corpus/collection. If corpus is omitted, lists ALL artifacts across all corpora.',
        inputSchema: {
          type: 'object',
          properties: {
            corpus:  { type: 'string', description: 'Corpus name e.g. "school-projects". Omit to list everything.' },
            domain:  { type: 'string', description: 'Optional domain filter.' },
          },
          required: [],
        },
      },
      {
        name: 'search_content',
        description: 'Search the actual TEXT CONTENT of files in the corpus using hybrid semantic + keyword search. Use this when the user asks what a document says, asks a factual question about topics covered in their files, or wants to recall information from a saved document (e.g. "what was the budget?", "what did the report say about X?", "remind me what the plan was"). Returns relevant excerpts from matching documents.',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string', description: 'Natural language question or topic to search for in file content' },
            corpus: { type: 'string', description: 'Optional corpus name to scope the search' },
            domain: { type: 'string', description: 'Optional domain filter' },
            k:      { type: 'number', description: 'Max chunks to return (default 6)' },
          },
          required: ['query'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_artifacts':  return this._searchArtifacts(args)
      case 'get_artifact_ref':  return this._getArtifactRef(args)
      case 'probe_knowledge':   return this._probeKnowledge(args)
      case 'list_corpus':       return this._listCorpus(args)
      case 'list_all':          return this._listCorpus(args)
      case 'search_content':    return this._searchContent(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  // ---------------------------------------------------------------------------
  // search_artifacts — semantic + filename text search
  // ---------------------------------------------------------------------------
  async _searchArtifacts ({ query, corpus, domain, k = 10 }) {
    k = Math.min(Math.max(1, k ?? 10), 50)
    const results = (await findResourcesByReference({ query, corpus: corpus ?? domain ?? null, k }))
      .filter(resource => scopeMatchesDomain(resource, domain))

    this.log(`search_artifacts: "${query}" → ${results.length} result(s)`)

    return JSON.stringify({
      results: results.map(resource => resourceToArtifactRef(resource)),
    })
  }

  // ---------------------------------------------------------------------------
  // get_artifact_ref — returns metadata + download URL, no content
  // ---------------------------------------------------------------------------
  async _getArtifactRef ({ artifact_id }) {
    const loaded = await loadResourceRecord({ resourceId: artifact_id })

    if (!loaded) {
      return JSON.stringify({ error: `Artifact ${artifact_id} not found` })
    }
    const { resource, chunks } = loaded
    this.log(`get_artifact_ref: id=${artifact_id} "${resource.filename}"`)

    return JSON.stringify(resourceToArtifactRef(resource, chunks.length))
  }

  // ---------------------------------------------------------------------------
  // probe_knowledge — scope check, returns metadata only, NO chunk content
  // ---------------------------------------------------------------------------
  async _probeKnowledge ({ query, domain }) {
    const rows = (await probeCorpusKnowledge({ query, corpus: domain ?? null, k: 10 }))
      .filter(resource => scopeMatchesDomain(resource, domain))

    this.log(`probe_knowledge: "${query}" domain=${domain ?? 'all'} → ${rows.length} document(s)`)

    if (rows.length === 0) {
      return JSON.stringify({
        found: false,
        query,
        domain: domain ?? null,
        documents: [],
        result_type: 'probe',
      })
    }

    return JSON.stringify({
      found: true,
      query,
      domain: domain ?? null,
      result_type: 'probe',
      documents: rows.map(r => ({
        document_id:   r.doc_id,
        resource_id:   r.resource_id,
        title:         r.title,
        domain:        r.domain,
        chunk_count:   r.chunk_count,
        section_count: Number(r.section_count ?? 0),
        approx_words:  Math.round(Number(r.total_chars ?? 0) / 5),  // ~5 chars/word
        sections:      (r.sections ?? []).filter(Boolean).slice(0, 30),
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // list_corpus — all artifacts in a collection, or everything if corpus omitted
  // ---------------------------------------------------------------------------
  async _listCorpus ({ corpus, domain } = {}) {
    const pool = getResourcePool()

    const params = []
    const filters = []
    if (corpus) {
      params.push(corpus)
      filters.push(`(co.slug = $${params.length} OR co.domain = $${params.length})`)
    }
    if (domain) {
      params.push(domain)
      filters.push(`co.domain = $${params.length}`)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''

    const { rows } = await pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             r.type AS resource_type,
             r.summary,
             r.source_ref,
             r.stored_path,
             r.mime_type,
             r.size_bytes,
             r.metadata,
             r.created_at,
             r.updated_at,
             COALESCE(co.slug, co.domain) AS corpus,
             co.domain,
             COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
             NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
             NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS chunk_count
        FROM chunks ch
        WHERE ch.resource_id = r.id
      ) chunk_counts ON TRUE
      ${where}
      ORDER BY co.domain NULLS LAST, COALESCE(co.slug, co.domain) NULLS LAST, r.created_at DESC
      LIMIT 100
    `, params)

    const artifacts = rows.map(formatResourceRow)

    const label = corpus ? `"${corpus}"` : domain ? `domain=${domain}` : 'ALL'
    this.log(`list_corpus: ${label} → ${artifacts.length} artifact(s)`)

    return JSON.stringify({
      corpus:      corpus ?? null,
      count:       artifacts.length,
      result_type: 'artifact_list',
      artifacts: artifacts.map(resource => resourceToArtifactRef(resource)),
    })
  }

  // ---------------------------------------------------------------------------
  // search_content — hybrid chunk search scoped to artifact-backed documents
  // Lets the agent answer factual/content questions from saved files without
  // requiring perfect upstream routing.
  // ---------------------------------------------------------------------------
  async _searchContent ({ query, corpus, domain, k = 6 }) {
    k = Math.min(Math.max(1, k ?? 6), 20)
    const merged = (await searchResourceChunks({ query, corpus: corpus ?? domain ?? null, k, neighbors: false }))
      .filter(resource => scopeMatchesDomain(resource, domain))

    this.log(`search_content: "${query}" corpus=${corpus ?? 'all'} → ${merged.length} chunk(s)`)

    return JSON.stringify({
      results: merged.map(r => ({
        chunk_id:       r.chunk_id,
        document_id:    r.doc_id,
        resource_id:    r.resource_id,
        content:        r.content,
        section_header: r.section_header ?? null,
        chunk_index:    r.chunk_index,
        title:          r.title ?? r.filename,
        source_path:    r.source_path ?? null,
        char_start:     r.char_start ?? null,
        char_end:       r.char_end ?? null,
        rrf_score:      r.rrf_score,
        is_neighbor:    r.is_neighbor,
      })),
    })
  }
}

if (process.env.AMPHION_AGENT === 'artifacts' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new ArtifactsAgent().run()
}
