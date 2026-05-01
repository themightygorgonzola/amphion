/**
 * mock-ollama — dev-only stub for the Ollama REST API
 *
 * Mimics the endpoints the broker and agents actually call:
 *   POST /api/chat      — returns a canned streaming chat response
 *   POST /api/embed     — returns a canned embedding vector
 *   GET  /api/tags      — returns a mock model list
 *   POST /api/show      — returns mock model info
 *
 * Streaming behavior matches real Ollama: newline-delimited JSON chunks,
 * final chunk has "done": true. Adds a small delay to simulate inference
 * latency so you can test the streaming UI realistically.
 */

import express from 'express'

const app = express()
app.use(express.json())

const PORT = 11434
const STREAM_DELAY_MS = 40 // delay between tokens (ms) — adjust to taste

// Mock response text by model role
const MOCK_RESPONSES = {
  dispatcher: JSON.stringify({
    task: 'answer_from_knowledge_base',
    domains: ['proposals'],
    mode: 'single',
    priority: 'normal'
  }),
  voice: `I found what you're looking for. Based on the Meridian proposal from last March, the scope covered three phases with a total value of $240,000. The client requested a 30-day review period which we accommodated. Would you like me to pull the full document?`,
  default: `This is a mock response from the Amphion dev environment. The real model is not running — this stub confirms your pipeline is wired correctly.`
}

function pickResponse (req) {
  const model = req.body?.model ?? ''
  if (model.includes('dispatcher') || model.includes('qwen3:14b')) {
    return MOCK_RESPONSES.dispatcher
  }
  if (req.body?.messages?.some(m => m.role === 'system' && m.content?.includes('JARVIS'))) {
    return MOCK_RESPONSES.voice
  }
  return MOCK_RESPONSES.default
}

// POST /api/chat — streaming newline-delimited JSON
app.post('/api/chat', async (req, res) => {
  const text = pickResponse(req)
  const streaming = req.body?.stream !== false

  if (!streaming) {
    return res.json({
      model: req.body?.model ?? 'mock',
      message: { role: 'assistant', content: text },
      done: true
    })
  }

  res.setHeader('Content-Type', 'application/x-ndjson')
  res.setHeader('Transfer-Encoding', 'chunked')

  const words = text.split(' ')
  for (let i = 0; i < words.length; i++) {
    const token = (i === 0 ? '' : ' ') + words[i]
    const chunk = JSON.stringify({
      model: req.body?.model ?? 'mock',
      message: { role: 'assistant', content: token },
      done: false
    })
    res.write(chunk + '\n')
    await new Promise(r => setTimeout(r, STREAM_DELAY_MS))
  }

  res.write(JSON.stringify({ model: req.body?.model ?? 'mock', done: true }) + '\n')
  res.end()
})

// POST /api/embed — returns a 768-dim zero vector (nomic-embed-text shape)
app.post('/api/embed', (req, res) => {
  const dims = 768
  res.json({
    model: req.body?.model ?? 'nomic-embed-text',
    embeddings: [Array(dims).fill(0).map(() => Math.random() * 0.01)],
    total_duration: 1234567
  })
})

// GET /api/tags — mock model list
app.get('/api/tags', (req, res) => {
  res.json({
    models: [
      { name: 'llama3.3:70b', size: 42000000000, digest: 'mock' },
      { name: 'qwen3:14b', size: 9000000000, digest: 'mock' },
      { name: 'nomic-embed-text', size: 274000000, digest: 'mock' },
      { name: 'devstral', size: 15000000000, digest: 'mock' }
    ]
  })
})

// POST /api/show — mock model info
app.post('/api/show', (req, res) => {
  res.json({
    modelfile: 'FROM mock\nSYSTEM "Mock model for Amphion dev"',
    parameters: 'temperature 0.7',
    details: { family: 'mock', parameter_size: '70B', quantization_level: 'Q4_K_M' }
  })
})

app.listen(PORT, () => {
  console.log(`[mock-ollama] listening on port ${PORT}`)
  console.log(`[mock-ollama] streaming delay: ${STREAM_DELAY_MS}ms per token`)
})
