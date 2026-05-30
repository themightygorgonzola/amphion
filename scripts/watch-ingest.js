/**
 * scripts/watch-ingest.js — Auto-ingest watcher
 *
 * Watches one or more directories for file changes and automatically
 * ingests new or modified files into the corpus. Handles deletes too.
 *
 * Configuration (set in .env):
 *   WATCH_DIRS=../notespace/RESEARCH:research,./data/cad:cad
 *
 *   Format: comma-separated pairs of  <absolute-or-relative-path>:<corpus>
 *
 * Usage:
 *   node scripts/watch-ingest.js
 *   node scripts/watch-ingest.js --no-summary   # skip LLM summary on ingest
 *   node scripts/watch-ingest.js --no-startup-scan  # skip the initial full scan
 *
 * Behavior:
 *   1. On startup: full scan of all WATCH_DIRS (catches anything added while
 *      the watcher was offline). Skips unchanged files via hash check.
 *   2. On file create/change: debounces 2s, then ingest.
 *   3. On file delete: removes the resource and all its chunks from the DB.
 *   4. Only processes VALID_EXTS (.md, .txt). Other files are silently ignored.
 *
 * Signals:
 *   SIGINT / SIGTERM — graceful shutdown (closes PG pool)
 */

import 'dotenv/config'
import fs   from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  ingestFile, collectFiles, closePool,
  getExistingResource, getPool,
  VALID_EXTS,
} from './_ingest-lib.mjs'
import { getStagedFileByPath, initDb, markStagedIngested } from '../apps/broker/src/db.js'

const __dirname    = path.dirname(fileURLToPath(import.meta.url))
const APPROVED_DIR = path.resolve(__dirname, '..', 'data', 'staging', 'approved')

// ---------------------------------------------------------------------------
// Parse WATCH_DIRS env var (optional — approved/ is always watched)
// ---------------------------------------------------------------------------
function parseWatchDirs () {
  const raw = (process.env.WATCH_DIRS ?? '').trim()
  if (!raw) {
    // WATCH_DIRS is optional. data/staging/approved/ is always added in main().
    return []
  }

  return raw.split(',').map(entry => {
    const colonIdx = entry.lastIndexOf(':')
    if (colonIdx <= 0) {
      console.error(`[watch] invalid WATCH_DIRS entry (missing corpus): "${entry}"`)
      process.exit(1)
    }
    const dir    = path.resolve(entry.slice(0, colonIdx).trim())
    const corpus = entry.slice(colonIdx + 1).trim()
    if (!corpus) {
      console.error(`[watch] empty corpus in WATCH_DIRS entry: "${entry}"`)
      process.exit(1)
    }
    if (!fs.existsSync(dir)) {
      console.warn(`[watch] directory does not exist (will watch when created): ${dir}`)
    }
    // owned:true — user manages this dir; index in place, no artifact copy
    return { dir, corpus, owned: true }
  })
}

// ---------------------------------------------------------------------------
// Debounce queue — avoid double-ingesting on rapid saves
// ---------------------------------------------------------------------------
const _pending = new Map()   // filePath → { timer, corpus }
const DEBOUNCE_MS = 2000

function resolveTargetCorpus (filePath, fallbackCorpus) {
  const staged = getStagedFileByPath(path.resolve(filePath))
  return staged?.corpus ?? staged?.domain ?? fallbackCorpus
}

function queueIngest (filePath, corpus, opts) {
  const existing = _pending.get(filePath)
  if (existing) clearTimeout(existing.timer)

  const timer = setTimeout(async () => {
    _pending.delete(filePath)
    try {
      const targetCorpus = resolveTargetCorpus(filePath, corpus)
      const result = await ingestFile(filePath, targetCorpus, { ...opts, corpus: targetCorpus })
      if (result.skipped) {
        console.log(`[watch] unchanged: ${path.basename(filePath)}`)
      } else if (result.reason === 'unsupported') {
        // silently ignore
      } else {
        console.log(`[watch] ingested: ${path.basename(filePath)} (${result.chunks} chunks, corpus=${targetCorpus})`)
        // If this file came through staging, mark it as ingested
        markStagedIngested(path.resolve(filePath))
      }
    } catch (err) {
      console.error(`[watch] ingest failed for ${path.basename(filePath)}: ${err.message}`)
    }
  }, DEBOUNCE_MS)

  _pending.set(filePath, { timer, corpus })
}

// ---------------------------------------------------------------------------
// Handle deletes — remove the indexed resource and its chunks.
// ---------------------------------------------------------------------------
async function handleDelete (filePath, corpus) {
  const absPath = path.resolve(filePath)
  const corpusSlug = resolveTargetCorpus(absPath, corpus)
  try {
    const existing = await getExistingResource(absPath, corpusSlug)
    if (!existing) return  // wasn't indexed, nothing to do

    const pool = getPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('DELETE FROM chunks WHERE resource_id = $1', [existing.id])
      await client.query('DELETE FROM resources WHERE id = $1', [existing.id])
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    console.log(`[watch] removed: ${path.basename(filePath)} (resource_id=${existing.id})`)
  } catch (err) {
    console.error(`[watch] delete cleanup failed for ${path.basename(filePath)}: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------
// Startup full scan — catch files added while watcher was offline
// ---------------------------------------------------------------------------
async function startupScan (watchDirs, opts) {
  console.log('[watch] startup scan starting...')
  let total = 0, ingested = 0, skipped = 0, errors = 0

  for (const { dir, corpus, owned } of watchDirs) {
    if (!fs.existsSync(dir)) continue
    const files = collectFiles(dir, corpus)
    total += files.length
    // noCopy:true for user-owned dirs — don't mirror files into data/artifacts/
    const entryOpts = { ...opts, noCopy: owned }
    for (const { filePath, domain: discoveredCorpus } of files) {
      try {
        const targetCorpus = resolveTargetCorpus(filePath, discoveredCorpus)
        const result = await ingestFile(filePath, targetCorpus, { ...entryOpts, corpus: targetCorpus })
        if (result.skipped) skipped++
        else if (result.reason === 'unsupported') { /* ignore */ }
        else ingested++
      } catch (err) {
        console.error(`[watch] scan error on ${path.basename(filePath)}: ${err.message}`)
        errors++
      }
    }
  }

  console.log(`[watch] startup scan done — ${total} files, ${ingested} ingested, ${skipped} unchanged, ${errors} errors`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  const args = process.argv.slice(2)
  const noSummary       = args.includes('--no-summary')
  const noStartupScan   = args.includes('--no-startup-scan')

  await initDb()

  const watchDirs = parseWatchDirs()
  const ingestOpts = { noSummary }

  // Always watch staging/approved/ — corpus comes from staged_files lookup,
  // falling back to 'research'. Files here have already passed the scanner.
  // owned:false — staging files have no home yet; artifact copy is appropriate
  const approvedEntry = { dir: APPROVED_DIR, corpus: 'research', owned: false }
  if (!watchDirs.some(w => path.resolve(w.dir) === APPROVED_DIR)) {
    watchDirs.push(approvedEntry)
  }

  console.log('[watch] watching:')
  for (const { dir, corpus } of watchDirs) {
    console.log(`  ${dir}  →  corpus: ${corpus}`)
  }

  // Startup full scan
  if (!noStartupScan) {
    await startupScan(watchDirs, ingestOpts)
  }

  // Start watchers
  for (const { dir, corpus, owned } of watchDirs) {
    if (!fs.existsSync(dir)) {
      console.warn(`[watch] skipping watcher (dir not found): ${dir}`)
      continue
    }

    const entryOpts = { ...ingestOpts, noCopy: owned }
    fs.watch(dir, { recursive: true }, async (eventType, filename) => {
      if (!filename) return

      const ext = path.extname(filename).toLowerCase()
      if (!VALID_EXTS.has(ext)) return

      const filePath = path.join(dir, filename)

      // Distinguish create/change from delete
      if (!fs.existsSync(filePath)) {
        await handleDelete(filePath, corpus)
        return
      }

      queueIngest(filePath, corpus, entryOpts)
    })

    console.log(`[watch] watching: ${dir}`)
  }

  console.log('[watch] ready — press Ctrl+C to stop')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[watch] shutting down...')
    for (const { timer } of _pending.values()) clearTimeout(timer)
    await closePool()
    process.exit(0)
  }

  process.on('SIGINT',  shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(err => {
  console.error('[watch] fatal:', err.message)
  process.exit(1)
})
