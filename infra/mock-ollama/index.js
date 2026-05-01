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

const VOICE_RESPONSE_BY_DOMAIN = {
  research:  `Based on the research in the knowledge base, construction activity remains elevated driven by infrastructure spending. Commercial real estate is showing mixed signals — office vacancy rates are still elevated post-pandemic while industrial and logistics space is at record lows. Do you want me to pull specific figures?`,
  finance:   `I've pulled the financial summary. The Henderson deal is currently in negotiation at $4.2M — the client has requested revised payment terms. Q1 budget came in 3% under target. Want me to break down the deal structure?`,
  legal:     `I've reviewed the relevant legal documents. The standard NDA has been flagged for clause 7 regarding IP ownership — it's broader than we'd typically accept. The subcontractor agreements also carry indemnification risk. Do you want me to draft suggested revisions?`,
  comms:     `I've drafted the email for you. It's direct and gets straight to the point per your usual tone. Want me to adjust the ask or the closing?`,
  proposals: `I found 2 similar proposals in the knowledge base. The Meridian proposal at $240K won — the key differentiator was phased delivery and fixed-fee structure. The Westfield proposal at $180K is still pending. Win rate across proposals domain is 60%. Want me to outline a new proposal based on the winning structure?`,
  default:   `This is a mock response from the Amphion dev environment. The real model is not running — this stub confirms your pipeline is wired correctly.`
}

function buildDispatcherTicket (req) {
  // Extract the actual user question from the formatted dispatcher input
  const messages = req.body?.messages ?? []
  const userMsg = messages.slice().reverse().find(m => m.role === 'user')?.content ?? ''
  const question = userMsg.split('USER MESSAGE:').pop()?.trim() ?? userMsg
  const lower = question.toLowerCase()

  let domain = 'research'
  if (/deal|budget|revenue|invoice|payment|financial|cost|price|valuation|q[1-4]\b|quarter/.test(lower)) {
    domain = 'finance'
  } else if (/contract|legal|nda|compliance|risk|liability|clause|indemnif/.test(lower)) {
    domain = 'legal'
  } else if (/email|draft|message|communicat|write to|send to|contact|correspond/.test(lower)) {
    domain = 'comms'
  } else if (/proposal|bid|win rate|pitch|scope|opportunity|rfp/.test(lower)) {
    domain = 'proposals'
  } else if (/research|trend|market|industry|report|analysis|study|what do we know/.test(lower)) {
    domain = 'research'
  }

  return JSON.stringify({
    domains:      [domain],
    parallel:     false,
    intent:       question.slice(0, 100),
    instructions: { [domain]: question },
    urgency:      'medium'
  })
}

function pickResponse (req) {
  const model = req.body?.model ?? ''

  if (model.includes('qwen3:14b') || model.includes('dispatcher')) {
    return buildDispatcherTicket(req)
  }

  // Voice layer — look for [DOMAIN] markers the voice layer injects in AGENT RESULTS
  const userContent = req.body?.messages?.find(m => m.role === 'user')?.content ?? ''
  const domainMarker = userContent.match(/\[([A-Z]+)\]/)
  if (domainMarker) {
    const d = domainMarker[1].toLowerCase()
    if (VOICE_RESPONSE_BY_DOMAIN[d]) return VOICE_RESPONSE_BY_DOMAIN[d]
  }

  return VOICE_RESPONSE_BY_DOMAIN.default
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
