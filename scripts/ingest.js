/**
 * ingest.js — Document ingestion pipeline
 *
 * Reads .md and .txt files, chunks text, embeds via Ollama, upserts to pgvector.
 * Domain is inferred from the immediate parent directory name, or set via --domain.
 *
 * Usage:
 *   node scripts/ingest.js --dir data/sample-docs/
 *   node scripts/ingest.js --dir data/sample-docs/research/ --domain research
 *   node scripts/ingest.js --file data/sample-docs/legal/nda_review_notes.md --domain legal
 *
 * Idempotent: re-running updates existing chunks (ON CONFLICT source_path, chunk_index).
 */

import fs   from 'fs'
import path from 'path'
import pg   from 'pg'

// ---------------------------------------------------------------------------
// Config — read .env manually (dotenv not guaranteed in scripts dir)
// ---------------------------------------------------------------------------
function loadEnv () {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const OLLAMA_HOST   = process.env.OLLAMA_HOST        ?? 'http://localhost:11434'
const EMBED_MODEL   = process.env.OLLAMA_MODEL_EMBED  ?? 'nomic-embed-text'
const CHUNK_SIZE    = 2000  // characters (~500 tokens for nomic-embed-text)
const CHUNK_OVERLAP = 200   // character overlap between consecutive chunks
const VALID_EXTS    = new Set(['.md', '.txt'])
const KNOWN_DOMAINS = new Set(['research', 'finance', 'legal', 'comms', 'proposals'])

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------
const pool = new pg.Pool({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     parseInt(process.env.PGPORT ?? '5432', 10),
  database: process.env.PGDATABASE ?? 'amphion',
  user:     process.env.PGUSER     ?? 'amphion',
  password: process.env.PGPASSWORD ?? 'changeme',
  max:      3,
})

// ---------------------------------------------------------------------------
// Ollama embed
// ---------------------------------------------------------------------------
async function embed (text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!res.ok) throw new Error(`[embed] ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const vec = data?.embeddings?.[0] ?? data?.embedding
  if (!vec) throw new Error('[embed] no embeddings in response')
  return vec
}

// ---------------------------------------------------------------------------
// Chunker — paragraph-aware with overlap
// ---------------------------------------------------------------------------
function chunkText (text) {
  const paragraphs = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  const chunks = []
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim())
      // Overlap: carry the tail of the previous chunk into the next
      const tail = current.slice(-CHUNK_OVERLAP)
      current = tail + '\n\n' + para
    } else {
      current = current ? current + '\n\n' + para : para
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// ---------------------------------------------------------------------------
// Upsert one chunk to pgvector
// ---------------------------------------------------------------------------
async function upsertChunk ({ domain, sourceType, sourcePath, title, chunkIndex, content, metadata, embedding }) {
  const vectorStr = `[${embedding.join(',')}]`
  await pool.query(`
    INSERT INTO knowledge_items
      (domain, source_type, source_path, title, chunk_index, content, metadata, embedding)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)
    ON CONFLICT (source_path, chunk_index)
    DO UPDATE SET
      domain      = EXCLUDED.domain,
      title       = EXCLUDED.title,
      content     = EXCLUDED.content,
      metadata    = EXCLUDED.metadata,
      embedding   = EXCLUDED.embedding,
      created_at  = NOW()
  `, [domain, sourceType, sourcePath, title, chunkIndex, content, JSON.stringify(metadata), vectorStr])
}

// ---------------------------------------------------------------------------
// Ingest a single file
// ---------------------------------------------------------------------------
async function ingestFile (filePath, domain) {
  const ext = path.extname(filePath).toLowerCase()
  if (!VALID_EXTS.has(ext)) {
    console.log(`[ingest] skip ${filePath} (unsupported type ${ext})`)
    return 0
  }

  const raw    = fs.readFileSync(filePath, 'utf8')
  const chunks = chunkText(raw)

  // Title: first heading line, or filename without extension
  const headingMatch = raw.match(/^#+\s+(.+)/m)
  const title = headingMatch?.[1]?.trim() ?? path.basename(filePath, ext)

  const sourcePath = path.resolve(filePath)
  const metadata   = { file: path.basename(filePath), ingestedAt: new Date().toISOString() }

  console.log(`[ingest] ${path.basename(filePath)} -> domain=${domain}, ${chunks.length} chunks`)

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} — embedding...`)
    const embedding = await embed(chunks[i])
    await upsertChunk({ domain, sourceType: 'document', sourcePath, title, chunkIndex: i, content: chunks[i], metadata, embedding })
    process.stdout.write(' saved\n')
  }
  return chunks.length
}

// ---------------------------------------------------------------------------
// Collect files from a directory tree
// ---------------------------------------------------------------------------
function collectFiles (dirPath, defaultDomain) {
  const results = []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const subDomain = KNOWN_DOMAINS.has(entry.name) ? entry.name : defaultDomain
      results.push(...collectFiles(full, subDomain))
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (VALID_EXTS.has(ext)) results.push({ filePath: full, domain: defaultDomain })
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs () {
  const args = process.argv.slice(2)
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
  return { file: get('--file'), dir: get('--dir'), domain: get('--domain') }
}

async function main () {
  const { file, dir, domain } = parseArgs()

  if (!file && !dir) {
    console.error('[ingest] usage: node scripts/ingest.js --dir <path> [--domain <domain>]')
    console.error('                node scripts/ingest.js --file <path> --domain <domain>')
    process.exit(1)
  }

  let files = []

  if (file) {
    const d = domain ?? (KNOWN_DOMAINS.has(path.basename(path.dirname(file))) ? path.basename(path.dirname(file)) : null)
    if (!d) { console.error('[ingest] --domain required (could not infer from path)'); process.exit(1) }
    files.push({ filePath: file, domain: d })
  } else {
    files = collectFiles(dir, domain ?? null)
    if (files.some(f => !f.domain)) {
      console.error('[ingest] could not infer domain for all files — use named subdirectories or pass --domain')
      process.exit(1)
    }
  }

  console.log(`[ingest] found ${files.length} file(s) to process`)
  let totalChunks = 0, errors = 0

  for (const { filePath, domain: d } of files) {
    try {
      totalChunks += await ingestFile(filePath, d)
    } catch (err) {
      console.error(`[ingest] ERROR on ${filePath}: ${err.message}`)
      errors++
    }
  }

  await pool.end()
  console.log(`\n[ingest] done — ${totalChunks} chunks stored, ${errors} errors`)
}

main().catch(err => { console.error('[ingest] fatal:', err.message); process.exit(1) })
