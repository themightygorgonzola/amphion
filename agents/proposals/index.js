/**
 * agents/proposals/index.js — Proposals Agent
 *
 * Assists with business proposals: finding past wins, surfacing relevant templates,
 * and generating proposal outlines based on the knowledge base.
 *
 * MCP Tools:
 *   find_similar_proposals — semantic search for past proposals matching a description
 *   get_win_rate           — summary stats on proposal outcomes from indexed docs
 *   outline_proposal       — generate a proposal outline for a given opportunity
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { BaseAgent } from '../_base/index.js'
import { getResourcePool, searchResourceChunks, searchResourceSummaries } from '../_shared/resource-retrieval.js'

const OLLAMA_HOST      = process.env.OLLAMA_HOST            ?? 'http://localhost:11434'
const DISPATCHER_MODEL = process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b'

async function callLLM (systemPrompt, userMessage) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DISPATCHER_MODEL,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
    }),
  })
  const data = await res.json()
  return data.message?.content ?? ''
}

class ProposalsAgent extends BaseAgent {
  get name () { return 'proposals' }
  get description () { return 'Proposal search, win-rate analysis, and proposal outline generation' }

  get tools () {
    return [
      {
        name: 'search_documents',
        description: 'Start here — broad probe across ingested proposals documents. Finds which proposals are relevant to a description using semantic similarity on summaries and keyword matching. Zero results means no proposals have been ingested yet.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string',  description: 'Description of the opportunity or topic to search for in past proposals' },
            k:     { type: 'integer', description: 'Number of documents (default 5, max 15)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_hybrid',
        description: 'Go deeper — chunk-level hybrid search (semantic + BM25 via RRF) across ingested proposals. Use for precise content retrieval from past proposals or after search_documents identifies what is relevant.',
        inputSchema: {
          type: 'object',
          properties: {
            query:     { type: 'string',  description: 'Natural language search query' },
            k:         { type: 'integer', description: 'Number of chunks (default 6, max 20)' },
            neighbors: { type: 'boolean', description: 'Include neighboring chunks for context (default true)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_win_rate',
        description: 'Get win/loss statistics and outcomes for past proposals in the knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional: filter by industry, client type, or deal size' },
          },
        },
      },
      {
        name: 'outline_proposal',
        description: 'Generate a structured proposal outline for a given opportunity using past wins as reference.',
        inputSchema: {
          type: 'object',
          properties: {
            opportunity: { type: 'string', description: 'Description of the opportunity or RFP' },
            client:      { type: 'string', description: 'Client name or sector' },
            value:       { type: 'string', description: 'Estimated deal value or size (e.g. "$500K")' },
            context:     { type: 'string', description: 'Optional supporting resource context gathered before drafting' },
          },
          required: ['opportunity'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_documents':       return this._searchDocuments(args)
      case 'search_hybrid':          return this._searchHybrid(args)
      case 'get_win_rate':           return this._getWinRate(args)
      case 'outline_proposal':       return this._outlineProposal(args)
      // legacy alias
      case 'find_similar_proposals': return this._searchDocuments({ query: args.description, k: args.k })
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _searchDocuments ({ query, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 5), 15)
    this.log(`search_documents: "${query.slice(0, 60)}" k=${k}`)
    const merged = await searchResourceSummaries({ query, corpus: 'proposals', k })
    if (!merged.length) return JSON.stringify({ documents: [], message: 'No proposals found. Ingest proposal documents to populate this domain.' })
    return JSON.stringify({
      documents: merged.map(r => ({
        doc_id:      r.doc_id,
        resource_id: r.resource_id,
        title:       r.title,
        doc_type:    r.doc_type,
        chunk_count: r.chunk_count,
        rrf_score:   r.rrf_score,
        summary:     r.summary ?? '(no summary)',
        metadata:    r.metadata,
      })),
    })
  }

  async _searchHybrid ({ query, k = 6, neighbors = true }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 6), 20)
    this.log(`search_hybrid: "${query.slice(0, 60)}" k=${k}`)
    const merged = await searchResourceChunks({ query, corpus: 'proposals', k, neighbors })
    if (!merged.length) return JSON.stringify({ chunks: [], message: 'No proposals content matched. Try search_documents to confirm what is available.' })
    return JSON.stringify({
      chunks: merged.map(r => ({
        chunk_id:       r.chunk_id,
        resource_id:    r.resource_id,
        doc_id:         r.doc_id,
        title:          r.title,
        section_header: r.section_header,
        content:        r.content,
        rrf_score:      r.rrf_score,
        is_neighbor:    r.is_neighbor,
      })),
    })
  }

  async _getWinRate ({ filter } = {}) {
    this.log(`get_win_rate filter=${filter ?? 'none'}`)
    const pool = getResourcePool()
    try {
      const params = []
      const filters = [`(co.slug = 'proposals' OR co.domain = 'proposals')`]
      if (filter) {
        params.push(`%${filter}%`)
        filters.push(`(r.title ILIKE $1 OR coalesce(r.summary, '') ILIKE $1)`)
      }
      const { rows } = await pool.query(`
        SELECT r.title, r.metadata, r.created_at
        FROM resources r
        LEFT JOIN corpora co ON co.id = r.corpus_id
        WHERE ${filters.join(' AND ')}
        ORDER BY r.created_at DESC
        LIMIT 100
      `, params)
      const total = rows.length
      const won = rows.filter(r => {
        const m = r.metadata
        return m && (m.outcome === 'won' || m.status === 'won')
      }).length
      return JSON.stringify({
        total, won, lost: total - won,
        win_rate: total > 0 ? `${Math.round((won / total) * 100)}%` : 'N/A',
        note: total === 0 ? 'No proposals found. Ingest proposal documents to see win rate analytics.' : undefined,
      })
    } catch (err) {
      return JSON.stringify({ error: err.message })
    }
  }

  async _outlineProposal ({ opportunity, client = 'the client', value = 'TBD', context = '' }) {
    if (!opportunity?.trim()) throw new Error('opportunity is required')
    this.log(`outline_proposal: "${opportunity.slice(0, 60)}"`)

    const hasContext = `${context ?? ''}`.trim().length > 0

    const systemPrompt = `You are a business development specialist who writes winning proposals.
Generate a clear, structured proposal outline. Use markdown headers.
  Be specific — include section names, key points to address, and suggested angles.
  Use ONLY facts explicitly provided in the request or supporting context.
  Do NOT invent statutes, procurement rules, client requirements, technical facts, or commitments that were not supplied.
  If specifics are missing, keep the outline generic and mark open questions clearly.`

    const userMessage = `Create a proposal outline for this opportunity:
Opportunity: ${opportunity}
Client: ${client}
Estimated value: ${value}
  ${hasContext ? `Supporting context:\n${context}\n` : 'Supporting context: none provided. Keep the outline generic and do not invent specifics.\n'}

Produce a complete proposal outline with sections and key points for each.`

    const outline = await callLLM(systemPrompt, userMessage)
    return JSON.stringify({ outline, opportunity, client, value })
  }
}

if (process.env.AMPHION_AGENT === 'proposals' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new ProposalsAgent().run()
}
