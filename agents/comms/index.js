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
import { BaseAgent } from '../_base/index.js'
import {
  searchResourceChunks,
  searchResourceSummaries,
} from '../_shared/resource-retrieval.js'

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
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: userMessage },
      ],
    }),
  })
  const data = await res.json()
  return data.message?.content ?? ''
}

function isGenericFollowUpPurpose (purpose) {
  return /\b(next steps?|follow up|follow-up|check in|checking in)\b/i.test(`${purpose ?? ''}`)
}

function inferDraftTopic (purpose, recipient) {
  const text = `${purpose ?? ''}`
    .replace(/^draft an email to\s+[^\n,]+/i, '')
    .replace(/^draft an email/i, '')
    .replace(/^write an email to\s+[^\n,]+/i, '')
    .replace(/^write an email/i, '')
    .replace(/\bwith next steps?\b/gi, '')
    .replace(/\bafter our\b/gi, '')
    .replace(/\bregarding\b/gi, '')
    .replace(/\babout\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!text) return 'this project'
  const cleaned = text
    .replace(new RegExp(`^${recipient}\b`, 'i'), '')
    .replace(/^the\s+/i, '')
    .trim()
  return cleaned || 'this project'
}

function buildGenericFollowUpDraft ({ recipient, purpose }) {
  const topic = inferDraftTopic(purpose, recipient)
  const greeting = /^([A-Z][a-z]+)$/.test(recipient) ? `Hi ${recipient},` : `Hello ${recipient},`
  const subjectTopic = topic === 'this project' ? 'Next Steps' : `Next Steps for ${topic.replace(/^[a-z]/, ch => ch.toUpperCase())}`

  return [
    `Subject: ${subjectTopic}`,
    '',
    greeting,
    '',
    `I wanted to follow up on our recent discussion about ${topic} and confirm the next steps.`,
    'I will pull together the action items we discussed and share a proposed timeline for review shortly.',
    'If there is anything you would like me to prioritize, let me know.',
    '',
    'Best,',
    '[Your Name]',
  ].join('\n')
}

class CommsAgent extends BaseAgent {
  get name () { return 'comms' }
  get description () { return 'Email drafting, communication search, and contact history lookup' }

  get tools () {
    return [
      {
        name: 'search_documents',
        description: 'Start here — broad probe across ingested communications documents. Finds which documents are relevant using semantic similarity on summaries and keyword matching. Zero results means no comms documents have been ingested yet.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string',  description: 'Contact name, topic, or keyword to search past communications' },
            k:     { type: 'integer', description: 'Number of documents (default 5, max 15)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_hybrid',
        description: 'Go deeper — chunk-level hybrid search (semantic + BM25 via RRF) across ingested communications. Use for precise content retrieval or after search_documents identifies what is relevant.',
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
        name: 'draft_email',
        description: 'Draft a professional email given the recipient, purpose, and any relevant context. Returns a ready-to-use draft.',
        inputSchema: {
          type: 'object',
          properties: {
            recipient: { type: 'string', description: 'Name or role of the email recipient' },
            purpose:   { type: 'string', description: 'What the email needs to accomplish' },
            tone:      { type: 'string', description: 'Desired tone: formal, friendly, direct, follow-up. Defaults to professional.' },
            context:   { type: 'string', description: 'Any additional context: deal name, previous meeting, etc.' },
          },
          required: ['recipient', 'purpose'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_documents': return this._searchDocuments(args)
      case 'search_hybrid':    return this._searchHybrid(args)
      case 'draft_email':      return this._draftEmail(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _searchDocuments ({ query, k = 5 }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 5), 15)
    this.log(`search_documents: "${query.slice(0, 60)}" k=${k}`)
    const merged = await searchResourceSummaries({ query, corpus: 'comms', k })
    if (!merged.length) return JSON.stringify({ documents: [], message: 'No comms documents found. Ingest communications documents to populate this domain.' })
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
      })),
    })
  }

  async _searchHybrid ({ query, k = 6, neighbors = true }) {
    if (!query?.trim()) throw new Error('query is required')
    k = Math.min(Math.max(1, k ?? 6), 20)
    this.log(`search_hybrid: "${query.slice(0, 60)}" k=${k}`)
    const merged = await searchResourceChunks({ query, corpus: 'comms', k, neighbors })
    if (!merged.length) return JSON.stringify({ chunks: [], message: 'No comms content matched. Try search_documents to confirm what is available.' })
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

  async _draftEmail ({ recipient, purpose, tone = 'professional', context = '' }) {
    if (!recipient?.trim()) throw new Error('recipient is required')
    if (!purpose?.trim())   throw new Error('purpose is required')

    this.log(`draft_email to=${recipient} purpose="${purpose.slice(0, 50)}"`)

    const hasContext = `${context ?? ''}`.trim().length > 0
    if (!hasContext && isGenericFollowUpPurpose(purpose)) {
      return JSON.stringify({ draft: buildGenericFollowUpDraft({ recipient, purpose }), recipient, purpose })
    }

    const systemPrompt = `You are a professional communications assistant.
Draft concise, effective emails. Use the specified tone.
Output ONLY the email — subject line first (Subject: ...), then the body.
  Do not add any commentary or notes outside the email itself.
  Use ONLY facts explicitly provided in the request or supporting context.
  Do NOT invent statutes, regulations, dates, commitments, prior discussion details, deliverables, or project facts.
  If specific facts are missing, keep the email generic and high-level.`

    const userMessage = `Draft an email to: ${recipient}
Purpose: ${purpose}
Tone: ${tone}
  ${hasContext ? `Supporting context:\n${context}` : 'Supporting context: none provided. Keep the draft generic and do not invent specifics.'}

Write a complete email with subject line and body.`

    const draft = await callLLM(systemPrompt, userMessage)
    return JSON.stringify({ draft, recipient, purpose })
  }
}

if (process.env.AMPHION_AGENT === 'comms' || process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new CommsAgent().run()
}
