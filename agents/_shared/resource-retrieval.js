import path from 'path'
import pg from 'pg'

const { Pool } = pg

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const EMBED_MODEL = process.env.OLLAMA_MODEL_EMBED ?? 'nomic-embed-text'

let _pool = null

export function getResourcePool () {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max:      5,
    })
    _pool.on('error', err => process.stderr.write(`[resource-retrieval] pg error: ${err.message}\n`))
  }
  return _pool
}

export async function embedText (text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!res.ok) throw new Error(`[embed] ${res.status}`)
  const data = await res.json()
  const vec = data?.embeddings?.[0] ?? data?.embedding
  if (!vec) throw new Error('[embed] no vector returned')
  return vec
}

export function rrfMerge (semanticRows, keywordRows, keyField = 'chunk_id', k = 60) {
  const scores = new Map()
  const add = rows => rows.forEach((row, i) => {
    const key = String(row[keyField] ?? row.id ?? `${row.resource_id}:${row.chunk_index}`)
    if (!scores.has(key)) scores.set(key, { row, rrf: 0 })
    scores.get(key).rrf += 1 / (k + i + 1)
  })
  add(semanticRows)
  add(keywordRows)
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ row, rrf }) => ({ ...row, rrf_score: rrf }))
}

function parseNullableInt (value) {
  if (value == null || value === '') return null
  const parsed = parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function normalizeScope (value) {
  const normalized = `${value ?? ''}`.trim()
  return normalized || null
}

function buildFilters ({ corpus = null, resourceType = null, scope = null } = {}, startIndex = 1, aliases = { corpus: 'co', resource: 'r' }) {
  const clauses = []
  const values = []
  let idx = startIndex

  if (`${corpus ?? ''}`.trim()) {
    clauses.push(`(${aliases.corpus}.slug = $${idx} OR ${aliases.corpus}.domain = $${idx})`)
    values.push(corpus)
    idx += 1
  }

  if (`${resourceType ?? ''}`.trim()) {
    clauses.push(`${aliases.resource}.type = $${idx}`)
    values.push(resourceType)
    idx += 1
  }

  const normalizedScope = normalizeScope(scope)
  if (normalizedScope) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM resource_workspaces rw
      JOIN workspaces ws ON ws.id = rw.workspace_id
      WHERE rw.resource_id = ${aliases.resource}.id
        AND (ws.slug = $${idx} OR ws.id::text = $${idx})
    )`)
    values.push(normalizedScope)
    idx += 1
  }

  return {
    clause: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    values,
    nextIndex: idx,
  }
}

function normalizeSectionPath (sectionPath, sectionHeader = null) {
  if (Array.isArray(sectionPath)) return sectionPath.filter(Boolean)
  if (typeof sectionPath === 'string' && sectionPath.trim()) {
    return sectionPath
      .replace(/^\{/, '')
      .replace(/\}$/, '')
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
  }
  return sectionHeader ? [sectionHeader] : []
}

function fallbackFilename (row) {
  const base = row.stored_path ?? row.source_ref ?? row.title ?? ''
  if (!base) return row.title ?? 'resource'
  return path.basename(base)
}

export function formatResourceRow (row) {
  const legacyDocumentId = parseNullableInt(row.legacy_document_id ?? row.legacy_document_id_text)
  const legacyArtifactId = parseNullableInt(row.legacy_artifact_id ?? row.legacy_artifact_id_text)
  const corpus = row.corpus ?? row.domain ?? null
  const domain = row.domain ?? row.corpus ?? null

  return {
    resource_id:    row.resource_id,
    id:             row.resource_id,
    document_id:    legacyDocumentId ?? row.resource_id,
    doc_id:         legacyDocumentId ?? row.resource_id,
    artifact_id:    legacyArtifactId,
    title:          row.title ?? null,
    filename:       fallbackFilename(row),
    domain,
    corpus,
    doc_type:       row.resource_type,
    type:           row.resource_type,
    resource_type:  row.resource_type,
    summary:        row.summary ?? null,
    description:    row.summary ?? null,
    source_path:    row.stored_path ?? row.source_ref ?? null,
    source_ref:     row.source_ref ?? null,
    stored_path:    row.stored_path ?? null,
    mime_type:      row.mime_type ?? null,
    size_bytes:     row.size_bytes != null ? Number(row.size_bytes) : null,
    chunk_count:    Number(row.chunk_count ?? 0),
    metadata:       row.metadata ?? {},
    created_at:     row.created_at ?? null,
    updated_at:     row.updated_at ?? null,
  }
}

export function formatChunkRow (row) {
  const resource = formatResourceRow(row)
  return {
    chunk_id:       row.chunk_id,
    resource_id:    row.resource_id,
    document_id:    resource.document_id,
    doc_id:         resource.doc_id,
    artifact_id:    resource.artifact_id,
    chunk_index:    Number(row.chunk_index ?? 0),
    section_header: row.section_header ?? null,
    section_path:   normalizeSectionPath(row.section_path, row.section_header ?? null),
    content:        row.content ?? '',
    title:          resource.title,
    filename:       resource.filename,
    domain:         resource.domain,
    corpus:         resource.corpus,
    doc_type:       resource.doc_type,
    type:           resource.type,
    resource_type:  resource.resource_type,
    source_path:    resource.source_path,
    source_ref:     resource.source_ref,
    stored_path:    resource.stored_path,
    mime_type:      resource.mime_type,
    size_bytes:     resource.size_bytes,
    metadata:       resource.metadata,
    start_line:     row.start_line ?? null,
    end_line:       row.end_line ?? null,
    char_start:     row.char_start ?? null,
    char_end:       row.char_end ?? null,
    rrf_score:      Number(row.rrf_score ?? 0),
    is_neighbor:    Boolean(row.is_neighbor),
  }
}

async function selectSummaryRows ({ query, corpus = null, resourceType = null, scope = null, k = 5 }) {
  const pool = getResourcePool()
  const embedding = await embedText(query)
  const vec = `[${embedding.join(',')}]`

  const semFilters = buildFilters({ corpus, resourceType, scope }, 2)
  const semParams = [vec, ...semFilters.values, k * 2]
  const semLimitParam = semParams.length
  const kwFilters = buildFilters({ corpus, resourceType, scope }, 2)
  const kwParams = [query, ...kwFilters.values, k * 2]
  const kwLimitParam = kwParams.length

  const [semResult, kwResult] = await Promise.all([
    pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             r.type AS resource_type,
             r.summary,
             r.source_ref,
             r.stored_path,
             r.mime_type,
             r.size_bytes,
             r.metadata,
             r.created_at,
             r.updated_at,
             COALESCE(co.slug, co.domain) AS corpus,
             co.domain,
             COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
             NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
             NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
             1 - (r.summary_embedding <=> $1::vector) AS score
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS chunk_count
        FROM chunks ch
        WHERE ch.resource_id = r.id
      ) chunk_counts ON TRUE
      WHERE r.summary_embedding IS NOT NULL${semFilters.clause}
      ORDER BY r.summary_embedding <=> $1::vector
      LIMIT $${semLimitParam}
    `, semParams),
    pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             r.type AS resource_type,
             r.summary,
             r.source_ref,
             r.stored_path,
             r.mime_type,
             r.size_bytes,
             r.metadata,
             r.created_at,
             r.updated_at,
             COALESCE(co.slug, co.domain) AS corpus,
             co.domain,
             COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
             NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
             NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
             ts_rank(
               to_tsvector('english', coalesce(r.title, '') || ' ' || coalesce(r.summary, '') || ' ' || coalesce(r.source_ref, '')),
               plainto_tsquery('english', $1)
             ) AS score
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS chunk_count
        FROM chunks ch
        WHERE ch.resource_id = r.id
      ) chunk_counts ON TRUE
      WHERE to_tsvector('english', coalesce(r.title, '') || ' ' || coalesce(r.summary, '') || ' ' || coalesce(r.source_ref, '')) @@ plainto_tsquery('english', $1)${kwFilters.clause}
      ORDER BY score DESC, r.updated_at DESC
      LIMIT $${kwLimitParam}
    `, kwParams),
  ])

  return rrfMerge(semResult.rows, kwResult.rows, 'resource_id').slice(0, k)
}

export async function searchResourceSummaries ({ query, corpus = null, resourceType = null, scope = null, k = 5 }) {
  const rows = await selectSummaryRows({ query, corpus, resourceType, scope, k })
  return rows.map(row => ({
    ...formatResourceRow(row),
    rrf_score: parseFloat(Number(row.rrf_score ?? 0).toFixed(4)),
  }))
}

export async function searchResourceChunks ({ query, corpus = null, resourceType = null, scope = null, k = 6, neighbors = true }) {
  const pool = getResourcePool()
  const embedding = await embedText(query)
  const vec = `[${embedding.join(',')}]`

  const semFilters = buildFilters({ corpus, resourceType, scope }, 2)
  const semParams = [vec, ...semFilters.values, k * 3]
  const semLimitParam = semParams.length
  const kwFilters = buildFilters({ corpus, resourceType, scope }, 2)
  const kwParams = [query, ...kwFilters.values, k * 3]
  const kwLimitParam = kwParams.length

  const [semResult, kwResult] = await Promise.all([
    pool.query(`
      SELECT ch.id AS chunk_id,
             ch.resource_id,
             ch.chunk_index,
             ch.section_header,
             COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
             ch.content,
             ch.start_line,
             ch.end_line,
             ch.char_start,
             ch.char_end,
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
             1 - (ch.embedding <=> $1::vector) AS score
      FROM chunks ch
      JOIN resources r ON r.id = ch.resource_id
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE ch.embedding IS NOT NULL${semFilters.clause}
      ORDER BY ch.embedding <=> $1::vector
      LIMIT $${semLimitParam}
    `, semParams),
    pool.query(`
      SELECT ch.id AS chunk_id,
             ch.resource_id,
             ch.chunk_index,
             ch.section_header,
             COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
             ch.content,
             ch.start_line,
             ch.end_line,
             ch.char_start,
             ch.char_end,
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
             ts_rank(ch.content_tsv, plainto_tsquery('english', $1)) AS score
      FROM chunks ch
      JOIN resources r ON r.id = ch.resource_id
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE ch.content_tsv @@ plainto_tsquery('english', $1)${kwFilters.clause}
      ORDER BY score DESC, ch.chunk_index ASC
      LIMIT $${kwLimitParam}
    `, kwParams),
  ])

  let merged = rrfMerge(semResult.rows, kwResult.rows, 'chunk_id').slice(0, k)

  if (neighbors && merged.length > 0) {
    const seen = new Set(merged.map(row => `${row.resource_id}:${row.chunk_index}`))
    const neighborPairs = []

    for (const row of merged) {
      for (const offset of [-1, 1]) {
        const neighborIndex = Number(row.chunk_index ?? 0) + offset
        const key = `${row.resource_id}:${neighborIndex}`
        if (neighborIndex >= 0 && !seen.has(key)) {
          seen.add(key)
          neighborPairs.push({ resourceId: row.resource_id, chunkIndex: neighborIndex })
        }
      }
    }

    if (neighborPairs.length > 0) {
      const placeholders = neighborPairs.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2})`).join(', ')
      const params = neighborPairs.flatMap(pair => [pair.resourceId, pair.chunkIndex])
      const { rows } = await pool.query(`
        SELECT ch.id AS chunk_id,
               ch.resource_id,
               ch.chunk_index,
               ch.section_header,
               COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
               ch.content,
               ch.start_line,
               ch.end_line,
               ch.char_start,
               ch.char_end,
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
               0::float AS rrf_score,
               true AS is_neighbor
        FROM chunks ch
        JOIN resources r ON r.id = ch.resource_id
        LEFT JOIN corpora co ON co.id = r.corpus_id
        WHERE (ch.resource_id, ch.chunk_index) IN (${placeholders})
        ORDER BY ch.resource_id, ch.chunk_index
      `, params)

      merged = [...merged, ...rows]
    }
  }

  return merged.map(row => ({
    ...formatChunkRow(row),
    rrf_score: parseFloat(Number(row.rrf_score ?? 0).toFixed(4)),
  }))
}

export async function loadResourceRecord ({ resourceId = null, title = null, corpus = null, resourceType = null } = {}) {
  const pool = getResourcePool()
  let resourceRow = null

  if (resourceId != null) {
    const id = parseInt(resourceId, 10)
    if (!Number.isNaN(id)) {
      const filters = buildFilters({ corpus, resourceType }, 2)
      const params = [id, ...filters.values]
      const { rows } = await pool.query(`
        SELECT r.id AS resource_id,
               r.title,
               r.type AS resource_type,
               r.summary,
               r.source_ref,
               r.stored_path,
               r.mime_type,
               r.size_bytes,
               r.metadata,
               r.created_at,
               r.updated_at,
               COALESCE(co.slug, co.domain) AS corpus,
               co.domain,
               COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
               NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
               NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id
        FROM resources r
        LEFT JOIN corpora co ON co.id = r.corpus_id
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int AS chunk_count
          FROM chunks ch
          WHERE ch.resource_id = r.id
        ) chunk_counts ON TRUE
        WHERE r.id = $1${filters.clause}
        LIMIT 1
      `, params)
      resourceRow = rows[0] ?? null
    }
  } else if (`${title ?? ''}`.trim()) {
    const filters = buildFilters({ corpus, resourceType }, 2)
    const params = [`%${title}%`, ...filters.values]
    const { rows } = await pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             r.type AS resource_type,
             r.summary,
             r.source_ref,
             r.stored_path,
             r.mime_type,
             r.size_bytes,
             r.metadata,
             r.created_at,
             r.updated_at,
             COALESCE(co.slug, co.domain) AS corpus,
             co.domain,
             COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
             NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
             NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS chunk_count
        FROM chunks ch
        WHERE ch.resource_id = r.id
      ) chunk_counts ON TRUE
      WHERE r.title ILIKE $1${filters.clause}
      ORDER BY r.updated_at DESC
      LIMIT 1
    `, params)
    resourceRow = rows[0] ?? null
  }

  if (!resourceRow) return null

  const { rows: chunkRows } = await pool.query(`
    SELECT ch.id AS chunk_id,
           ch.resource_id,
           ch.chunk_index,
           ch.section_header,
           COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
           ch.content,
           ch.start_line,
           ch.end_line,
           ch.char_start,
           ch.char_end,
           $2::text AS title,
           $3::text AS resource_type,
           $4::text AS source_ref,
           $5::text AS stored_path,
           $6::text AS mime_type,
           $7::bigint AS size_bytes,
           $8::jsonb AS metadata,
           $9::text AS corpus,
           $10::text AS domain,
           $11::text AS legacy_document_id,
           $12::text AS legacy_artifact_id,
           0::float AS rrf_score,
           false AS is_neighbor
    FROM chunks ch
    WHERE ch.resource_id = $1
    ORDER BY ch.chunk_index ASC
  `, [
    resourceRow.resource_id,
    resourceRow.title,
    resourceRow.resource_type,
    resourceRow.source_ref,
    resourceRow.stored_path,
    resourceRow.mime_type,
    resourceRow.size_bytes,
    JSON.stringify(resourceRow.metadata ?? {}),
    resourceRow.corpus,
    resourceRow.domain,
    resourceRow.legacy_document_id,
    resourceRow.legacy_artifact_id,
  ])

  return {
    resource: formatResourceRow(resourceRow),
    chunks: chunkRows.map(formatChunkRow),
  }
}

export async function listCorpusStats () {
  const pool = getResourcePool()
  const { rows } = await pool.query(`
    SELECT COALESCE(co.slug, co.domain) AS corpus,
           co.domain,
           COUNT(DISTINCT r.id)::int AS resources,
           COUNT(ch.id)::int AS chunks
    FROM corpora co
    LEFT JOIN resources r ON r.corpus_id = co.id
    LEFT JOIN chunks ch ON ch.resource_id = r.id
    GROUP BY COALESCE(co.slug, co.domain), co.domain
    ORDER BY COALESCE(co.slug, co.domain)
  `)
  return rows.map(row => ({
    corpus: row.corpus,
    domain: row.domain,
    resources: Number(row.resources ?? 0),
    chunks: Number(row.chunks ?? 0),
  }))
}

export async function findResourcesByReference ({ query, corpus = null, resourceType = null, scope = null, k = 10 }) {
  const pool = getResourcePool()
  const like = `%${query}%`
  const filters = buildFilters({ corpus, resourceType, scope }, 3)
  const params = [query, like, ...filters.values, k]
  const limitParam = params.length

  const { rows } = await pool.query(`
    SELECT r.id AS resource_id,
           r.title,
           r.type AS resource_type,
           r.summary,
           r.source_ref,
           r.stored_path,
           r.mime_type,
           r.size_bytes,
           r.metadata,
           r.created_at,
           r.updated_at,
           COALESCE(co.slug, co.domain) AS corpus,
           co.domain,
           COALESCE(chunk_counts.chunk_count, 0) AS chunk_count,
           NULLIF(r.metadata->>'legacy_document_id', '') AS legacy_document_id,
           NULLIF(r.metadata->>'legacy_artifact_id', '') AS legacy_artifact_id,
           ts_rank(
             to_tsvector('english', coalesce(r.title, '') || ' ' || coalesce(r.summary, '') || ' ' || coalesce(r.source_ref, '') || ' ' || coalesce(r.stored_path, '')),
             plainto_tsquery('english', $1)
           ) AS score
    FROM resources r
    LEFT JOIN corpora co ON co.id = r.corpus_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS chunk_count
      FROM chunks ch
      WHERE ch.resource_id = r.id
    ) chunk_counts ON TRUE
    WHERE (
      to_tsvector('english', coalesce(r.title, '') || ' ' || coalesce(r.summary, '') || ' ' || coalesce(r.source_ref, '') || ' ' || coalesce(r.stored_path, '')) @@ plainto_tsquery('english', $1)
      OR r.title ILIKE $2
      OR r.source_ref ILIKE $2
      OR coalesce(r.stored_path, '') ILIKE $2
      OR coalesce(r.summary, '') ILIKE $2
    )${filters.clause}
    ORDER BY score DESC, r.updated_at DESC
    LIMIT $${limitParam}
  `, params)

  if (rows.length > 0) {
    return rows.map(row => formatResourceRow(row))
  }

  return await searchResourceSummaries({ query, corpus, resourceType, scope, k })
}

export async function probeCorpusKnowledge ({ query, corpus = null, resourceType = null, scope = null, k = 10 }) {
  const rows = await searchResourceSummaries({ query, corpus, resourceType, scope, k })
  if (rows.length === 0) return []

  const pool = getResourcePool()
  const ids = rows.map(row => row.resource_id)
  const { rows: aggregates } = await pool.query(`
    SELECT ch.resource_id,
           COUNT(*)::int AS section_count,
           array_agg(DISTINCT ch.section_header ORDER BY ch.section_header) FILTER (WHERE ch.section_header IS NOT NULL) AS sections,
           SUM(COALESCE(ch.char_end, length(ch.content)) - COALESCE(ch.char_start, 0))::bigint AS total_chars
    FROM chunks ch
    WHERE ch.resource_id = ANY($1)
    GROUP BY ch.resource_id
  `, [ids])

  const aggregateMap = new Map(aggregates.map(row => [Number(row.resource_id), row]))
  return rows.map(row => {
    const aggregate = aggregateMap.get(Number(row.resource_id))
    return {
      ...row,
      section_count: Number(aggregate?.section_count ?? 0),
      sections: (aggregate?.sections ?? []).filter(Boolean).slice(0, 30),
      approx_words: Math.round(Number(aggregate?.total_chars ?? 0) / 5),
    }
  })
}