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
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'

const OLLAMA_HOST      = process.env.OLLAMA_HOST            ?? 'http://localhost:11434'
const EMBED_MODEL      = process.env.OLLAMA_MODEL_EMBED      ?? 'nomic-embed-text'
const DISPATCHER_MODEL = process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b'

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
        name: 'find_similar_proposals',
        description: 'Find past proposals similar to a given opportunity or description.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'Description of the new opportunity or client need' },
            k: { type: 'integer', description: 'Number of results (default 5)' },
          },
          required: ['description'],
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
            opportunity:  { type: 'string', description: 'Description of the opportunity or RFP' },
            client:       { type: 'string', description: 'Client name or sector' },
            value:        { type: 'string', description: 'Estimated deal value or size (e.g. "$500K")', },
          },
          required: ['opportunity'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'find_similar_proposals': return this._findSimilar(args)
      case 'get_win_rate':           return this._getWinRate(args)
      case 'outline_proposal':       return this._outlineProposal(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _findSimilar ({ description, k = 5 }) {
    if (!description?.trim()) throw new Error('description is required')
    k = Math.min(Math.max(1, k), 20)
    this.log(`find_similar: "${description.slice(0, 60)}"`)

    const embedding = await embed(description)
    const pool = getPool()
    const vectorStr = `[${embedding.join(',')}]`

    try {
      const { rows } = await pool.query(`
        SELECT title, content, source_path, metadata,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        WHERE domain = 'proposals'
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vectorStr, k])

      if (rows.length === 0) {
        return JSON.stringify({ results: [], message: 'No proposals ingested yet. Use scripts/ingest.js to index past proposals.' })
      }

      return JSON.stringify({
        results: rows.map(r => ({
          title:    r.title,
          score:    parseFloat(r.score).toFixed(3),
          source:   r.source_path,
          metadata: r.metadata,
          content:  r.content,
        })),
      })
    } catch (err) {
      return JSON.stringify({ results: [], error: err.message })
    }
  }

  async _getWinRate ({ filter } = {}) {
    this.log(`get_win_rate filter=${filter ?? 'none'}`)

    const pool = getPool()

    try {
      const { rows } = await pool.query(`
        SELECT title, metadata, created_at
        FROM knowledge_items
        WHERE domain = 'proposals'
        ${filter ? `AND (title ILIKE $1 OR content ILIKE $1)` : ''}
        ORDER BY created_at DESC
        LIMIT 50
      `, filter ? [`%${filter}%`] : [])

      const total = rows.length
      const won   = rows.filter(r => {
        const m = r.metadata
        return m && (m.outcome === 'won' || m.status === 'won')
      }).length

      return JSON.stringify({
        total,
        won,
        lost: total - won,
        win_rate: total > 0 ? `${Math.round((won / total) * 100)}%` : 'N/A',
        note: total === 0 ? 'No proposals found. Index proposal documents to see win rate analytics.' : undefined,
      })
    } catch (err) {
      return JSON.stringify({ error: err.message })
    }
  }

  async _outlineProposal ({ opportunity, client = 'the client', value = 'TBD' }) {
    if (!opportunity?.trim()) throw new Error('opportunity is required')
    this.log(`outline_proposal: "${opportunity.slice(0, 60)}"`)

    const systemPrompt = `You are a business development specialist who writes winning proposals.
Generate a clear, structured proposal outline. Use markdown headers.
Be specific — include section names, key points to address, and suggested angles.`

    const userMessage = `Create a proposal outline for this opportunity:
Opportunity: ${opportunity}
Client: ${client}
Estimated value: ${value}

Produce a complete proposal outline with sections and key points for each.`

    const outline = await callLLM(systemPrompt, userMessage)
    return JSON.stringify({ outline, opportunity, client, value })
  }
}

if (process.env.AMPHION_AGENT === 'proposals' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new ProposalsAgent().run()
}
