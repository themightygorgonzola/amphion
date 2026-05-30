#!/usr/bin/env node
/**
 * scripts/inspect-pipeline.js — Full pipeline inspection tool
 *
 * Runs a query through the broker and pretty-prints everything the UI would
 * receive: pipeline flow, evidence cards (header / highlight / annotation /
 * full content), narration text, and event counts.
 *
 * Usage:
 *   node scripts/inspect-pipeline.js "your query here"
 *   node scripts/inspect-pipeline.js          (uses default legal query)
 */

import 'dotenv/config'

const BROKER = process.env.BROKER_URL ?? 'http://127.0.0.1:3000'
const query  = process.argv.slice(2).join(' ') || 'What is Washington traffic signal law?'

const L1 = '─'.repeat(80)
const L2 = '═'.repeat(80)

const wrap = (text, indent = 2, width = 80) => {
  const prefix = ' '.repeat(indent)
  const words  = `${text ?? ''}`.replace(/\s+/g, ' ').trim().split(' ')
  const lines  = []
  let line     = prefix
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.trim()) {
      lines.push(line)
      line = prefix + word
    } else {
      line += (line === prefix ? '' : ' ') + word
    }
  }
  if (line.trim()) lines.push(line)
  return lines.join('\n')
}

console.log(L2)
console.log(`  Pipeline Inspector  ·  ${new Date().toLocaleTimeString()}`)
console.log(`  Query : "${query}"`)
console.log(`  Broker: ${BROKER}`)
console.log(L2)

// ---------------------------------------------------------------------------
// Run query
// ---------------------------------------------------------------------------

let res
try {
  res = await fetch(`${BROKER}/query`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: query, sessionId: `inspect-${Date.now()}` }),
  })
} catch (err) {
  console.error(`\n  ERROR: Could not reach broker at ${BROKER}`)
  console.error(`  ${err.message}`)
  console.error(`  Start it first:  npm run broker\n`)
  process.exit(1)
}

if (!res.ok) {
  console.error(`\n  HTTP ${res.status} ${res.statusText}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Collect SSE events
// ---------------------------------------------------------------------------

const t0 = Date.now()
const allEvents  = []
const cards      = []
const statusLog  = []
let   narration  = ''
let   tokenCount = 0
let   jobTicket  = null

for await (const chunk of res.body) {
  const text = Buffer.from(chunk).toString()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const evt = JSON.parse(payload)
      allEvents.push(evt)
      switch (evt.type) {
        case 'evidence_card': cards.push(evt.card);          break
        case 'token':         narration += evt.token; tokenCount++; break
        case 'status':        statusLog.push(evt.message);  break
        case 'ticket':        jobTicket = evt.data;          break
      }
    } catch { /* skip malformed */ }
  }
}

const durationMs = Date.now() - t0

// ---------------------------------------------------------------------------
// Pipeline flow
// ---------------------------------------------------------------------------

console.log()
console.log('  PIPELINE FLOW:')
for (const msg of statusLog) {
  console.log(`    › ${msg}`)
}
if (jobTicket?.domains?.length) {
  console.log(`    › Domains routed: ${jobTicket.domains.join(', ')}`)
  if (jobTicket.intent) console.log(`    › Intent: ${jobTicket.intent}`)
  if (jobTicket.responseLength) console.log(`    › Length: ${jobTicket.responseLength}`)
}
console.log(`    › Total: ${(durationMs / 1000).toFixed(1)}s`)

// ---------------------------------------------------------------------------
// Event counts
// ---------------------------------------------------------------------------

console.log()
const typeCounts = {}
for (const e of allEvents) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1
console.log('  EVENT COUNTS:')
for (const [type, n] of Object.entries(typeCounts)) {
  console.log(`    ${ type.padEnd(18) } ${n}`)
}

// ---------------------------------------------------------------------------
// Evidence cards
// ---------------------------------------------------------------------------

console.log()
console.log(L1)
console.log(`  EVIDENCE CARDS  (${cards.length})`)
console.log(L1)

if (cards.length === 0) {
  console.log()
  console.log('  (none — query did not produce evidence cards)')
  console.log('  This happens when: no legal/research domains were called,')
  console.log('  or the agent returned 0 results, or it is a conversational query.')
} else {
  for (const [i, card] of cards.entries()) {
    const header = [card.title, card.section_header].filter(Boolean).join(' — ')
    console.log()
    console.log(`  [${i + 1}]  ${header}`)
    console.log(`       chunk_id : ${card.chunk_id ?? '(none)'}`)

    if (card.highlight_phrase) {
      const phrase = card.highlight_phrase.replace(/\s+/g, ' ').trim()
      console.log()
      console.log(`       HIGHLIGHT (${phrase.length} chars):`)
      console.log(wrap(`"${phrase}"`, 7))
    } else {
      console.log(`       HIGHLIGHT: (none — automatic fallback card)`)
    }

    if (card.annotation) {
      console.log()
      console.log(`       ANNOTATION: ${card.annotation}`)
    }

    const content = (card.content ?? '').replace(/\s+/g, ' ').trim()
    if (content) {
      const preview = content.slice(0, 400)
      console.log()
      console.log(`       FULL CONTENT (${content.length} chars total):`)
      console.log(wrap(preview + (content.length > 400 ? ' …(truncated)' : ''), 7))
    }
  }
}

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

console.log()
console.log(L1)
console.log(`  NARRATION  (${tokenCount} tokens, ${narration.length} chars)`)
console.log(L1)
console.log()
if (narration.trim()) {
  console.log(wrap(narration.trim(), 2))
} else {
  console.log('  (empty — no narration was streamed)')
}

console.log()
console.log(L2)
console.log()
