/**
 * scripts/update-char-offsets.js
 *
 * Populate char_start / char_end for all existing chunks by finding each
 * chunk's content in its source file, without re-embedding.
 *
 * Usage:
 *   node scripts/update-char-offsets.js
 *   node scripts/update-char-offsets.js --corpus legal
 *   node scripts/update-char-offsets.js --domain legal
 */

import fs   from 'fs'
import path from 'path'
import pg   from 'pg'

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

function computeCharOffsets (text, chunks) {
  let cursor = 0
  for (const chunk of chunks) {
    const probe = chunk.content.slice(0, 60).trim()
    if (!probe) { chunk.charStart = null; chunk.charEnd = null; continue }
    const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(escaped)
    const searchFrom = Math.max(0, cursor - CHUNK_OVERLAP - 50)
    const m = text.slice(searchFrom).search(re)
    if (m >= 0) {
      chunk.charStart = searchFrom + m
      chunk.charEnd   = Math.min(chunk.charStart + chunk.content.length, text.length)
      cursor = chunk.charStart + Math.max(1, chunk.content.length - CHUNK_OVERLAP)
    } else {
      chunk.charStart = null
      chunk.charEnd   = null
    }
  }
  return chunks
}

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

  computeCharOffsets(text, chunks)

  let updated = 0, missed = 0
  for (const chunk of chunks) {
    if (chunk.charStart != null) {
      await pool.query(
        'UPDATE chunks SET char_start = $1, char_end = $2 WHERE id = $3',
        [chunk.charStart, chunk.charEnd, chunk.id],
      )
      updated++
    } else {
      missed++
    }
  }
  totalUpdated += updated
  totalMissed  += missed
  process.stdout.write(`  ${resource.title}: ${updated}/${chunks.length}\n`)
}

console.log(`\nDone. ${totalUpdated} chunks updated, ${totalMissed} unmatched.`)
await pool.end()
