/**
 * broker/src/ollama.js — LiteLLM inference client (OpenAI-compatible)
 *
 * Routes all broker inference through LiteLLM (:4000), which speaks the
 * OpenAI protocol and dispatches to local Ollama models or cloud fallback.
 *
 * Function signatures are unchanged — dispatcher, agent-runner, voice-layer
 * call this exactly as before.
 */

const LLM_HOST = () => process.env.LITELLM_HOST ?? 'http://localhost:4000'
const LLM_KEY  = () => process.env.LITELLM_KEY  ?? ''

const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${LLM_KEY()}`,
})

// ---------------------------------------------------------------------------
// callOllama — used by Dispatcher (non-streaming) and Voice Layer (streaming)
// ---------------------------------------------------------------------------

/**
 * Call LiteLLM /v1/chat/completions.
 *
 * @param {object} opts
 * @param {string}   opts.model          — LiteLLM model alias (fast/balanced/voice/tiny)
 * @param {string}   opts.systemPrompt
 * @param {string}   opts.userMessage
 * @param {boolean}  [opts.stream=false] — if true, returns an async generator
 * @param {{ role:string, content:string }[]} [opts.history=[]]
 * @param {number}   [opts.numPredict]   — maps to max_tokens
 * @param {string}   [opts.format]       — 'json' → response_format: json_object
 * @param {number}   [opts.timeoutMs]
 * @returns {Promise<string>|AsyncGenerator<string>}
 */
export async function callOllama ({ model, systemPrompt, userMessage, stream = false, history = [], numPredict, format, timeoutMs }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ]

  const payload = { model, messages, stream, metadata: { no_context: true } }
  if (numPredict)        payload.max_tokens      = numPredict
  if (format === 'json') payload.response_format = { type: 'json_object' }

  const fetchOpts = {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  }
  if (timeoutMs) fetchOpts.signal = AbortSignal.timeout(timeoutMs)

  const res = await fetch(`${LLM_HOST()}/v1/chat/completions`, fetchOpts)

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`[llm] POST /v1/chat/completions returned ${res.status}: ${text}`)
  }

  if (!stream) {
    const data = await res.json()
    return (data.choices?.[0]?.message?.content ?? '').trim()
  }

  return streamTokensSSE(res.body)
}

/**
 * Async generator — reads OpenAI SSE stream and yields content delta strings.
 * @param {ReadableStream} body
 * @yields {string}
 */
async function* streamTokensSSE (body) {
  const reader  = body.getReader()
  const decoder = new TextDecoder()
  let buffer    = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete trailing line

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue
        try {
          const chunk = JSON.parse(trimmed.slice(6))
          const token = chunk.choices?.[0]?.delta?.content
          if (token) yield token
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// callOllamaTools — ReAct tool-calling loop
// ---------------------------------------------------------------------------

/**
 * Agentic call with tool use via /v1/chat/completions.
 *
 * Sends messages + tools, intercepts tool_calls, executes them via
 * executeTool, reinjects results, and continues until the model gives a
 * final text response or maxRounds is reached.
 *
 * Yields:
 *   { type: 'token', token: string }          — final narration content
 *   { type: 'tool_call', name, args, result }  — each tool invocation
 *
 * @param {object}   opts
 * @param {string}   opts.model
 * @param {{ role: string, content: string }[]} opts.messages
 * @param {object[]} opts.tools
 * @param {(name: string, args: object) => Promise<string>} opts.executeTool
 * @param {number}   [opts.maxRounds=6]
 * @param {number}   [opts.numPredict]
 */
export async function* callOllamaTools ({ model, messages, tools, executeTool, maxRounds = 6, numPredict }) {
  let msgs = [...messages]

  for (let round = 0; round < maxRounds; round++) {
    const payload = { model, messages: msgs, stream: false, tools }
    if (numPredict) payload.max_tokens = numPredict

    const res = await fetch(`${LLM_HOST()}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new Error(`[llm] tools call returned ${res.status}: ${text}`)
    }

    const data = await res.json()
    const msg  = data.choices?.[0]?.message

    if (msg?.tool_calls?.length) {
      msgs.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls })

      for (const tc of msg.tool_calls) {
        const name = tc.function?.name ?? ''
        // OpenAI sends arguments as a JSON string; Ollama-via-LiteLLM may send object
        let args
        try {
          const raw = tc.function?.arguments ?? '{}'
          args = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch { args = {} }
        // Strip nil sentinels sometimes injected by Ollama tool-call path
        if (typeof args === 'object' && args !== null) {
          args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== '<nil>'))
        }

        const result = await executeTool(name, args)
        yield { type: 'tool_call', name, args, result }
        // tool_call_id is required by OpenAI spec; may be absent from Ollama backend
        const toolMsg = { role: 'tool', content: result }
        if (tc.id) toolMsg.tool_call_id = tc.id
        msgs.push(toolMsg)
      }

      continue
    }

    const content = msg?.content ?? ''
    if (content) yield { type: 'token', token: content }
    break
  }
}

// ---------------------------------------------------------------------------
// embed — generate a vector embedding
// ---------------------------------------------------------------------------

/**
 * Get an embedding vector via LiteLLM /v1/embeddings.
 * @param {string} text
 * @returns {Promise<number[]>}  — 768-dimensional float array
 */
export async function embed (text) {
  const model = process.env.OLLAMA_MODEL_EMBED ?? 'embed'

  const res = await fetch(`${LLM_HOST()}/v1/embeddings`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ model, input: text }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText)
    throw new Error(`[llm] POST /v1/embeddings returned ${res.status}: ${errText}`)
  }

  const data = await res.json()
  const embedding = data.data?.[0]?.embedding
  if (!embedding) throw new Error('[llm] embed response missing data[0].embedding')
  return embedding
}
