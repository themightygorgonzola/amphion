/**
 * scripts/reembed.js — Re-embed stale chunks and resource summaries
 *
 * Finds every chunk and document whose embed_model column doesn't match
 * the current OLLAMA_MODEL_EMBED, re-generates the embedding, and updates
 * the row. Run this after changing OLLAMA_MODEL_EMBED in .env to keep
 * the vector space consistent.
 *
 * Usage:
 *   node scripts/reembed.js                   # re-embed everything stale
 *   node scripts/reembed.js --corpus legal    # one corpus/domain only
 *   node scripts/reembed.js --domain legal    # legacy alias for --corpus
 *   node scripts/reembed.js --dry-run         # show what would be re-embedded, no writes
 *   node scripts/reembed.js --batch 50        # process N chunks at a time (default 20)
 */

import 'dotenv/config'
import { embed, EMBED_MODEL, getPool, closePool } from './_ingest-lib.mjs'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs () {
  const args = process.argv.slice(2)
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
  return {
    corpus:  get('--corpus') ?? get('--domain') ?? null,
    batch:   parseInt(get('--batch') ?? '20', 10),
    dryRun:  args.includes('--dry-run'),
  }
}

// ---------------------------------------------------------------------------
// Re-embed chunks
// ---------------------------------------------------------------------------
async function reembedChunks (corpus, batchSize, dryRun) {
  const pool = getPool()

  const countSql = corpus
    ? `SELECT COUNT(*)
       FROM chunks c
       JOIN resources r ON r.id = c.resource_id
       LEFT JOIN corpora co ON co.id = r.corpus_id
       WHERE c.embed_model != $1 AND (co.domain = $2 OR co.slug = $2)`
    : `SELECT COUNT(*) FROM chunks WHERE embed_model != $1`
  const countParams = corpus ? [EMBED_MODEL, corpus] : [EMBED_MODEL]
  const { rows: [{ count }] } = await pool.query(countSql, countParams)
  const total = parseInt(count, 10)

  console.log(`[reembed] chunks stale: ${total} (current model: ${EMBED_MODEL})`)
  if (total === 0 || dryRun) return { total, processed: 0, errors: 0 }

  let offset = 0, processed = 0, errors = 0

  while (offset < total) {
    const fetchSql = corpus
      ? `SELECT c.id, c.content
         FROM chunks c
         JOIN resources r ON r.id = c.resource_id
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE c.embed_model != $1 AND (co.domain = $2 OR co.slug = $2)
         ORDER BY c.id LIMIT $3 OFFSET $4`
      : `SELECT id, content FROM chunks WHERE embed_model != $1 ORDER BY id LIMIT $2 OFFSET $3`
    const fetchParams = corpus
      ? [EMBED_MODEL, corpus, batchSize, offset]
      : [EMBED_MODEL, batchSize, offset]

    const { rows } = await pool.query(fetchSql, fetchParams)
    if (!rows.length) break

    for (const row of rows) {
      try {
        process.stdout.write(`  chunk ${row.id} embedding...`)
        const vec = await embed(row.content)
        const vecStr = `[${vec.join(',')}]`
        await pool.query(
          `UPDATE chunks SET embedding = $1::vector, embed_model = $2 WHERE id = $3`,
          [vecStr, EMBED_MODEL, row.id]
        )
        process.stdout.write(' ok\n')
        processed++
      } catch (err) {
        process.stdout.write(` FAILED (${err.message})\n`)
        errors++
      }
    }

    offset += batchSize
  }

  return { total, processed, errors }
}

// ---------------------------------------------------------------------------
// Re-embed resource summaries
// ---------------------------------------------------------------------------
async function reembedResources (corpus, batchSize, dryRun) {
  const pool = getPool()

  const countSql = corpus
    ? `SELECT COUNT(*)
       FROM resources r
       LEFT JOIN corpora co ON co.id = r.corpus_id
       WHERE r.embed_model != $1 AND (co.domain = $2 OR co.slug = $2) AND r.summary_embedding IS NOT NULL`
    : `SELECT COUNT(*) FROM resources WHERE embed_model != $1 AND summary_embedding IS NOT NULL`
  const countParams = corpus ? [EMBED_MODEL, corpus] : [EMBED_MODEL]
  const { rows: [{ count }] } = await pool.query(countSql, countParams)
  const total = parseInt(count, 10)

  console.log(`[reembed] resource summaries stale: ${total}`)
  if (total === 0 || dryRun) return { total, processed: 0, errors: 0 }

  let offset = 0, processed = 0, errors = 0

  while (offset < total) {
    const fetchSql = corpus
      ? `SELECT r.id, COALESCE(r.summary, r.title) AS text
         FROM resources r
         LEFT JOIN corpora co ON co.id = r.corpus_id
         WHERE r.embed_model != $1 AND (co.domain = $2 OR co.slug = $2) AND r.summary_embedding IS NOT NULL
         ORDER BY r.id LIMIT $3 OFFSET $4`
      : `SELECT id, COALESCE(summary, title) AS text FROM resources
         WHERE embed_model != $1 AND summary_embedding IS NOT NULL ORDER BY id LIMIT $2 OFFSET $3`
    const fetchParams = corpus ? [EMBED_MODEL, corpus, batchSize, offset] : [EMBED_MODEL, batchSize, offset]
    const { rows } = await pool.query(fetchSql, fetchParams)
    if (!rows.length) break

    for (const row of rows) {
      try {
        process.stdout.write(`  resource ${row.id} summary embedding...`)
        const vec = await embed(row.text)
        const vecStr = `[${vec.join(',')}]`
        await pool.query(
          `UPDATE resources SET summary_embedding = $1::vector, embed_model = $2 WHERE id = $3`,
          [vecStr, EMBED_MODEL, row.id]
        )
        process.stdout.write(' ok\n')
        processed++
      } catch (err) {
        process.stdout.write(` FAILED (${err.message})\n`)
        errors++
      }
    }

    offset += batchSize
  }

  return { total, processed, errors }
}

// ---------------------------------------------------------------------------
// Startup health check — warn if multiple embed models are in use
// ---------------------------------------------------------------------------
async function reportModelMix () {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT embed_model, COUNT(*) FROM chunks GROUP BY embed_model ORDER BY count DESC`)
  if (rows.length > 1) {
    console.warn('[reembed] WARNING: multiple embed models found in chunks table:')
    for (const r of rows) console.warn(`  ${r.embed_model}: ${r.count} chunks`)
  } else if (rows.length === 1) {
    console.log(`[reembed] all chunks use embed_model: ${rows[0].embed_model}`)
  }
}

async function main () {
  const { corpus, batch, dryRun } = parseArgs()

  console.log(`[reembed] current OLLAMA_MODEL_EMBED = ${EMBED_MODEL}`)
  if (dryRun) console.log('[reembed] --dry-run: no writes will be made')
  if (corpus) console.log(`[reembed] scoped to corpus: ${corpus}`)

  await reportModelMix()

  const chunkResult = await reembedChunks(corpus, batch, dryRun)
  const resourceResult = await reembedResources(corpus, batch, dryRun)

  console.log('\n[reembed] summary:')
  console.log(`  chunks  — stale: ${chunkResult.total}, processed: ${chunkResult.processed}, errors: ${chunkResult.errors}`)
  console.log(`  resources — stale: ${resourceResult.total}, processed: ${resourceResult.processed}, errors: ${resourceResult.errors}`)

  if (dryRun && (chunkResult.total + resourceResult.total) > 0) {
    console.log('\n[reembed] run without --dry-run to apply changes')
  }

  await closePool()
}

main().catch(err => {
  console.error('[reembed] fatal:', err.message)
  process.exit(1)
})
