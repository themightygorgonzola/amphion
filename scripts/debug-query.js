#!/usr/bin/env node
/**
 * scripts/debug-query.js — Pipeline debugger
 *
 * Runs a single query through the broker, waits for it to complete,
 * then fetches and pretty-prints the full pipeline trace.
 *
 * Usage:
 *   node scripts/debug-query.js --query "vehicular assault penalties in Washington"
 *   node scripts/debug-query.js --query "..." --stage voice
 *   node scripts/debug-query.js --query "..." --raw
 *
 * Flags:
 *   --query  <text>   (required) The message to send
 *   --stage  <name>   Filter output to a single stage (e.g. dispatcher, voice, agent:legal)
 *   --raw             Dump raw trace JSON instead of formatted output
 *   --broker <url>    Broker base URL (default: http://localhost:3000)
 */

import { parseArgs } from 'node:util'

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
  white:  '\x1b[97m',
}
const c = (color, text) => `${C[color]}${text}${C.reset}`
const bold = (t) => c('bold', t)
const dim  = (t) => c('dim', t)

function hr (label = '', width = 72) {
  const bar = label
    ? `${'─'.repeat(3)} ${label} ${'─'.repeat(Math.max(0, width - label.length - 5))}`
    : '─'.repeat(width)
  return c('dim', bar)
}

function trunc (str, max) {
  if (!str) return dim('(empty)')
  const s = String(str)
  if (s.length <= max) return s
  return s.slice(0, max) + c('dim', `… (+${s.length - max} chars)`)
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    query:  { type: 'string', short: 'q' },
    stage:  { type: 'string', short: 's' },
    raw:    { type: 'boolean', short: 'r', default: false },
    broker: { type: 'string', short: 'b', default: 'http://localhost:3000' },
  },
  strict: false,
})

if (!args.query) {
  console.error(c('red', 'Error: --query is required'))
  console.error(dim('  Usage: node scripts/debug-query.js --query "your question here"'))
  process.exit(1)
}

const BROKER = args.broker

// ---------------------------------------------------------------------------
// Step 1: Send query, stream SSE, collect full response
// ---------------------------------------------------------------------------
console.log()
console.log(bold(c('cyan', '◆ AMPHION PIPELINE DEBUGGER')))
console.log(dim(`  broker: ${BROKER}`))
console.log()
console.log(hr('QUERY'))
console.log(c('white', args.query))
console.log()

let sessionId = `debug_${Date.now()}`
let fullResponse = ''
let traceId = null

console.log(dim('Sending query and streaming response...'))
console.log()

const res = await fetch(`${BROKER}/query`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body:    JSON.stringify({ message: args.query, sessionId }),
})

if (!res.ok) {
  console.error(c('red', `Broker returned HTTP ${res.status}`))
  process.exit(1)
}

// Stream SSE — collect status + response tokens
const reader  = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''

process.stdout.write(c('green', 'Atlas: '))
while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buf += decoder.decode(value, { stream: true })
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    try {
      const evt = JSON.parse(line.slice(6))
      if (evt.type === 'token')  { process.stdout.write(evt.token); fullResponse += evt.token }
      if (evt.type === 'status') { process.stdout.write(dim(`\n[${evt.message}] `)) }
      if (evt.type === 'done')   { sessionId = evt.sessionId ?? sessionId; traceId = null }
    } catch { /* skip malformed */ }
  }
}
process.stdout.write('\n\n')

// ---------------------------------------------------------------------------
// Step 2: Fetch the latest trace
// ---------------------------------------------------------------------------
// Small delay to ensure the trace file was written (fire-and-forget setImmediate)
await new Promise(r => setTimeout(r, 300))

const listRes  = await fetch(`${BROKER}/traces`)
const traceList = await listRes.json()

if (!traceList.length) {
  console.error(c('red', 'No traces found — is BROKER running with tracing enabled?'))
  process.exit(1)
}

const latest = traceList[0]
const traceRes = await fetch(`${BROKER}/traces/${latest.id}`)
const trace    = await traceRes.json()

// ---------------------------------------------------------------------------
// Step 3: Print
// ---------------------------------------------------------------------------

if (args.raw) {
  console.log(JSON.stringify(trace, null, 2))
  process.exit(0)
}

console.log(hr('TRACE SUMMARY'))
console.log(`  ${bold('Trace ID:')}   ${c('dim', latest.id)}`)
console.log(`  ${bold('Duration:')}   ${c('yellow', `${trace.durationMs ?? '?'} ms`)}`)
console.log(`  ${bold('Session:')}    ${c('dim', trace.sessionId)}`)
console.log()

const stagesToShow = args.stage
  ? trace.stages.filter(s => s.name === args.stage || s.name.startsWith(args.stage))
  : trace.stages

for (const stg of stagesToShow) {
  const { name, data, ts } = stg
  const elapsed = ts - new Date(trace.startedAt).getTime()

  console.log(hr(`${c('cyan', name.toUpperCase())}  ${dim(`+${elapsed}ms`)}`))

  switch (true) {

    // ── CONTEXT ──────────────────────────────────────────────────────────
    case name === 'context': {
      console.log(`  ${bold('History turns:')} ${data.historyLength}`)
      console.log(`  ${bold('User profile:')}  ${data.contextSummary?.split('\n')[0] ?? dim('(none)')}`)
      if (data.history?.length) {
        const last = data.history.slice(-3)
        console.log(`  ${bold('Recent history:')}`)
        for (const h of last) {
          console.log(`    ${dim(h.role + ':')} ${trunc(h.content, 120)}`)
        }
      }
      break
    }

    // ── DISPATCHER ───────────────────────────────────────────────────────
    case name === 'dispatcher': {
      if (data.directResponse) {
        console.log(`  ${c('yellow', 'Direct response — no LLM routing call')}`)
        break
      }
      console.log(`  ${bold('Model:')}     ${c('yellow', data.model ?? '?')}`)
      console.log(`  ${bold('Duration:')}  ${data.durationMs ?? '?'} ms`)
      console.log()
      console.log(`  ${bold('── Prompt input (sent to dispatcher LLM):')}}`)
      console.log(trunc(data.promptInput, 900).split('\n').map(l => '    ' + l).join('\n'))
      console.log()
      console.log(`  ${bold('── Raw LLM output (before parsing):')}}`)
      console.log(trunc(data.rawLlmOutput, 600).split('\n').map(l => '    ' + l).join('\n'))
      console.log()
      console.log(`  ${bold('── Parsed job ticket:')}}`)
      console.log(`    domains:  ${c('green', JSON.stringify(data.jobTicket?.domains))}`)
      console.log(`    parallel: ${data.jobTicket?.parallel}`)
      console.log(`    urgency:  ${data.jobTicket?.urgency}`)
      console.log(`    intent:   ${data.jobTicket?.intent}`)
      if (data.jobTicket?.instructions) {
        for (const [d, instr] of Object.entries(data.jobTicket.instructions)) {
          console.log(`    instr[${c('cyan', d)}]: ${trunc(instr, 200)}`)
        }
      }
      break
    }

    // ── AGENT:* ──────────────────────────────────────────────────────────
    case name.startsWith('agent:'): {
      const domain = name.slice(6)
      console.log(`  ${bold('Domain:')}    ${c('magenta', domain)}`)
      console.log(`  ${bold('Tool:')}      ${c('yellow', data.tool ?? '?')}`)
      console.log(`  ${bold('Duration:')}  ${data.durationMs ?? '?'} ms`)
      console.log(`  ${bold('Args:')}      ${JSON.stringify(data.args)}`)
      if (data.error) {
        console.log(`  ${c('red', '✖ ERROR:')} ${data.error}`)
        break
      }
      console.log()
      console.log(`  ${bold('── Raw MCP result (before parseAgentResult):')}}`)
      const rawText = data.rawMcpResult?.content?.[0]?.text ?? JSON.stringify(data.rawMcpResult)
      console.log(trunc(rawText, 800).split('\n').map(l => '    ' + l).join('\n'))
      console.log()
      console.log(`  ${bold('── Parsed AgentResult:')}}`)
      console.log(`    success:     ${data.parsedResult?.success}`)
      console.log(`    itemCount:   ${data.parsedResult?.itemCount ?? 0}`)
      console.log(`    foundNothing:${data.parsedResult?.foundNothing}`)
      console.log(`    summaryPreview:`)
      console.log(trunc(data.parsedResult?.summaryPreview, 600).split('\n').map(l => '      ' + l).join('\n'))
      if (data.retried) {
        console.log(`  ${c('yellow', '⟳ RETRIED')} with simplified query`)
        console.log(`    tried: ${JSON.stringify(data.triedQueries)}`)
      }
      break
    }

    // ── VOICE ────────────────────────────────────────────────────────────
    case name === 'voice': {
      console.log(`  ${bold('Model:')}     ${c('yellow', data.model ?? '?')}`)
      console.log(`  ${bold('Duration:')}  ${data.durationMs ?? '?'} ms`)
      console.log()
      console.log(`  ${bold('── System prompt (first 400 chars):')}}`)
      console.log(trunc(data.systemPrompt, 400).split('\n').map(l => '    ' + l).join('\n'))
      console.log()
      console.log(`  ${bold('── Voice input (full buildVoiceInput output — THIS IS WHAT THE LLM SEES):')}}`)
      console.log(trunc(data.voiceInput, 2000).split('\n').map(l => '    ' + l).join('\n'))
      console.log()
      console.log(`  ${bold('── Full response:')}}`)
      console.log(trunc(data.fullResponse, 800).split('\n').map(l => '    ' + l).join('\n'))
      break
    }

    // ── ERROR ────────────────────────────────────────────────────────────
    case name === 'error': {
      console.log(`  ${c('red', '✖ PIPELINE ERROR:')} ${data.message}`)
      if (data.stack) console.log(dim(data.stack.split('\n').slice(0, 5).join('\n')))
      break
    }

    default: {
      console.log('  ' + JSON.stringify(data, null, 2).split('\n').join('\n  '))
    }
  }

  console.log()
}

console.log(hr())
console.log(dim(`  Trace saved as: data/traces/${latest.id}.json`))
console.log(dim(`  Full JSON:      GET ${BROKER}/traces/${latest.id}`))
console.log()
