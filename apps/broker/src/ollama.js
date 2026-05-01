/**
 * broker/src/ollama.js — Thin Ollama HTTP client
 *
 * Wraps POST /api/chat and POST /api/embed.
 * Handles both streaming (token-by-token) and non-streaming (full response).
 *
 * All inference calls in the broker go through this module so there's
 * one place to add retries, logging, and model routing later.
 */

const OLLAMA_HOST = () => process.env.OLLAMA_HOST ?? 'http://localhost:11434'

// ---------------------------------------------------------------------------
// callOllama — used by Dispatcher (non-streaming) and Voice Layer (streaming)
// ---------------------------------------------------------------------------

/**
 * Call Ollama /api/chat.
 *
 * @param {object} opts
 * @param {string}   opts.model
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.userMessage
 * @param {boolean}  [opts.stream=false]  — if true, returns an async generator
 * @param {{ role:string, content:string }[]} [opts.history=[]]
 * @returns {Promise<string>|AsyncGenerator<string>}
 *   Non-streaming: resolves to full response string
 *   Streaming:     async generator yielding token strings
 */
export async function callOllama ({ model, systemPrompt, userMessage, stream = false, history = [] }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const body = JSON.stringify({ model, messages, stream })

  const res = await fetch(`${OLLAMA_HOST()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`[ollama] POST /api/chat returned ${res.status}: ${text}`)
  }

  if (!stream) {
    // Non-streaming: read the entire NDJSON response and concatenate message content
    const text = await res.text()
    let fullContent = ''
    for (const line of text.trim().split('\n')) {
      if (!line.trim()) continue
      try {
        const chunk = JSON.parse(line)
        fullContent += chunk?.message?.content ?? ''
      } catch { /* skip malformed lines */ }
    }
    return fullContent.trim()
  }

  // Streaming: return an async generator that yields token strings
  return streamTokens(res.body)
}

/**
 * Async generator — reads NDJSON from a fetch response body and yields tokens.
 * @param {ReadableStream} body
 * @yields {string}
 */
async function* streamTokens (body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete trailing line in buffer

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const chunk = JSON.parse(line)
          const token = chunk?.message?.content
          if (token) yield token
          if (chunk?.done) return
        } catch { /* skip malformed lines */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// embed — generate a vector embedding for a text string
// ---------------------------------------------------------------------------

/**
 * Get an embedding vector from Ollama.
 * @param {string} text
 * @returns {Promise<number[]>}  — 768-dimensional float array
 */
export async function embed (text) {
  const model = process.env.OLLAMA_MODEL_EMBED ?? 'nomic-embed-text'

  const res = await fetch(`${OLLAMA_HOST()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`[ollama] POST /api/embed returned ${res.status}: ${errText}`)
  }

  const data = await res.json()
  // Ollama returns { embeddings: [[...]] } for the /api/embed endpoint
  const embedding = data?.embeddings?.[0] ?? data?.embedding
  if (!embedding) throw new Error('[ollama] embed response missing embeddings field')
  return embedding
}
