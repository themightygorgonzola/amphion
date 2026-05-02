/**
 * broker/src/index.js — Amphion Broker
 *
 * The central pipeline. Every user message passes through four layers:
 *   1. Context Assembler  — reads SQLite, builds context packet (no LLM call)
 *   2. Dispatcher         — one fast LLM call, outputs a JSON job ticket
 *   3. Orchestrator       — pure logic, executes the plan (calls agents)
 *   4. Voice Layer        — one final LLM call, writes unified JARVIS response
 *
 * Routes:
 *   POST /query     — accepts { message, sessionId? }, streams response via SSE
 *   GET  /health    — returns { ok: true }
 */

import 'dotenv/config'
import express from 'express'
import { randomUUID } from 'crypto'
import { assembleContext } from './context-assembler.js'
import { dispatch } from './dispatcher.js'
import { orchestrate } from './orchestrator.js'
import { synthesizeStream } from './voice-layer.js'
import { initDb, saveConversationTurn } from './db.js'

const app = express()
app.use(express.json())

const PORT = process.env.BROKER_PORT ?? 3000
const HOST = process.env.BROKER_HOST ?? '127.0.0.1'

// ---------------------------------------------------------------------------
// POST /query — main pipeline entry point
// Streams back SSE events to the client as each pipeline stage completes.
// ---------------------------------------------------------------------------
app.post('/query', async (req, res) => {
  const { message, sessionId = randomUUID() } = req.body

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' })
  }

  // Set up SSE headers — the Electron app will consume these
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  // Helper: send a flat SSE data line with type field (matches renderer's handleEvent)
  const send = (type, payload = {}) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`)
  }

  try {
    // Stage 1: Context Assembler (no LLM, fast)
    send('status', { message: 'Assembling context...' })
    const context = await assembleContext(sessionId)

    // Stage 2: Dispatcher — classifies query, returns job ticket
    send('status', { message: 'Routing your request...' })
    const jobTicket = await dispatch(message, context)
    send('ticket', { data: jobTicket })

    // Stage 3: Orchestrator — calls domain agents per job ticket
    const domainLabel = jobTicket.domains.join(', ')
    send('status', { message: `Consulting ${domainLabel}...` })
    const agentResults = await orchestrate(jobTicket, message, context)

    // Stage 4: Voice Layer — stream tokens directly to client
    send('status', { message: 'Composing response...' })
    const tokenStream = await synthesizeStream(agentResults, message, context)
    let fullResponse = ''
    for await (const token of tokenStream) {
      fullResponse += token
      send('token', { token })
    }

    // Save this turn to conversation history
    saveConversationTurn(sessionId, 'user', message, { jobTicket })
    saveConversationTurn(sessionId, 'assistant', fullResponse, { domains: jobTicket.domains })

  } catch (err) {
    console.error('[broker] pipeline error:', err)
    send('error', { message: err.message ?? 'Pipeline error' })
  } finally {
    send('done', { sessionId })
    res.end()
  }
})

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok:          true,
    system:      process.env.SYSTEM_NAME  ?? 'amphion',
    displayName: process.env.DISPLAY_NAME ?? 'Atlas',
  })
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start () {
  await initDb()
  app.listen(PORT, HOST, () => {
    console.log(`[broker] listening on http://${HOST}:${PORT}`)
    console.log(`[broker] SYSTEM_NAME=${process.env.SYSTEM_NAME ?? 'amphion'}  DISPLAY_NAME=${process.env.DISPLAY_NAME ?? 'Atlas'}`)
  })
}

start().catch(err => {
  console.error('[broker] failed to start:', err)
  process.exit(1)
})
