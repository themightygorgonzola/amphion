/**
 * agents/research/index.js — Research Agent
 *
 * Performs semantic search over the knowledge_items table in pgvector.
 * Embeds the query via Ollama nomic-embed-text → cosine similarity search.
 *
 * MCP Tools exposed:
 *   search_knowledge  — semantic search over stored documents
 *   list_domains      — list all domains that have indexed content
 */

import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const OLLAMA_HOST  = process.env.OLLAMA_HOST        ?? 'http://localhost:11434'
const EMBED_MODEL  = process.env.OLLAMA_MODEL_EMBED  ?? 'nomic-embed-text'
const PGHOST       = process.env.PGHOST              ?? 'localhost'
const PGPORT       = parseInt(process.env.PGPORT     ?? '5432', 10)
const PGDATABASE   = process.env.PGDATABASE          ?? 'amphion'
const PGUSER       = process.env.PGUSER              ?? 'amphion'
const PGPASSWORD   = process.env.PGPASSWORD          ?? 'changeme'

const { Pool } = pg

let _pool = null
function getPool () {
  if (!_pool) {
    _pool = new Pool({ host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD, max: 3 })
    _pool.on('error', err => process.stderr.write(`[research] pg error: ${err.message}\n`))
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
  // Ollama returns embeddings or embedding depending on version
  return data.embeddings?.[0] ?? data.embedding
}

class ResearchAgent extends BaseAgent {
  get name () { return 'research' }
  get description () { return 'Semantic search over the Amphion knowledge base using pgvector' }

  get tools () {
    return [
      {
        name: 'search_knowledge',
        description: 'Search the knowledge base for documents relevant to a query. Returns the most semantically similar chunks.',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string',  description: 'Natural language search query' },
            domain: { type: 'string',  description: 'Domain filter (research, finance, legal, comms, proposals). Omit to search all.' },
            k:      { type: 'integer', description: 'Number of results to return (default 5, max 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'list_domains',
        description: 'List all domains that have indexed content in the knowledge base, with item counts.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_knowledge': return this._searchKnowledge(args)
      case 'list_domains':     return this._listDomains()
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _searchKnowledge ({ query, domain, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k), 20)

    this.log(`search: "${query.slice(0, 60)}" domain=${domain ?? 'all'} k=${k}`)

    const embedding = await embed(query)
    const pool = getPool()
    const vectorStr = `[${embedding.join(',')}]`

    let sql, params
    if (domain) {
      sql = `
        SELECT title, content, source_path, domain, chunk_index,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        WHERE domain = $2
        ORDER BY embedding <=> $1::vector
        LIMIT $3
      `
      params = [vectorStr, domain, k]
    } else {
      sql = `
        SELECT title, content, source_path, domain, chunk_index,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `
      params = [vectorStr, k]
    }

    const { rows } = await pool.query(sql, params)

    if (rows.length === 0) {
      return JSON.stringify({ results: [], message: 'No documents found. The knowledge base may be empty.' })
    }

    return JSON.stringify({
      results: rows.map(r => ({
        title:      r.title,
        domain:     r.domain,
        score:      parseFloat(r.score).toFixed(3),
        source:     r.source_path,
        chunk:      r.chunk_index,
        content:    r.content,
      })),
    })
  }

  async _listDomains () {
    const pool = getPool()
    const { rows } = await pool.query(`
      SELECT domain, COUNT(*) AS chunks, COUNT(DISTINCT source_path) AS documents
      FROM knowledge_items
      GROUP BY domain
      ORDER BY domain
    `)
    return JSON.stringify({ domains: rows })
  }
}

// Load .env if running as standalone process (not via broker import)
if (process.env.AMPHION_AGENT === 'research' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new ResearchAgent().run()
}
