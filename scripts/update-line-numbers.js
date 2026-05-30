/**
 * scripts/update-line-numbers.js
 *
 * Populate start_line / end_line for all existing chunks by finding each
 * chunk's content in its source file, without re-embedding.
 *
 * Usage:
 *   node scripts/update-line-numbers.js
 *   node scripts/update-line-numbers.js --corpus legal
 *   node scripts/update-line-numbers.js --domain legal
 */

import fs   from 'fs'
import path from 'path'
import pg   from 'pg'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadEnv () {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const CHUNK_OVERLAP = 200

const pool = new pg.Pool({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     parseInt(process.env.PGPORT ?? '5432', 10),
  database: process.env.PGDATABASE ?? 'amphion',
  user:     process.env.PGUSER     ?? 'amphion',
  password: process.env.PGPASSWORD ?? 'changeme',
  max:      3,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildLineStarts (text) {
  const ls = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') ls.push(i + 1)
  }
  return ls
}

function charToLine (lineStarts, pos) {
  let lo = 0, hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    lineStarts[mid] <= pos ? (lo = mid) : (hi = mid - 1)
  }
  return lo + 1
}

function computeLineNumbers (text, chunks) {
  const lineStarts = buildLineStarts(text)
  let cursor = 0
  for (const chunk of chunks) {
    const probeRaw = chunk.content.slice(0, 80).trim()
    if (!probeRaw) { chunk.startLine = null; chunk.endLine = null; continue }
    const escaped = probeRaw
      .slice(0, 60)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
    const re = new RegExp(escaped)
    const searchFrom = Math.max(0, cursor - CHUNK_OVERLAP - 50)
    const m = text.slice(searchFrom).search(re)
    if (m >= 0) {
      const charStart = searchFrom + m
      chunk.startLine = charToLine(lineStarts, charStart)
      chunk.endLine   = charToLine(lineStarts, charStart + chunk.content.length)
      cursor = charStart + Math.max(1, chunk.content.length - CHUNK_OVERLAP)
    } else {
      chunk.startLine = null
      chunk.endLine   = null
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = process.argv.slice(2)
const corpusFilter = args.includes('--corpus')
  ? args[args.indexOf('--corpus') + 1]
  : (args.includes('--domain') ? args[args.indexOf('--domain') + 1] : null)

const corpusClause = corpusFilter ? `AND (co.domain = '${corpusFilter.replace(/'/g, "''")}' OR co.slug = '${corpusFilter.replace(/'/g, "''")}')` : ''

const { rows: resources } = await pool.query(`
  SELECT r.id AS resource_id, r.title, r.source_ref, r.stored_path
  FROM resources r
  LEFT JOIN corpora co ON co.id = r.corpus_id
  WHERE (r.source_ref IS NOT NULL OR r.stored_path IS NOT NULL) ${corpusClause}
  ORDER BY r.id
`)

console.log(`Processing ${resources.length} resource(s)${corpusFilter ? ` in corpus '${corpusFilter}'` : ''}...`)

let totalUpdated = 0
let totalMissed  = 0

for (const resource of resources) {
  const candidates = [
    resource.source_ref,
    resource.stored_path,
    resource.source_ref ? path.resolve(process.cwd(), resource.source_ref.replace(/^\//, '')) : null,
    resource.stored_path ? path.resolve(process.cwd(), resource.stored_path.replace(/^\//, '')) : null,
  ].filter(Boolean)
  const filePath = candidates.find(p => fs.existsSync(p))

  if (!filePath) {
    console.log(`  skip: ${resource.title} (source not found)`)
    continue
  }

  const text = fs.readFileSync(filePath, 'utf8')
  const { rows: chunks } = await pool.query(
    'SELECT id, chunk_index, content FROM chunks WHERE resource_id = $1 ORDER BY chunk_index ASC',
    [resource.resource_id],
  )

  computeLineNumbers(text, chunks)

  let updated = 0, missed = 0
  for (const chunk of chunks) {
    if (chunk.startLine != null) {
      await pool.query(
        'UPDATE chunks SET start_line = $1, end_line = $2 WHERE id = $3',
        [chunk.startLine, chunk.endLine, chunk.id],
      )
      updated++
    } else {
      missed++
    }
  }
  totalUpdated += updated
  totalMissed  += missed
  console.log(`  ${resource.title}: ${updated} updated, ${missed} missed`)
}

console.log(`\nDone. ${totalUpdated} chunks updated, ${totalMissed} unmatched.`)
await pool.end()
