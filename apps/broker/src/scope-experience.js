import pg from 'pg'

const { Pool } = pg

let scopeExperiencePool = null

function getScopeExperiencePool () {
  if (!scopeExperiencePool) {
    scopeExperiencePool = new Pool({
      host: process.env.PGHOST ?? 'localhost',
      port: parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user: process.env.PGUSER ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max: 5,
    })
    scopeExperiencePool.on('error', err => {
      console.error('[scope-experience] PG pool error:', err.message)
    })
  }
  return scopeExperiencePool
}

function normalizeScopeIdentifier (value) {
  const normalized = `${value ?? ''}`.trim()
  return normalized || null
}

function normalizeResourceIds (resourceIds = []) {
  const unique = new Set()
  for (const value of resourceIds) {
    const numeric = Number.parseInt(`${value ?? ''}`, 10)
    if (Number.isInteger(numeric) && numeric > 0) unique.add(numeric)
  }
  return [...unique]
}

function computeBoost ({ hitCount = 0, lastHitAt = null } = {}) {
  if (!Number.isFinite(hitCount) || hitCount <= 0) return 0

  const ageDays = lastHitAt
    ? Math.max(0, (Date.now() - new Date(lastHitAt).getTime()) / (24 * 60 * 60 * 1000))
    : 0
  const recencyFactor = Math.max(0.15, Math.exp(-ageDays / 30))
  const hitFactor = Math.log2(hitCount + 1)
  return Math.min(0.18, Number((hitFactor * 0.04 * recencyFactor).toFixed(4)))
}

export async function recordScopeResourceHits ({ scope, resourceIds, hitCount = 1 } = {}) {
  const normalizedScope = normalizeScopeIdentifier(scope)
  const normalizedIds = normalizeResourceIds(resourceIds)
  const increment = Math.max(1, Number.parseInt(`${hitCount ?? 1}`, 10) || 1)

  if (!normalizedScope || normalizedIds.length === 0) return []

  const pool = getScopeExperiencePool()
  const { rows } = await pool.query(
    `WITH target_scope AS (
       SELECT id
       FROM workspaces
       WHERE slug = $1 OR id::text = $1
       ORDER BY CASE WHEN slug = $1 THEN 0 ELSE 1 END
       LIMIT 1
     ), target_resources AS (
       SELECT DISTINCT unnest($2::bigint[]) AS resource_id
     )
     INSERT INTO resource_scope_stats (resource_id, workspace_id, hit_count, first_hit_at, last_hit_at, updated_at)
     SELECT tr.resource_id, ts.id, $3, NOW(), NOW(), NOW()
     FROM target_scope ts
     CROSS JOIN target_resources tr
     ON CONFLICT (resource_id, workspace_id) DO UPDATE SET
       hit_count = resource_scope_stats.hit_count + EXCLUDED.hit_count,
       last_hit_at = NOW(),
       updated_at = NOW()
     RETURNING resource_id, workspace_id, hit_count, last_hit_at`,
    [normalizedScope, normalizedIds, increment],
  )

  return rows.map(row => ({
    resourceId: Number(row.resource_id),
    workspaceId: Number(row.workspace_id),
    hitCount: Number(row.hit_count ?? 0),
    lastHitAt: row.last_hit_at,
  }))
}

export async function getScopeExperienceBoosts ({ scope, resourceIds } = {}) {
  const normalizedScope = normalizeScopeIdentifier(scope)
  const normalizedIds = normalizeResourceIds(resourceIds)
  const boosts = new Map()

  if (!normalizedScope || normalizedIds.length === 0) return boosts

  const pool = getScopeExperiencePool()
  const { rows } = await pool.query(
    `WITH target_scope AS (
       SELECT id
       FROM workspaces
       WHERE slug = $1 OR id::text = $1
       ORDER BY CASE WHEN slug = $1 THEN 0 ELSE 1 END
       LIMIT 1
     )
     SELECT rss.resource_id, rss.hit_count, rss.last_hit_at
     FROM resource_scope_stats rss
     JOIN target_scope ts ON ts.id = rss.workspace_id
     WHERE rss.resource_id = ANY($2::bigint[])`,
    [normalizedScope, normalizedIds],
  )

  for (const row of rows) {
    boosts.set(String(row.resource_id), {
      hitCount: Number(row.hit_count ?? 0),
      lastHitAt: row.last_hit_at,
      boost: computeBoost({ hitCount: Number(row.hit_count ?? 0), lastHitAt: row.last_hit_at }),
    })
  }

  return boosts
}

export function applyScopeExperienceBoosts (rows, boostMap) {
  if (!Array.isArray(rows) || rows.length === 0 || !(boostMap instanceof Map) || boostMap.size === 0) return rows

  return rows
    .map(row => {
      const entry = boostMap.get(String(row.resource_id))
      if (!entry?.boost) return row
      return {
        ...row,
        scope_experience_boost: entry.boost,
        rrf_score: Number(((row.rrf_score ?? 0) + entry.boost).toFixed(6)),
      }
    })
    .sort((a, b) => (b.rrf_score ?? 0) - (a.rrf_score ?? 0))
}
