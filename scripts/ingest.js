/**
 * scripts/ingest.js — Document ingestion CLI (v2)
 *
 * Thin CLI wrapper around scripts/_ingest-lib.mjs.
 * All ingest logic lives in the shared library so watch-ingest.js can reuse it.
 *
 * Usage:
 *   node scripts/ingest.js --dir data/sample-docs/
 *   node scripts/ingest.js --dir data/sample-docs/research/ --corpus research
 *   node scripts/ingest.js --file path/to/file.md --corpus research
 *   node scripts/ingest.js --dir ... --force   # re-ingest even if hash unchanged
 *   node scripts/ingest.js --dir ... --no-summary
 *   node scripts/ingest.js --dir ... --no-copy
 */

import 'dotenv/config'
import path from 'path'
import { ingestFile, collectFiles, closePool, KNOWN_DOMAINS } from './_ingest-lib.mjs'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs () {
  const args = process.argv.slice(2)
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
  return {
    file:      get('--file'),
    dir:       get('--dir'),
    domain:    get('--domain'),
    corpus:    get('--corpus'),
    force:     args.includes('--force'),
    noSummary: args.includes('--no-summary'),
    noCopy:    args.includes('--no-copy'),
  }
}

function inferCorpusFromPath (filePath) {
  const parent = path.basename(path.dirname(filePath))
  return KNOWN_DOMAINS.has(parent) ? parent : null
}

async function main () {
  const { file, dir, domain, corpus, force, noSummary, noCopy } = parseArgs()
  const requestedCorpus = corpus ?? domain ?? null

  if (!file && !dir) {
    console.error('Usage: node scripts/ingest.js --dir <path> [--corpus <name>] [--force] [--no-summary] [--no-copy]')
    console.error('       node scripts/ingest.js --file <path> [--corpus <name>] [--force]')
    console.error('       node scripts/ingest.js --dir <path> [--domain <name>]   # legacy alias for --corpus')
    process.exit(1)
  }

  if (domain && !corpus) {
    console.warn('[ingest] --domain is a legacy alias; prefer --corpus')
  }

  let files = []
  if (file) {
    const targetCorpus = requestedCorpus ?? inferCorpusFromPath(file)
    if (!targetCorpus) {
      console.error('[ingest] --corpus required for standalone files when it cannot be inferred from the parent directory')
      process.exit(1)
    }
    files.push({ filePath: file, corpus: targetCorpus })
  } else {
    files = collectFiles(dir, requestedCorpus).map(({ filePath, domain: discoveredCorpus }) => ({
      filePath,
      corpus: discoveredCorpus,
    }))
    if (files.some(f => !f.corpus)) {
      console.error('[ingest] could not infer corpus for all files — use named subdirs or --corpus')
      process.exit(1)
    }
  }

  if (noSummary) console.log('[ingest] --no-summary: skipping LLM summary generation')
  if (noCopy)    console.log('[ingest] --no-copy: skipping managed artifact storage')
  if (requestedCorpus) console.log(`[ingest] target corpus=${requestedCorpus}`)
  console.log(`[ingest] found ${files.length} file(s) to process${force ? ' (--force)' : ''}`)

  let totalChunks = 0, skipped = 0, errors = 0

  for (const { filePath, corpus: targetCorpus } of files) {
    try {
      const result = await ingestFile(filePath, targetCorpus, { force, noSummary, noCopy, corpus: targetCorpus })
      if (result.skipped) skipped++
      else totalChunks += result.chunks
    } catch (err) {
      console.error(`[ingest] ERROR on ${path.basename(filePath)}: ${err.message}`)
      errors++
    }
  }

  console.log(`\n[ingest] done - ${totalChunks} chunks stored, ${skipped} skipped (unchanged), ${errors} errors`)
  await closePool()
}

main().catch(err => {
  console.error('[ingest] fatal:', err.message)
  process.exit(1)
})
