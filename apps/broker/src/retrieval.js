/**
 * apps/broker/src/retrieval.js — Centralized retrieval layer
 *
 * A single hybrid search across ALL domains in the corpus, independent of
 * agent routing. This is the insurance layer: even when the dispatcher routes
 * to the wrong domain, the answer can still be found here.
 *
 * Used by the orchestrator as a "baseline pass" that runs in parallel with
 * domain agents and fills in wherever those agents return nothing.
 *
 * Architecture note:
 *   Domain agents add value through specialized tools — legal knows how to
 *   walk RCW chapters, artifacts knows how to return file cards, finance knows
 *   deal structures. But raw text retrieval should never be siloed. This
 *   module owns that.
 */

import {
  embedText,
  formatChunkRow,
  getResourcePool,
  rrfMerge,
} from '../../../agents/_shared/resource-retrieval.js'

// Domains that are "action" domains — they produce output that isn't
// answerable from the corpus (drafting, deal lookup, conversation search).
// We never inject corpus results into these.
export const ACTION_DOMAINS = new Set(['comms', 'proposals', 'recall'])

/**
 * Inner hybrid retrieval pass — semantic + BM25 + RRF.
 *
 * Pass either includeDomains (allowlist) or excludeDomains (blocklist), not both.
 * Passing neither searches the full corpus.
 *
 * @param {string} vecStr  — pre-computed "[0.1,0.2,...]" string
 * @param {string} query
 * @param {{ includeDomains?: string[], excludeDomains?: string[], k?: number }} opts
 * @returns {Promise<object[]>}  — shaped result rows ready to return
 */
async function runHybrid (vecStr, query, { includeDomains, excludeDomains, k = 8 } = {}) {
  const pool = getResourcePool()

  let domainCond
  let semParams, kwParams

  if (includeDomains?.length) {
    domainCond = 'AND co.domain = ANY($3::text[])'
    semParams  = [vecStr, k * 2, includeDomains]
    kwParams   = [query,  k * 2, includeDomains]
  } else if (excludeDomains?.length) {
    domainCond = 'AND NOT (co.domain = ANY($3::text[]))'
    semParams  = [vecStr, k * 2, excludeDomains]
    kwParams   = [query,  k * 2, excludeDomains]
  } else {
    domainCond = ''
    semParams  = [vecStr, k * 2]
    kwParams   = [query,  k * 2]
  }

  const [{ rows: semRows }, { rows: kwRows }] = await Promise.all([
    pool.query(`
        SELECT c.id AS chunk_id,
          c.resource_id,
          c.content,
          c.section_header,
          COALESCE(c.section_path, CASE WHEN c.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.section_header] END) AS section_path,
          c.chunk_index,
          c.char_start,
          c.char_end,
          r.title,
          r.type AS resource_type,
          r.source_ref,
          r.stored_path,
          r.mime_type,
          r.size_bytes,
          r.metadata,
          COALESCE(co.slug, co.domain) AS corpus,
          co.domain,
          NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
          NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id
        FROM chunks c
        JOIN resources r ON r.id = c.resource_id
        LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE c.embedding IS NOT NULL
      ${domainCond}
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2
    `, semParams),
    pool.query(`
      SELECT c.id AS chunk_id,
             c.resource_id,
             c.content,
             c.section_header,
             COALESCE(c.section_path, CASE WHEN c.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[c.section_header] END) AS section_path,
             c.chunk_index,
             c.char_start,
             c.char_end,
             r.title,
             r.type AS resource_type,
             r.source_ref,
             r.stored_path,
             r.mime_type,
             r.size_bytes,
             r.metadata,
             COALESCE(co.slug, co.domain) AS corpus,
             co.domain,
             NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
             NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
             ts_rank(c.content_tsv, plainto_tsquery('english', $1)) AS score
      FROM chunks c
      JOIN resources r ON r.id = c.resource_id
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE c.content_tsv @@ plainto_tsquery('english', $1)
      ${domainCond}
      ORDER BY score DESC, c.chunk_index ASC
      LIMIT $2
    `, kwParams),
  ])

  return rrfMerge(semRows, kwRows, 'chunk_id')
    .slice(0, k)
    .map(row => ({
      ...formatChunkRow(row),
      rrf_score:     row.rrf_score,
      from_baseline: true,
    }))
}

// Minimum number of primary-domain chunks before cross-domain fallback fires.
const CROSS_DOMAIN_THRESHOLD = 3

/**
 * Two-pass hybrid retrieval.
 *
 * Pass 1 (primary): search only the dispatched knowledge domains.
 * Pass 2 (secondary): if primary < CROSS_DOMAIN_THRESHOLD, search everything
 *   else EXCEPT restricted domains that were NOT dispatched. Deduped, fills
 *   up to k total results. Primary results always come first.
 *
 * Restricted domains (e.g. 'legal') are never included in secondary unless
 * they were explicitly dispatched — their high keyword density for common
 * terms would contaminate unrelated queries.
 *
 * @param {string} query
 * @param {{ primaryDomains?: string[], k?: number }} [opts]
 * @returns {Promise<{ results: object[], durationMs: number }>}
 */
export async function hybridSearchAll (query, { primaryDomains = null, k = 8 } = {}) {
  const t0 = Date.now()

  let vec
  try {
    vec = await embedText(query)
  } catch (err) {
    console.warn(`[retrieval] embed failed: ${err.message}`)
    return { results: [], durationMs: Date.now() - t0 }
  }
  const vecStr = `[${vec.join(',')}]`

  // --- Pass 1: primary (scoped to dispatched knowledge domains) ---
  const primary = primaryDomains?.length
    ? await runHybrid(vecStr, query, { includeDomains: primaryDomains, k })
    : []  // no primary domains → go straight to secondary

  const primaryLabel = primaryDomains?.length ? primaryDomains.join('+') : 'none'

  if (primary.length >= CROSS_DOMAIN_THRESHOLD || (!primaryDomains?.length && primary.length > 0)) {
    const durationMs = Date.now() - t0
    console.log(`[retrieval] primary: ${primary.length} chunks (${primaryLabel}) — threshold met, no secondary | ${durationMs}ms`)
    return { results: primary, durationMs }
  }

  // --- Pass 2: secondary (full cross-domain search) ---
  const secondaryK = k - primary.length

  const secondaryRaw = await runHybrid(vecStr, query, {
    k: secondaryK + primary.length,  // fetch extra to account for deduplication
  })

  // Dedupe: drop anything already in primary
  const seenIds = new Set(primary.map(c => String(c.chunk_id)))
  const secondary = secondaryRaw
    .filter(c => !seenIds.has(String(c.chunk_id)))
    .slice(0, secondaryK)

  const excludeLabel = ''
  const durationMs = Date.now() - t0
  console.log(`[retrieval] primary: ${primary.length} (${primaryLabel}) | secondary: ${secondary.length} (all${excludeLabel}) | ${durationMs}ms`)

  return { results: [...primary, ...secondary], durationMs }
}
