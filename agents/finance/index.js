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
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const OLLAMA_HOST  = process.env.OLLAMA_HOST        ?? 'http://localhost:11434'
const EMBED_MODEL  = process.env.OLLAMA_MODEL_EMBED  ?? 'nomic-embed-text'

const { Pool } = pg

let _pool = null
function getPool () {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER     ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max: 3,
    })
  }
  return _pool
}

async function embed (text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  const data = await res.json()
  return data.embeddings?.[0] ?? data.embedding
}

class FinanceAgent extends BaseAgent {
  get name () { return 'finance' }
  get description () { return 'Financial analysis — deals, budgets, pipeline from the knowledge base' }

  get tools () {
    return [
      {
        name: 'query_deals',
        description: 'Get active deal information from the user context profile.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Optional keyword to filter deals by name or stage' },
          },
        },
      },
      {
        name: 'search_financials',
        description: 'Semantic search within the finance domain of the knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language query about financial topics' },
            k:     { type: 'integer', description: 'Number of results (default 5)' },
          },
          required: ['query'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'query_deals':       return this._queryDeals(args)
      case 'search_financials': return this._searchFinancials(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _queryDeals ({ filter } = {}) {
    this.log(`query_deals filter=${filter ?? 'none'}`)

    // active_deals are passed through context in real calls, but we can also
    // query from pgvector if documents have been ingested
    const pool = getPool()

    let sql = `
      SELECT title, content, source_path, 1 - (embedding <=> $1::vector) AS score
      FROM knowledge_items
      WHERE domain = 'finance'
      ORDER BY created_at DESC
      LIMIT 10
    `

    // Fallback: just return the most recent finance documents if no embedding
    try {
      const { rows } = await pool.query(`
        SELECT title, content, source_path, metadata, created_at
        FROM knowledge_items
        WHERE domain = 'finance'
        ${filter ? `AND (title ILIKE $1 OR content ILIKE $1)` : ''}
        ORDER BY created_at DESC
        LIMIT 10
      `, filter ? [`%${filter}%`] : [])

      return JSON.stringify({ deals: rows, count: rows.length })
    } catch {
      return JSON.stringify({ deals: [], message: 'No finance documents ingested yet. Use scripts/ingest.js to add documents.' })
    }
  }

  async _searchFinancials ({ query, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k), 20)

    this.log(`search_financials: "${query.slice(0, 60)}" k=${k}`)

    const embedding = await embed(query)
    const pool = getPool()
    const vectorStr = `[${embedding.join(',')}]`

    try {
      const { rows } = await pool.query(`
        SELECT title, content, source_path,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        WHERE domain = 'finance'
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vectorStr, k])

      return JSON.stringify({ results: rows.map(r => ({ ...r, score: parseFloat(r.score).toFixed(3) })) })
    } catch {
      return JSON.stringify({ results: [], message: 'No finance documents ingested yet.' })
    }
  }
}

if (process.env.AMPHION_AGENT === 'finance' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new FinanceAgent().run()
}
