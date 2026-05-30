/**
 * agents/_archetypes/documents-agent.js — Parameterized Documents Agent
 *
 * Thin adapter over the canonical resource-backed research agent. This keeps
 * new document-style corpora on the shared resource retrieval path instead of
 * carrying a second legacy SQL implementation.
 */

import { fileURLToPath } from 'url'
import { ResearchAgent } from '../research/index.js'

export class DocumentsAgent extends ResearchAgent {
  constructor () {
    super()
    this.domain = process.env.AMPHION_AGENT ?? 'research'
  }

  get name () { return this.domain }
  get description () { return `Document search agent for corpus: ${this.domain}` }

  get tools () {
    return [
      {
        name: 'search_documents',
        description: `Document-level search over the ${this.domain} corpus. Finds which resources are relevant to a topic via semantic and keyword matching on summaries.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            k: { type: 'integer', description: 'Number of documents to return (default 5, max 15)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_hybrid',
        description: `Hybrid chunk-level search over the ${this.domain} corpus combining semantic similarity and keyword matching. Returns excerpts with section context.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            k: { type: 'integer', description: 'Number of final chunks to return (default 6, max 20)' },
            neighbors: { type: 'boolean', description: 'Include neighboring chunks for context (default true)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_document',
        description: `Retrieve a full resource from the ${this.domain} corpus by its ID or by title keyword. Returns all chunks in order with section headers.`,
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'integer', description: 'Exact resource ID (use if known)' },
            title: { type: 'string', description: 'Title keyword to match (case-insensitive, partial match)' },
          },
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_documents': return this._searchDocuments(args)
      case 'search_hybrid': return this._searchHybrid(args)
      case 'get_document': return this._getDocument(args)
      case 'search_knowledge': return this._searchHybrid({ query: args.query, k: args.k })
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _searchDocuments ({ query, k = 5 }) {
    return await super._searchDocuments({ query, domain: this.domain, k })
  }

  async _searchHybrid ({ query, k = 6, neighbors = true }) {
    return await super._searchHybrid({ query, domain: this.domain, k, neighbors })
  }

  async _getDocument ({ document_id, title }) {
    return await super._getDocument({ document_id, title, domain: this.domain })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await import('dotenv/config') } catch {}
  new DocumentsAgent().run()
}
