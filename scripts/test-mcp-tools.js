/**
 * scripts/test-mcp-tools.js
 * Quick smoke test for the canonical MCP resource tools: corpus_list,
 * corpus_stats, recall, find, load, corpus_upsert, and resources_ingest.
 * Run: node scripts/test-mcp-tools.js
 */
import 'dotenv/config'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_PATH = path.resolve(__dirname, '../tools/mcp/amphion-server.js')

// --------------------------------------------------------------------------
// Minimal MCP client — communicates with the server over stdio (JSON-RPC 2.0)
// --------------------------------------------------------------------------

function createMcpClient () {
  const proc = spawn('node', [SERVER_PATH], {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buf = ''
  let msgId = 0
  const pending = new Map()

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      let msg
      try { msg = JSON.parse(t) } catch { continue }
      const p = pending.get(msg.id)
      if (!p) continue
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
    }
  })

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', chunk => {
    const lines = chunk.split('\n').filter(l => l.includes('Error') && !l.includes('ExperimentalWarning'))
    lines.forEach(l => process.stderr.write(`  [server stderr] ${l}\n`))
  })

  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++msgId
    pending.set(id, { resolve, reject })
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }
    }, 30000)
  })

  const close = () => proc.kill()
  return { send, close }
}

function parseToolResult (result) {
  const text = result?.content?.[0]?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function callTool (client, name, args = {}) {
  const result = await client.send('tools/call', { name, arguments: args })
  return parseToolResult(result)
}

function expect (condition, message) {
  if (!condition) throw new Error(message)
}

// --------------------------------------------------------------------------

async function run () {
  console.log('Starting MCP server...')
  const client = createMcpClient()

  await client.send('initialize', { clientInfo: { name: 'test-client', version: '0.1.0' } })
  const { tools } = await client.send('tools/list', {})

  const toolNames = tools.map(t => t.name)
  console.log(`\n✓ Server started — ${toolNames.length} tools: ${toolNames.join(', ')}\n`)

  const required = ['corpus_list', 'corpus_upsert', 'corpus_stats', 'recall', 'find', 'load', 'resources_ingest']
  const missing = required.filter(n => !toolNames.includes(n))
  if (missing.length) {
    console.error(`✗ Missing tools: ${missing.join(', ')}`)
    client.close()
    process.exit(1)
  }
  console.log('✓ Canonical resource tools present\n')

  const corpora = await callTool(client, 'corpus_list')
  console.log(`corpus_list → ${corpora.count} corpora:`)
  corpora.corpora.forEach(c => console.log(`  ${c.domain.padEnd(12)} ${c.agent_type.padEnd(12)} ${c.display_name}`))

  const stats = await callTool(client, 'corpus_stats')
  console.log(`\ncorpus_stats:`)
  stats.stats.forEach(s => console.log(`  ${String(s.corpus).padEnd(16)} resources=${s.resource_count} chunks=${s.chunk_count}`))

  console.log(`\nrecall (topic="Jarvis project budget", corpus="research")...`)
  const search = await callTool(client, 'recall', {
    topic: 'Jarvis project budget',
    corpus: 'research',
    k: 3,
  })
  const searchResults = Array.isArray(search.results) ? search.results : []
  console.log(`  → ${searchResults.length} excerpts returned`)
  searchResults.forEach((r, i) => console.log(`  [${i + 1}] ${String(r.title ?? '').slice(0, 45)} (rrf=${r.rrf_score}) "${String(r.content ?? '').slice(0, 80).replace(/\n/g, ' ')}..."`))

  console.log(`\ncorpus_upsert (adding "copilot-notes" test domain)...`)
  const upsert = await callTool(client, 'corpus_upsert', {
    domain: 'copilot-notes',
    display_name: 'GitHub Copilot Notes',
    agent_type: 'documents',
    dispatcher_description: 'Notes and observations ingested directly by GitHub Copilot',
    scope_notes: 'Notes added by the GitHub Copilot agent during sessions — architecture decisions, observations, and implementation notes.',
    not_in_corpus: 'Not a substitute for formal documentation.',
    is_active: true,
  })
  console.log(`  → ${upsert.ok ? 'OK' : 'FAIL'} — domain=${upsert.corpus?.domain}`)
  expect(upsert.ok, 'corpus_upsert did not report success')

  console.log(`\nresources_ingest (ingest a note into copilot-notes)...`)
  const ingest = await callTool(client, 'resources_ingest', {
    corpus: 'copilot-notes',
    title: 'Resource Migration Cleanup — May 2026',
    resource_type: 'note',
    source_ref: 'copilot:test:resource-migration-cleanup:2026-05-04',
    content: `## Resource Migration Cleanup — May 2026

On May 4 2026, GitHub Copilot performed the last pre-test cleanup pass for Amphion's resource-first architecture.

### What changed
- Runtime reads were already cut over to corpora, resources, and chunks.
- The CLI ingest contract was tightened so corpus is the primary routing term and domain is a compatibility alias.
- The MCP smoke test was updated to validate resources_ingest, recall, find, and load directly.
- The generic archetype agents were re-pointed at the canonical resource-backed implementations instead of keeping their own legacy SQL.

### Canonical path
The canonical read and write path is corpus to resource to chunks.

Compatibility aliases can remain during transition, but the smoke tests should prove the canonical resource tools first.`,
  })
  console.log(`  → ${ingest.ok ? 'OK' : 'FAIL'} — resource_id=${ingest.resource_id} chunks=${ingest.chunk_count} "${ingest.title}"`)
  expect(ingest.ok, 'resources_ingest did not report success')
  expect(`${ingest.resource_id ?? ''}`.trim(), 'resources_ingest did not return a resource_id')

  console.log(`\nrecall (verify ingest — topic="resource migration cleanup canonical resource tools")...`)
  const verify = await callTool(client, 'recall', {
    topic: 'resource migration cleanup canonical resource tools',
    corpus: 'copilot-notes',
    k: 2,
  })
  const verifyResults = Array.isArray(verify.results) ? verify.results : []
  console.log(`  → ${verifyResults.length} excerpts from copilot-notes`)
  verifyResults.forEach((r, i) => console.log(`  [${i + 1}] ${r.title} — "${String(r.content ?? '').slice(0, 100).replace(/\n/g, ' ')}..."`))
  expect(verifyResults.length > 0, 'recall did not return the ingested resource')

  console.log(`\nfind (name="Resource Migration Cleanup", corpus="copilot-notes")...`)
  const found = await callTool(client, 'find', {
    name: 'Resource Migration Cleanup',
    corpus: 'copilot-notes',
    k: 3,
  })
  const foundResources = Array.isArray(found.resources) ? found.resources : []
  console.log(`  → ${foundResources.length} resources returned`)
  foundResources.forEach((r, i) => console.log(`  [${i + 1}] ${r.resource_id} ${r.type} ${r.title}`))
  const resourceId = foundResources.find(r => String(r.resource_id) === String(ingest.resource_id))?.resource_id
    ?? foundResources[0]?.resource_id
  expect(resourceId, 'find did not return the ingested resource')

  console.log(`\nload (resource_id=${resourceId})...`)
  const loaded = await callTool(client, 'load', { resource_id: resourceId, max_chars: 4000 })
  const loadedChunks = Array.isArray(loaded.chunks) ? loaded.chunks : []
  console.log(`  → ${loadedChunks.length} chunks loaded from ${loaded.resource?.title ?? 'unknown resource'}`)
  expect(loaded.resource?.id != null, 'load did not return a resource object')
  expect(loadedChunks.length > 0, 'load did not return any chunks')
  expect(String(loaded.resource?.title ?? '') === String(ingest.title), 'load returned the wrong resource title')
  expect(loadedChunks.some(chunk => String(chunk.content ?? '').trim().length > 0), 'load returned only empty chunks')

  console.log('\n✓ All tests passed')
  client.close()
}

run().catch(err => {
  console.error('Test failed:', err)
  process.exit(1)
})
