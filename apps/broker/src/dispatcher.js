/**
 * broker/src/dispatcher.js — Stage 2
 *
 * One fast LLM call to qwen3:14b.
 * Input:  user message + context packet
 * Output: JSON job ticket
 *
 * Job ticket schema:
 * {
 *   domains:      string[]   // one or more: research | finance | legal | comms | proposals
 *   parallel:     boolean    // true = run all domains simultaneously
 *   intent:       string     // one-line summary of what the user wants
 *   instructions: {          // per-domain task description
 *     [domain]: string
 *   }
 *   urgency:      'low' | 'medium' | 'high'
 * }
 */

import fs from 'fs'
import path from 'path'
import { callOllama } from './ollama.js'

// Load the dispatcher system prompt from the prompts directory.
// This is intentionally runtime-loaded so you can edit the prompt
// without restarting the broker.
function loadDispatcherPrompt () {
  const promptPath = path.resolve(
    process.env.PROMPTS_DIR ?? path.join(import.meta.dirname, '../../../prompts'),
    'dispatcher.md'
  )
  try {
    return fs.readFileSync(promptPath, 'utf8')
  } catch {
    console.warn('[dispatcher] could not read prompts/dispatcher.md — using inline fallback')
    return FALLBACK_PROMPT
  }
}

/**
 * Classify the user message and produce a job ticket.
 *
 * @param {string} message
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {Promise<JobTicket>}
 *
 * @typedef {Object} JobTicket
 * @property {string[]} domains
 * @property {boolean}  parallel
 * @property {string}   intent
 * @property {Object.<string,string>} instructions
 * @property {'low'|'medium'|'high'} urgency
 */
export async function dispatch (message, context) {
  const systemPrompt = loadDispatcherPrompt()

  const userMessage = buildDispatcherInput(message, context)

  const raw = await callOllama({
    model: process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b',
    systemPrompt,
    userMessage,
    stream: false,
  })

  return parseJobTicket(raw, message)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDispatcherInput (message, context) {
  return [
    `USER CONTEXT:`,
    context.contextSummary,
    ``,
    `USER MESSAGE:`,
    message,
  ].join('\n')
}

/**
 * Parse the model's response into a JobTicket.
 * The model should return pure JSON, but we defensively try to extract it
 * even if there's surrounding prose (model sometimes adds ```json fences).
 */
function parseJobTicket (raw, originalMessage) {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  try {
    const ticket = JSON.parse(cleaned)

    // Validate required fields, fill defaults if model omitted them
    return {
      domains:      Array.isArray(ticket.domains) ? ticket.domains : ['research'],
      parallel:     typeof ticket.parallel === 'boolean' ? ticket.parallel : false,
      intent:       ticket.intent ?? originalMessage.slice(0, 120),
      instructions: ticket.instructions ?? buildDefaultInstructions(ticket.domains ?? ['research'], originalMessage),
      urgency:      ticket.urgency ?? 'medium',
    }
  } catch (err) {
    console.error('[dispatcher] failed to parse job ticket:', err.message)
    console.error('[dispatcher] raw response:', raw)

    // Fallback: single-domain research ticket so the pipeline keeps flowing
    return {
      domains:      ['research'],
      parallel:     false,
      intent:       originalMessage.slice(0, 120),
      instructions: { research: originalMessage },
      urgency:      'medium',
    }
  }
}

function buildDefaultInstructions (domains, message) {
  return Object.fromEntries(domains.map(d => [d, message]))
}

// ---------------------------------------------------------------------------
// Fallback prompt (used if prompts/dispatcher.md is missing)
// ---------------------------------------------------------------------------
const FALLBACK_PROMPT = `You are a routing dispatcher. Given a user message, respond with ONLY a JSON job ticket.

Schema:
{
  "domains": ["research"|"finance"|"legal"|"comms"|"proposals"],
  "parallel": false,
  "intent": "one-line summary",
  "instructions": { "<domain>": "what to do" },
  "urgency": "low"|"medium"|"high"
}

Always respond with valid JSON only. No prose, no explanation.`
