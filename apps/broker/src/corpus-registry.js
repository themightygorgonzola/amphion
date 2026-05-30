/**
 * apps/broker/src/corpus-registry.js — Corpus Registry
 *
 * Loads the corpora table from PostgreSQL and exposes helpers used by:
 *   - dispatcher.js   (auto-generate domain definitions block in prompt)
 *   - agent-runner.js (corpus scope injection into ReAct system prompt)
 *
 * Cached after first load. Call refresh() to reload (e.g. after INSERT).
 *
 * Bespoke domains (comms, proposals, recall, artifacts, finance) are NOT in
 * the corpora table — they are action/output agents with their own logic.
 * The registry only covers knowledge-retrieval domains.
 */

import pg from 'pg'

const { Pool } = pg

let _pool = null
function getPool () {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER     ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max:      2,
    })
    _pool.on('error', err => process.stderr.write(`[corpus-registry] pg error: ${err.message}\n`))
  }
  return _pool
}

/** @type {Map<string, CorpusEntry> | null} */
let _cache = null

/**
 * @typedef {Object} CorpusEntry
 * @property {string} domain
 * @property {string} display_name
 * @property {string} agent_type          — 'statutes' | 'documents' | ...
 * @property {string} dispatcher_description
 * @property {string} scope_notes         — what IS in this corpus
 * @property {string} not_in_corpus       — what is NOT in this corpus
 * @property {boolean} is_active
 */

/**
 * Load registry from DB (cached).
 * @returns {Promise<Map<string, CorpusEntry>>}
 */
export async function loadRegistry () {
  if (_cache) return _cache

  try {
    const pool = getPool()
    const { rows } = await pool.query(
      `SELECT domain, display_name, agent_type, dispatcher_description,
              scope_notes, not_in_corpus, is_active
       FROM corpora
       WHERE is_active = true
       ORDER BY domain`
    )
    _cache = new Map(rows.map(r => [r.domain, r]))
    console.log(`[corpus-registry] loaded ${_cache.size} active corpora: ${[..._cache.keys()].join(', ')}`)
  } catch (err) {
    console.warn(`[corpus-registry] could not load from DB (${err.message}) — using empty registry`)
    _cache = new Map()
  }

  return _cache
}

/** Force reload on next access (call after inserting a new corpus row). */
export function refreshRegistry () {
  _cache = null
}

/**
 * Get one corpus entry by domain.
 * Returns null if not in registry (e.g. bespoke domains like comms, recall).
 *
 * @param {string} domain
 * @returns {CorpusEntry | null}
 */
export async function getCorpus (domain) {
  const reg = await loadRegistry()
  return reg.get(domain) ?? null
}

/**
 * Build the scope injection block for a specific domain's ReAct system prompt.
 * Tells the model what IS and IS NOT in the corpus before step 1.
 *
 * @param {string} domain
 * @returns {Promise<string>}   — empty string if domain not in registry
 */
export async function buildScopeBlock (domain) {
  const entry = await getCorpus(domain)
  if (!entry) return ''

  const lines = [
    `## Corpus Scope: ${entry.display_name}`,
    ``,
    `IN THIS CORPUS: ${entry.scope_notes}`,
  ]

  if (entry.not_in_corpus) {
    lines.push(``)
    lines.push(`NOT IN THIS CORPUS: ${entry.not_in_corpus}`)
    lines.push(`If the query asks about something in the "NOT IN THIS CORPUS" list, say so immediately rather than retrying searches that will not find it.`)
  }

  return lines.join('\n')
}
