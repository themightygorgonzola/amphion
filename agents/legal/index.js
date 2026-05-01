/**
 * agents/legal/index.js — Legal Agent
 *
 * Reviews contracts, flags compliance issues, surfaces relevant legal precedents.
 * Searches the knowledge base (domain=legal) for relevant clauses, NDAs, templates.
 *
 * MCP Tools:
 *   review_contract  — surface relevant legal docs for a given topic/question
 *   flag_risks       — identify potential legal risks from a description
 */

import path from 'path'
import { fileURLToPath } from 'url'
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'

const OLLAMA_HOST = process.env.OLLAMA_HOST       ?? 'http://localhost:11434'
const EMBED_MODEL = process.env.OLLAMA_MODEL_EMBED ?? 'nomic-embed-text'

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

class LegalAgent extends BaseAgent {
  get name () { return 'legal' }
  get description () { return 'Contract review, compliance checks, and legal document search' }

  get tools () {
    return [
      {
        name: 'review_contract',
        description: 'Find relevant legal documents, clauses, and precedents from the knowledge base for a given legal topic or question.',
        inputSchema: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: 'The legal topic, contract type, or question to research' },
            k:     { type: 'integer', description: 'Number of relevant documents to surface (default 5)' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'flag_risks',
        description: 'Given a description of a situation or deal, surface any related legal risk documentation from the knowledge base.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Description of the deal, agreement, or situation to check for risks' },
          },
          required: ['description'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'review_contract': return this._reviewContract(args)
      case 'flag_risks':      return this._flagRisks(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _reviewContract ({ topic, k = 5 }) {
    if (!topic?.trim()) throw new Error('topic is required')
    k = Math.min(Math.max(1, k), 20)
    this.log(`review_contract: "${topic.slice(0, 60)}"`)
    return this._semanticSearch(topic, k)
  }

  async _flagRisks ({ description }) {
    if (!description?.trim()) throw new Error('description is required')
    this.log(`flag_risks: "${description.slice(0, 60)}"`)
    // Search with risk-framing
    return this._semanticSearch(`legal risk compliance issue: ${description}`, 5)
  }

  async _semanticSearch (query, k) {
    const embedding = await embed(query)
    const pool = getPool()
    const vectorStr = `[${embedding.join(',')}]`

    try {
      const { rows } = await pool.query(`
        SELECT title, content, source_path, metadata,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        WHERE domain = 'legal'
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vectorStr, k])

      if (rows.length === 0) {
        return JSON.stringify({ results: [], message: 'No legal documents ingested yet. Use scripts/ingest.js to index contracts and legal docs.' })
      }

      return JSON.stringify({
        results: rows.map(r => ({
          title:   r.title,
          score:   parseFloat(r.score).toFixed(3),
          source:  r.source_path,
          content: r.content,
        })),
      })
    } catch (err) {
      return JSON.stringify({ results: [], error: err.message })
    }
  }
}

if (process.env.AMPHION_AGENT === 'legal' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new LegalAgent().run()
}
