/**
 * scripts/stage-watch.js — Staging inbox watcher
 *
 * Watches data/staging/inbox/ for new files. When one lands:
 *   1. Reads the companion .meta.json sidecar (if present) for corpus, source_url, etc.
 *   2. Registers the file in staged_files SQLite table (status = 'pending')
 *   3. Runs the scanner (_scanner.mjs) — status = 'scanning'
 *   4. On PASS: moves file to data/staging/review/ for held learn batches — status = 'review'
 *      or to data/staging/approved/ — status = 'approved'
 *      On FAIL: moves file to data/staging/rejected/ — status = 'rejected'
 *
 * Sidecar convention:
 *   Inbox contains two files per submission:
 *     {uuid}-{filename}           ← the actual file
 *     {uuid}-{filename}.meta.json ← optional JSON: { corpus, sourceUrl, sourceType, submittedBy, metadata, learnPlanId, holdForReview }
 *
 *   The sidecar is read then deleted. Only the data file moves to approved/.
 *
 * watch-ingest.js then picks the file up from approved/ and ingests it.
 * After ingestion it calls markStagedIngested(sourcePath) → status = 'ingested'.
 *
 * Usage:
 *   node scripts/stage-watch.js
 *   node scripts/stage-watch.js --no-startup-scan   # skip initial processing of existing inbox files
 *
 * Trusted sources (notespace, rcw, sample-docs) bypass this entirely — they
 * go directly to watch-ingest.js. Only externally-sourced content uses staging.
 */

import 'dotenv/config'
import fs   from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { fileURLToPath } from 'url'
import { scan } from './_scanner.mjs'
import { registerStagedFile, updateStagedStatus } from '../apps/broker/src/db.js'
import { initDb } from '../apps/broker/src/db.js'

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const AMPHION_ROOT = path.resolve(__dirname, '..')

const INBOX_DIR    = path.join(AMPHION_ROOT, 'data', 'staging', 'inbox')
const REVIEW_DIR   = path.join(AMPHION_ROOT, 'data', 'staging', 'review')
const APPROVED_DIR = path.join(AMPHION_ROOT, 'data', 'staging', 'approved')
const REJECTED_DIR = path.join(AMPHION_ROOT, 'data', 'staging', 'rejected')

// Ensure dirs exist
for (const dir of [INBOX_DIR, REVIEW_DIR, APPROVED_DIR, REJECTED_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// ---------------------------------------------------------------------------
// Sidecar helpers
// ---------------------------------------------------------------------------

/**
 * Try to read {filePath}.meta.json. Returns {} if missing or invalid.
 * @param {string} filePath
 * @returns {{ corpus?, domain?, sourceUrl?, sourceType?, submittedBy?, metadata?, learnPlanId?, holdForReview? }}
 */
function readSidecar (filePath) {
  const sidecarPath = filePath + '.meta.json'
  if (!fs.existsSync(sidecarPath)) return {}
  try {
    const raw = fs.readFileSync(sidecarPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function deleteSidecar (filePath) {
  const sidecarPath = filePath + '.meta.json'
  try { fs.unlinkSync(sidecarPath) } catch { /* already gone */ }
}

function readFlag (value) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return Boolean(value)
}

// ---------------------------------------------------------------------------
// Process one file from inbox
// ---------------------------------------------------------------------------

/**
 * Extract the base UUID and original filename from the inbox entry name.
 * Convention: {uuid}-{original-filename}  (UUID is 36 chars)
 */
function parseInboxName (basename) {
  const uuidRe = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(.+)$/i
  const m = basename.match(uuidRe)
  if (m) return { uuid: m[1], filename: m[2] }
  // No UUID prefix — generate one now (files dropped in manually)
  return { uuid: randomUUID(), filename: basename }
}

async function processInboxFile (inboxPath) {
  if (!fs.existsSync(inboxPath)) return

  const basename = path.basename(inboxPath)

  // Skip sidecar files — they're processed alongside their data file
  if (basename.endsWith('.meta.json')) return

  const { uuid, filename } = parseInboxName(basename)
  const sidecar = readSidecar(inboxPath)

  const corpus      = sidecar.corpus      ?? sidecar.domain ?? null
  const sourceUrl   = sidecar.sourceUrl   ?? null
  const sourceType  = sidecar.sourceType  ?? 'upload'
  const submittedBy = sidecar.submittedBy ?? 'default'
  const metadata    = sidecar.metadata    ?? {}
  const learnPlanId = sidecar.learnPlanId ?? metadata.learnPlanId ?? null
  const holdForReview = readFlag(sidecar.holdForReview ?? metadata.holdForReview ?? learnPlanId)

  console.log(`[stage] processing: ${filename} (uuid=${uuid}, corpus=${corpus ?? 'unset'}, type=${sourceType}${holdForReview ? ', hold=review' : ''})`)

  // Register in SQLite — ON CONFLICT DO NOTHING so double-registration from
  // broker's POST /stage is silently idempotent
  registerStagedFile({ id: uuid, filename, inboxPath, sourceUrl, sourceType, corpus, domain: sidecar.domain ?? corpus, learnPlanId, submittedBy, metadata })

  // Scan
  updateStagedStatus(uuid, 'scanning')
  const result = await scan(inboxPath)

  if (result.pass) {
    const targetDir = holdForReview ? REVIEW_DIR : APPROVED_DIR
    const targetPath = path.join(targetDir, basename)
    try {
      fs.renameSync(inboxPath, targetPath)
    } catch {
      // Cross-device rename (e.g. different volume) — fall back to copy+delete
      fs.copyFileSync(inboxPath, targetPath)
      fs.unlinkSync(inboxPath)
    }
    deleteSidecar(inboxPath)

    const now = new Date().toISOString()
    if (holdForReview) {
      updateStagedStatus(uuid, 'review', {
        scanResult: 'pass',
        scanNotes:  'scan passed; awaiting learn-plan approval',
        reviewPath: targetPath,
        approvedPath: null,
      })
      console.log(`[stage] REVIEW → ${path.basename(targetPath)}  corpus=${corpus ?? 'unset'} learnPlan=${learnPlanId ?? 'none'}`)
    } else {
      updateStagedStatus(uuid, 'approved', {
        scanResult:   'pass',
        reviewPath:   null,
        approvedPath: targetPath,
        approvedAt:   now,
      })
      console.log(`[stage] APPROVED → ${path.basename(targetPath)}  corpus=${corpus ?? 'unset'}`)
    }
  } else {
    // Move to rejected/
    const rejectedPath = path.join(REJECTED_DIR, basename)
    try {
      fs.renameSync(inboxPath, rejectedPath)
    } catch {
      fs.copyFileSync(inboxPath, rejectedPath)
      fs.unlinkSync(inboxPath)
    }
    deleteSidecar(inboxPath)

    updateStagedStatus(uuid, 'rejected', {
      scanResult: 'fail',
      scanNotes:  result.reason ?? 'scan failed',
    })
    console.warn(`[stage] REJECTED → ${path.basename(rejectedPath)}  reason: ${result.reason}`)
  }
}

// ---------------------------------------------------------------------------
// Startup scan — process anything already in inbox (from offline period)
// ---------------------------------------------------------------------------

async function startupScan () {
  console.log('[stage] startup scan of inbox...')
  let files
  try {
    files = fs.readdirSync(INBOX_DIR)
  } catch {
    return
  }

  const dataFiles = files.filter(f => !f.endsWith('.meta.json'))
  if (dataFiles.length === 0) {
    console.log('[stage] inbox empty')
    return
  }

  console.log(`[stage] ${dataFiles.length} file(s) in inbox`)
  for (const f of dataFiles) {
    await processInboxFile(path.join(INBOX_DIR, f))
  }
}

// ---------------------------------------------------------------------------
// File watcher — debounced to avoid partial-write races
// ---------------------------------------------------------------------------

const _pending = new Map()   // filePath → timer
const DEBOUNCE_MS = 1500

function queueProcess (filePath) {
  const existing = _pending.get(filePath)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    _pending.delete(filePath)
    try {
      await processInboxFile(filePath)
    } catch (err) {
      console.error(`[stage] error processing ${path.basename(filePath)}: ${err.message}`)
    }
  }, DEBOUNCE_MS)

  _pending.set(filePath, timer)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main () {
  const args = process.argv.slice(2)
  const noStartupScan = args.includes('--no-startup-scan')

  await initDb()

  if (!noStartupScan) {
    await startupScan()
  }

  console.log(`[stage] watching inbox: ${INBOX_DIR}`)

  fs.watch(INBOX_DIR, { recursive: false }, (eventType, filename) => {
    if (!filename) return
    if (filename.endsWith('.meta.json')) return // handled alongside its data file

    const filePath = path.join(INBOX_DIR, filename)

    // Skip delete events
    if (!fs.existsSync(filePath)) return

    queueProcess(filePath)
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[stage] shutting down...')
    for (const timer of _pending.values()) clearTimeout(timer)
    process.exit(0)
  }
  process.on('SIGINT',  shutdown)
  process.on('SIGTERM', shutdown)

  console.log('[stage] ready — waiting for files in inbox/')
}

main().catch(err => {
  console.error('[stage] fatal:', err.message)
  process.exit(1)
})
