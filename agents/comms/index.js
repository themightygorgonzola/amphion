/**
 * agents/comms/index.js — Communications Agent
 *
 * Drafts and manages communications: emails, meeting follow-ups, status updates.
 * Uses the knowledge base (domain=comms) for past communications and tone examples.
 *
 * MCP Tools:
 *   draft_email      — draft an email to a contact given context and purpose
 *   find_comms       — search past communications for a contact or topic
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
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userMessage },
      ],
    }),
  })
  const data = await res.json()
  return data.message?.content ?? ''
}

class CommsAgent extends BaseAgent {
  get name () { return 'comms' }
  get description () { return 'Email drafting, communication search, and contact history lookup' }

  get tools () {
    return [
      {
        name: 'draft_email',
        description: 'Draft a professional email given the recipient, purpose, and any relevant context. Returns a ready-to-use draft.',
        inputSchema: {
          type: 'object',
          properties: {
            recipient:    { type: 'string', description: 'Name or role of the email recipient' },
            purpose:      { type: 'string', description: 'What the email needs to accomplish' },
            tone:         { type: 'string', description: 'Desired tone: formal, friendly, direct, follow-up. Defaults to professional.' },
            context:      { type: 'string', description: 'Any additional context: deal name, previous meeting, etc.' },
          },
          required: ['recipient', 'purpose'],
        },
      },
      {
        name: 'find_comms',
        description: 'Search past communications for a specific contact or topic.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Contact name, topic, or keyword to search past communications' },
            k:     { type: 'integer', description: 'Number of results (default 5)' },
          },
          required: ['query'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'draft_email': return this._draftEmail(args)
      case 'find_comms':  return this._findComms(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _draftEmail ({ recipient, purpose, tone = 'professional', context = '' }) {
    if (!recipient?.trim()) throw new Error('recipient is required')
    if (!purpose?.trim())   throw new Error('purpose is required')

    this.log(`draft_email to=${recipient} purpose="${purpose.slice(0, 50)}"`)

    const systemPrompt = `You are a professional communications assistant.
Draft concise, effective emails. Use the specified tone.
Output ONLY the email — subject line first (Subject: ...), then the body.
Do not add any commentary or notes outside the email itself.`

    const userMessage = `Draft an email to: ${recipient}
Purpose: ${purpose}
Tone: ${tone}
${context ? `Additional context: ${context}` : ''}

Write a complete email with subject line and body.`

    const draft = await callLLM(systemPrompt, userMessage)
    return JSON.stringify({ draft, recipient, purpose })
  }

  async _findComms ({ query, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k), 20)
    this.log(`find_comms: "${query.slice(0, 60)}"`)

    const embedding = await embed(query)
    const pool = getPool()
    const vectorStr = `[${embedding.join(',')}]`

    try {
      const { rows } = await pool.query(`
        SELECT title, content, source_path, created_at,
               1 - (embedding <=> $1::vector) AS score
        FROM knowledge_items
        WHERE domain = 'comms'
        ORDER BY embedding <=> $1::vector
        LIMIT $2
      `, [vectorStr, k])

      if (rows.length === 0) {
        return JSON.stringify({ results: [], message: 'No communications ingested yet.' })
      }

      return JSON.stringify({
        results: rows.map(r => ({
          title:   r.title,
          score:   parseFloat(r.score).toFixed(3),
          source:  r.source_path,
          date:    r.created_at,
          content: r.content,
        })),
      })
    } catch (err) {
      return JSON.stringify({ results: [], error: err.message })
    }
  }
}

if (process.env.AMPHION_AGENT === 'comms' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new CommsAgent().run()
}
