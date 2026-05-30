/**
 * agents/finance/index.js — Finance Agent
 *
 * Handles financial queries: deal valuations, budget lookups, pipeline status.
 * Searches the knowledge base (domain=finance) and the user_context active_deals.
 *
 * MCP Tools:
 *   query_deals       — lookup active deals from user context + knowledge base
 *   search_financials — semantic search scoped to finance domain
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { BaseAgent } from '../_base/index.js'
import { initDb, getUserContext } from '../../apps/broker/src/db.js'
import {
  searchResourceChunks,
  searchResourceSummaries,
} from '../_shared/resource-retrieval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

class FinanceAgent extends BaseAgent {
  get name () { return 'finance' }
  get description () { return 'Financial analysis — deals, budgets, pipeline from the knowledge base' }

  get tools () {
    return [
      {
        name: 'search_documents',
        description: 'Start here — broad probe across ingested finance documents. Finds which documents cover this topic using semantic similarity on summaries and keyword matching on titles. Zero results means no finance documents have been ingested yet.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string',  description: 'Natural language query about financial topics' },
            k:     { type: 'integer', description: 'Number of documents (default 5, max 15)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_hybrid',
        description: 'Go deeper — chunk-level hybrid search (semantic + BM25 via RRF) across ingested finance documents. Use for precise factual questions or after search_documents identifies what is relevant. Searches the indexed finance knowledge base only.',
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
        name: 'query_deals',
        description: 'Get current active deals and pipeline status from the user profile. Use for "what deals are active", "pipeline status", "current opportunities". Reads live profile data — does not search the knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional keyword to filter deals by name or stage' },
          },
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_documents': return this._searchDocuments(args)
      case 'search_hybrid':    return this._searchHybrid(args)
      case 'query_deals':      return this._queryDeals(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _searchDocuments ({ query, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 5), 15)
    this.log(`search_documents: "${query.slice(0, 60)}" k=${k}`)
    const merged = await searchResourceSummaries({ query, corpus: 'finance', k })
    if (!merged.length) return JSON.stringify({ documents: [], message: 'No finance documents found. Ingest finance documents to populate this domain.' })
    return JSON.stringify({
      documents: merged.map(r => ({
        doc_id:      r.doc_id,
        resource_id: r.resource_id,
        title:       r.title,
        domain:      r.domain,
        corpus:      r.corpus,
        doc_type:    r.doc_type,
        chunk_count: r.chunk_count,
        rrf_score:   r.rrf_score,
        summary:     r.summary ?? '(no summary)',
        source_path: r.source_path,
        metadata:    r.metadata,
      })),
    })
  }

  async _searchHybrid ({ query, k = 6, neighbors = true }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 6), 20)
    this.log(`search_hybrid: "${query.slice(0, 60)}" k=${k}`)
    const results = await searchResourceChunks({ query, corpus: 'finance', k, neighbors })
    if (!results.length) return JSON.stringify({ chunks: [], message: 'No finance content matched. Try search_documents to confirm what is available.' })
    return JSON.stringify({ chunks: results })
  }

  async _queryDeals ({ filter } = {}) {
    this.log(`query_deals filter=${filter ?? 'none'}`)
    try {
      await initDb()
      let deals = getUserContext().activeDeals ?? []
      if (filter) {
        const f = filter.toLowerCase()
        deals = deals.filter(d => JSON.stringify(d).toLowerCase().includes(f))
      }
      if (!deals.length) {
        const docs = await searchResourceSummaries({
          query: filter?.trim() ? filter : 'active deals pipeline budget finance',
          corpus: 'finance',
          k: 10,
        })
        return JSON.stringify({
          deals: docs.map(doc => ({
            resource_id: doc.resource_id,
            doc_id:      doc.doc_id,
            title:       doc.title,
            summary:     doc.summary,
            source_path: doc.source_path,
            metadata:    doc.metadata,
            created_at:  doc.created_at,
          })),
          source: 'resources',
          count: docs.length,
        })
      }
      return JSON.stringify({ deals, source: 'user_context', count: deals.length })
    } catch (err) {
      return JSON.stringify({ deals: [], error: err.message })
    }
  }
}

if (process.env.AMPHION_AGENT === 'finance' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new FinanceAgent().run()
}
