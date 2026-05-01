/**
 * broker/src/voice-layer.js — Stage 4
 *
 * The final synthesis step. Takes all agent results and crafts
 * one unified response in the voice of {{DISPLAY_NAME}}.
 *
 * Two paths:
 *   streaming  — returns an async generator yielding tokens (for SSE to client)
 *   buffered   — returns the full response as a string (for internal use / testing)
 */

import fs from 'fs'
import path from 'path'
import { callOllama } from './ollama.js'

function loadVoicePrompt () {
  const promptPath = path.resolve(
    process.env.PROMPTS_DIR ?? path.join(import.meta.dirname, '../../../prompts'),
    'voice-layer.md'
  )
  try {
    let prompt = fs.readFileSync(promptPath, 'utf8')
    // Replace the {{DISPLAY_NAME}} template variable at runtime
    const displayName = process.env.DISPLAY_NAME ?? 'Atlas'
    return prompt.replaceAll('{{DISPLAY_NAME}}', displayName)
  } catch {
    console.warn('[voice-layer] could not read prompts/voice-layer.md — using inline fallback')
    return buildFallbackPrompt()
  }
}

// ---------------------------------------------------------------------------
// synthesize — used by POST /query
// Returns the full response string (Voice Layer handles streaming via SSE directly in index.js)
// ---------------------------------------------------------------------------

/**
 * Synthesize a unified response from agent results.
 *
 * @param {Object.<string, import('./orchestrator.js').AgentResult>} agentResults
 * @param {string} originalMessage
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {Promise<string>}  — full response text
 */
export async function synthesize (agentResults, originalMessage, context) {
  const systemPrompt = loadVoicePrompt()
  const userMessage = buildVoiceInput(agentResults, originalMessage, context)

  const response = await callOllama({
    model: process.env.OLLAMA_MODEL_PRIMARY ?? 'llama3.3:70b',
    systemPrompt,
    userMessage,
    history: context.history ?? [],
    stream: false,
  })

  return response
}

/**
 * Like synthesize() but streams tokens via an async generator.
 * Used when you want to pipe tokens directly to an SSE response
 * without buffering the full reply.
 *
 * @param {Object.<string, import('./orchestrator.js').AgentResult>} agentResults
 * @param {string} originalMessage
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {AsyncGenerator<string>}
 */
export async function synthesizeStream (agentResults, originalMessage, context) {
  const systemPrompt = loadVoicePrompt()
  const userMessage = buildVoiceInput(agentResults, originalMessage, context)

  // callOllama returns an AsyncGenerator when stream: true
  return callOllama({
    model: process.env.OLLAMA_MODEL_PRIMARY ?? 'llama3.3:70b',
    systemPrompt,
    userMessage,
    history: context.history ?? [],
    stream: true,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildVoiceInput (agentResults, originalMessage, context) {
  const resultLines = []

  for (const [domain, result] of Object.entries(agentResults)) {
    if (!result.success) {
      resultLines.push(`[${domain.toUpperCase()} — ERROR] ${result.error ?? 'Unknown error'}`)
      continue
    }
    resultLines.push(`[${domain.toUpperCase()}]\n${result.summary}`)
  }

  return [
    `ORIGINAL REQUEST:`,
    originalMessage,
    ``,
    `AGENT RESULTS:`,
    resultLines.join('\n\n'),
  ].join('\n')
}

function buildFallbackPrompt () {
  const name = process.env.DISPLAY_NAME ?? 'Atlas'
  return `You are ${name}, a private AI assistant. Synthesize the agent results into a direct, confident response. Speak in first person. No filler phrases. No mention of agents or domains.`
}
