/**
 * apps/broker/src/dispatcher.js
 *
 * The dispatcher no longer routes between knowledge backends. It only extracts
 * intent, topic, and modality. Resource discovery happens inside the knowledge
 * agent through recall/find/load/reflect.
 */

import fs from 'fs'
import path from 'path'
import { callOllama } from './ollama.js'

async function loadDispatcherPrompt () {
  const promptPath = path.resolve(
    process.env.PROMPTS_DIR ?? path.join(import.meta.dirname, '../../../prompts'),
    'dispatcher.md'
  )
  try { return fs.readFileSync(promptPath, 'utf8') } catch { return FALLBACK_PROMPT }
}

export async function dispatch (message, context, trace) {
  const directResponse = extractDeterministicDirectResponse(message)
  if (directResponse) {
    const ticket = {
      intent: 'Deterministic direct response',
      topic: '',
      modality: 'conversation',
      urgency: 'low',
      responseLength: 'brief',
      directResponse,
    }
    trace?.stage('dispatcher', { directResponse: true, jobTicket: ticket })
    return ticket
  }

  const systemPrompt = await loadDispatcherPrompt()
  const model = process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b'
  const userMessage = buildDispatcherInput(message, context)
  const t0 = Date.now()

  const raw = await callOllama({
    model,
    systemPrompt,
    userMessage,
    stream: false,
    format: 'json',
  })

  const jobTicket = parseJobTicket(raw, message)
  trace?.stage('dispatcher', {
    model,
    promptInput: userMessage,
    systemPromptPreview: systemPrompt.slice(0, 600),
    rawLlmOutput: raw,
    jobTicket,
    durationMs: Date.now() - t0,
  })
  return jobTicket
}

function buildDispatcherInput (message, context) {
  const parts = ['USER CONTEXT:', context.contextSummary]
  const recentTurns = (context.history ?? []).slice(-10)
  if (recentTurns.length > 0) {
    parts.push('', 'RECENT CONVERSATION (most recent last):')
    for (const turn of recentTurns) {
      const who = turn.role === 'user' ? 'User' : 'Atlas'
      const meta = turn.metadata ?? {}
      const annotations = []
      if (meta.modality) annotations.push(`modality=${meta.modality}`)
      if (meta.topic) annotations.push(`topic=${meta.topic}`)
      if (meta.filesystemPaths?.length) annotations.push(`resources=${meta.filesystemPaths.slice(0, 5).join(', ')}`)
      const label = annotations.length ? `${who} [${annotations.join('; ')}]` : who
      const text = `${turn.content ?? ''}`.replace(/\s+/g, ' ').slice(0, 360)
      parts.push(`  ${label}: ${text}${(turn.content?.length ?? 0) > 360 ? '...' : ''}`)
    }
  }
  parts.push('', 'USER MESSAGE:', message)
  return parts.join('\n')
}

function parseJobTicket (raw, originalMessage) {
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    const parsed = JSON.parse(cleaned)
    const modality = normalizeModality(parsed.modality, originalMessage)
    return {
      intent: parsed.intent ?? originalMessage.slice(0, 160),
      topic: parsed.topic ?? inferTopic(originalMessage),
      modality,
      urgency: normalizeUrgency(parsed.urgency),
      responseLength: normalizeLength(parsed.responseLength, originalMessage),
    }
  } catch (err) {
    console.error('[dispatcher] failed to parse job ticket:', err.message)
    console.error('[dispatcher] raw response:', raw)
    return {
      intent: originalMessage.slice(0, 160),
      topic: inferTopic(originalMessage),
      modality: inferModality(originalMessage),
      urgency: 'medium',
      responseLength: normalizeLength(null, originalMessage),
    }
  }
}

function normalizeModality (value, message) {
  const v = `${value ?? ''}`.toLowerCase()
  if (['retrieve', 'draft', 'act', 'remember', 'conversation'].includes(v)) return v
  return inferModality(message)
}

function inferModality (message) {
  if (/\b(what did we|remember|recall|last time|previously|talked about|discussed)\b/i.test(message)) return 'remember'
  if (/\b(draft|write an? email|compose|reply to|send)\b/i.test(message)) return 'draft'
  if (/\b(schedule|calendar|create task|set reminder|book|invite|update)\b/i.test(message)) return 'act'
  if (/\b(how are you|what'?s your name|who are you|are you there|you there)\b/i.test(message)) return 'conversation'
  return 'retrieve'
}

function normalizeUrgency (value) {
  const v = `${value ?? ''}`.toLowerCase()
  return ['low', 'medium', 'high'].includes(v) ? v : 'medium'
}

function normalizeLength (value, message) {
  const v = `${value ?? ''}`.toLowerCase()
  if (['brief', 'standard', 'detailed'].includes(v)) return v
  if (/\b(list|compare|breakdown|walk me through|every|each|all)\b/i.test(message)) return 'detailed'
  if (/\b(yes or no|quick|brief|short)\b/i.test(message)) return 'brief'
  return 'standard'
}

function inferTopic (message) {
  return `${message ?? ''}`.trim().slice(0, 220)
}

function extractDeterministicDirectResponse (message) {
  const exactWordMatch = message.match(/^\s*reply\s+with\s+exactly\s+one\s+word\s*:\s*([A-Za-z0-9_-]+)[.!?]*\s*$/i)
  if (exactWordMatch) return exactWordMatch[1]
  return null
}

const FALLBACK_PROMPT = `You are a dispatcher. Respond only with JSON: {"intent":"...","topic":"...","modality":"retrieve|draft|act|remember|conversation","urgency":"low|medium|high","responseLength":"brief|standard|detailed"}.`
