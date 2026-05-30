import pg from 'pg'

const { Pool } = pg

let organizationPool = null

function getOrganizationPool () {
  if (!organizationPool) {
    organizationPool = new Pool({
      host: process.env.PGHOST ?? 'localhost',
      port: parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user: process.env.PGUSER ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max: 5,
    })
    organizationPool.on('error', err => {
      console.error('[organization-store] PG pool error:', err.message)
    })
  }
  return organizationPool
}

function slugify (value) {
  return `${value ?? ''}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function clamp01 (value, fallback = 1) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(1, numeric))
}

function normalizeMetadata (value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeLimit (value, fallback = 50, max = 200) {
  const numeric = Number.isFinite(value) ? value : parseInt(`${value ?? fallback}`, 10)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return Math.min(numeric, max)
}

async function resolveScopeId (client, { scopeId = null, scopeSlug = null } = {}) {
  if (scopeId != null) return Number(scopeId)
  if (!`${scopeSlug ?? ''}`.trim()) return null

  const { rows } = await client.query(
    `SELECT id
     FROM workspaces
     WHERE slug = $1
     LIMIT 1`,
    [scopeSlug.trim()],
  )
  if (!rows[0]) throw new Error(`Unknown scope slug: ${scopeSlug}`)
  return rows[0].id
}

async function resolveEntityId (client, { entityId = null, entitySlug = null, entityKind = null } = {}) {
  if (entityId != null) return Number(entityId)
  if (!`${entitySlug ?? ''}`.trim() || !`${entityKind ?? ''}`.trim()) return null

  const { rows } = await client.query(
    `SELECT id
     FROM entities
     WHERE kind = $1 AND slug = $2
     LIMIT 1`,
    [entityKind.trim(), entitySlug.trim()],
  )
  if (!rows[0]) throw new Error(`Unknown entity: ${entityKind}:${entitySlug}`)
  return rows[0].id
}

export async function upsertScope ({
  slug,
  displayName,
  ownerUserId = 'default',
  description = null,
  scopeType = 'scope',
  parentScopeId = null,
  parentScopeSlug = null,
  metadata = {},
  isActive = true,
  closedAt = null,
} = {}) {
  const normalizedSlug = slugify(slug || displayName)
  if (!normalizedSlug) throw new Error('scope slug or displayName is required')
  const normalizedDisplayName = `${displayName ?? slug ?? ''}`.trim() || normalizedSlug

  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedParentId = await resolveScopeId(client, { scopeId: parentScopeId, scopeSlug: parentScopeSlug })
    const { rows } = await client.query(
      `INSERT INTO workspaces
         (slug, display_name, owner_user_id, description, is_active, parent_workspace_id, workspace_type, closed_at, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
       ON CONFLICT (slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         owner_user_id = EXCLUDED.owner_user_id,
         description = COALESCE(EXCLUDED.description, workspaces.description),
         is_active = EXCLUDED.is_active,
         parent_workspace_id = COALESCE(EXCLUDED.parent_workspace_id, workspaces.parent_workspace_id),
         workspace_type = EXCLUDED.workspace_type,
         closed_at = EXCLUDED.closed_at,
         metadata = COALESCE(workspaces.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, slug, display_name, owner_user_id, description, is_active, parent_workspace_id, workspace_type, closed_at, metadata, created_at, updated_at`,
      [
        normalizedSlug,
        normalizedDisplayName,
        ownerUserId,
        description,
        isActive,
        resolvedParentId,
        scopeType,
        closedAt,
        JSON.stringify(normalizeMetadata(metadata)),
      ],
    )
    return rows[0]
  } finally {
    client.release()
  }
}

export async function listScopes ({
  ownerUserId = null,
  parentScopeId = null,
  parentScopeSlug = null,
  includeClosed = false,
  query = null,
  limit = 50,
} = {}) {
  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedParentId = await resolveScopeId(client, { scopeId: parentScopeId, scopeSlug: parentScopeSlug })
    const conditions = []
    const params = []

    if (`${ownerUserId ?? ''}`.trim()) {
      params.push(ownerUserId.trim())
      conditions.push(`w.owner_user_id = $${params.length}`)
    }
    if (resolvedParentId != null) {
      params.push(resolvedParentId)
      conditions.push(`w.parent_workspace_id = $${params.length}`)
    }
    if (!includeClosed) {
      conditions.push(`w.closed_at IS NULL`)
      conditions.push(`w.is_active = true`)
    }
    if (`${query ?? ''}`.trim()) {
      params.push(`%${query.trim()}%`)
      conditions.push(`(w.slug ILIKE $${params.length} OR w.display_name ILIKE $${params.length} OR COALESCE(w.description, '') ILIKE $${params.length})`)
    }

    params.push(normalizeLimit(limit, 50, 200))
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT w.id, w.slug, w.display_name, w.owner_user_id, w.description, w.is_active,
              w.parent_workspace_id, parent.slug AS parent_slug, parent.display_name AS parent_display_name,
              w.workspace_type, w.closed_at, w.metadata, w.created_at, w.updated_at,
              COUNT(DISTINCT rw.resource_id)::int AS resource_count,
              COUNT(DISTINCT e.id)::int AS entity_count
       FROM workspaces w
       LEFT JOIN workspaces parent ON parent.id = w.parent_workspace_id
       LEFT JOIN resource_workspaces rw ON rw.workspace_id = w.id
       LEFT JOIN entities e ON e.home_workspace_id = w.id
       ${whereClause}
       GROUP BY w.id, parent.slug, parent.display_name
       ORDER BY w.updated_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return rows
  } finally {
    client.release()
  }
}

export async function attachResourceToScope ({
  resourceId,
  scopeId = null,
  scopeSlug = null,
  isPrimary = false,
  metadata = {},
} = {}) {
  if (resourceId == null) throw new Error('resourceId is required')

  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const resolvedScopeId = await resolveScopeId(client, { scopeId, scopeSlug })
    if (resolvedScopeId == null) throw new Error('scopeId or scopeSlug is required')

    if (isPrimary) {
      await client.query(
        `UPDATE resource_workspaces
         SET is_primary = false,
             updated_at = NOW()
         WHERE resource_id = $1`,
        [resourceId],
      )
    }

    const { rows } = await client.query(
      `INSERT INTO resource_workspaces (resource_id, workspace_id, is_primary, metadata, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (resource_id, workspace_id) DO UPDATE SET
         is_primary = EXCLUDED.is_primary,
         metadata = COALESCE(resource_workspaces.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, resource_id, workspace_id, is_primary, metadata, created_at, updated_at`,
      [resourceId, resolvedScopeId, isPrimary, JSON.stringify(normalizeMetadata(metadata))],
    )
    await client.query('COMMIT')
    return rows[0]
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function upsertEntity ({
  kind,
  displayName,
  slug = null,
  description = null,
  ownerUserId = 'default',
  homeScopeId = null,
  homeScopeSlug = null,
  metadata = {},
} = {}) {
  const normalizedKind = `${kind ?? ''}`.trim().toLowerCase()
  const normalizedDisplayName = `${displayName ?? ''}`.trim()
  if (!normalizedKind) throw new Error('kind is required')
  if (!normalizedDisplayName) throw new Error('displayName is required')

  const normalizedSlug = slugify(slug || normalizedDisplayName)
  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedHomeScopeId = await resolveScopeId(client, { scopeId: homeScopeId, scopeSlug: homeScopeSlug })
    const { rows: existingRows } = await client.query(
      `SELECT id
       FROM entities
       WHERE kind = $1 AND slug = $2
       LIMIT 1`,
      [normalizedKind, normalizedSlug],
    )

    if (existingRows[0]) {
      const { rows } = await client.query(
        `UPDATE entities
         SET display_name = $2,
             description = COALESCE($3, description),
             owner_user_id = $4,
             home_workspace_id = COALESCE($5, home_workspace_id),
             metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, kind, slug, display_name, description, owner_user_id, home_workspace_id, metadata, created_at, updated_at`,
        [
          existingRows[0].id,
          normalizedDisplayName,
          description,
          ownerUserId,
          resolvedHomeScopeId,
          JSON.stringify(normalizeMetadata(metadata)),
        ],
      )
      return rows[0]
    }

    const { rows } = await client.query(
      `INSERT INTO entities (kind, slug, display_name, description, owner_user_id, home_workspace_id, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())
       RETURNING id, kind, slug, display_name, description, owner_user_id, home_workspace_id, metadata, created_at, updated_at`,
      [
        normalizedKind,
        normalizedSlug,
        normalizedDisplayName,
        description,
        ownerUserId,
        resolvedHomeScopeId,
        JSON.stringify(normalizeMetadata(metadata)),
      ],
    )
    return rows[0]
  } finally {
    client.release()
  }
}

export async function listEntities ({
  kind = null,
  homeScopeId = null,
  homeScopeSlug = null,
  query = null,
  limit = 50,
} = {}) {
  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedHomeScopeId = await resolveScopeId(client, { scopeId: homeScopeId, scopeSlug: homeScopeSlug })
    const conditions = []
    const params = []

    if (`${kind ?? ''}`.trim()) {
      params.push(kind.trim().toLowerCase())
      conditions.push(`e.kind = $${params.length}`)
    }
    if (resolvedHomeScopeId != null) {
      params.push(resolvedHomeScopeId)
      conditions.push(`e.home_workspace_id = $${params.length}`)
    }
    if (`${query ?? ''}`.trim()) {
      params.push(`%${query.trim()}%`)
      conditions.push(`(e.display_name ILIKE $${params.length} OR COALESCE(e.description, '') ILIKE $${params.length})`)
    }

    params.push(normalizeLimit(limit, 50, 200))
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT e.id, e.kind, e.slug, e.display_name, e.description, e.owner_user_id,
              e.home_workspace_id, w.slug AS home_scope_slug, w.display_name AS home_scope_name,
              e.metadata, e.created_at, e.updated_at,
              COUNT(DISTINCT re.resource_id)::int AS resource_count,
              COUNT(DISTINCT el.id)::int AS outgoing_link_count
       FROM entities e
       LEFT JOIN workspaces w ON w.id = e.home_workspace_id
       LEFT JOIN resource_entities re ON re.entity_id = e.id
       LEFT JOIN entity_links el ON el.from_entity_id = e.id
       ${whereClause}
       GROUP BY e.id, w.slug, w.display_name
       ORDER BY e.updated_at DESC
       LIMIT $${params.length}`,
      params,
    )
    return rows
  } finally {
    client.release()
  }
}

export async function attachResourceToEntity ({
  resourceId,
  entityId = null,
  entitySlug = null,
  entityKind = null,
  relationType = 'mentions',
  confidence = 1,
  metadata = {},
} = {}) {
  if (resourceId == null) throw new Error('resourceId is required')

  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedEntityId = await resolveEntityId(client, { entityId, entitySlug, entityKind })
    if (resolvedEntityId == null) throw new Error('entityId or entitySlug plus entityKind is required')

    const { rows } = await client.query(
      `INSERT INTO resource_entities (resource_id, entity_id, relation_type, confidence, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
       ON CONFLICT (resource_id, entity_id, relation_type) DO UPDATE SET
         confidence = EXCLUDED.confidence,
         metadata = COALESCE(resource_entities.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, resource_id, entity_id, relation_type, confidence, metadata, created_at, updated_at`,
      [
        resourceId,
        resolvedEntityId,
        relationType,
        clamp01(confidence),
        JSON.stringify(normalizeMetadata(metadata)),
      ],
    )
    return rows[0]
  } finally {
    client.release()
  }
}

export async function linkEntities ({
  fromEntityId = null,
  fromEntitySlug = null,
  fromEntityKind = null,
  toEntityId = null,
  toEntitySlug = null,
  toEntityKind = null,
  relationType,
  strength = 1,
  sourceResourceId = null,
  metadata = {},
} = {}) {
  if (!`${relationType ?? ''}`.trim()) throw new Error('relationType is required')

  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedFromId = await resolveEntityId(client, { entityId: fromEntityId, entitySlug: fromEntitySlug, entityKind: fromEntityKind })
    const resolvedToId = await resolveEntityId(client, { entityId: toEntityId, entitySlug: toEntitySlug, entityKind: toEntityKind })
    if (resolvedFromId == null) throw new Error('fromEntityId or fromEntitySlug plus fromEntityKind is required')
    if (resolvedToId == null) throw new Error('toEntityId or toEntitySlug plus toEntityKind is required')

    const { rows } = await client.query(
      `INSERT INTO entity_links (from_entity_id, to_entity_id, relation_type, strength, source_resource_id, metadata, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (from_entity_id, to_entity_id, relation_type) DO UPDATE SET
         strength = EXCLUDED.strength,
         source_resource_id = COALESCE(EXCLUDED.source_resource_id, entity_links.source_resource_id),
         metadata = COALESCE(entity_links.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()
       RETURNING id, from_entity_id, to_entity_id, relation_type, strength, source_resource_id, metadata, created_at, updated_at`,
      [
        resolvedFromId,
        resolvedToId,
        relationType,
        clamp01(strength),
        sourceResourceId,
        JSON.stringify(normalizeMetadata(metadata)),
      ],
    )
    return rows[0]
  } finally {
    client.release()
  }
}

export async function getScope (identifier) {
  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedId = await resolveScopeId(client, identifier ?? {})
    if (resolvedId == null) return null
    const { rows } = await client.query(
      `SELECT w.id, w.slug, w.display_name, w.owner_user_id, w.description, w.is_active,
              w.parent_workspace_id, parent.slug AS parent_slug, w.workspace_type, w.closed_at,
              w.metadata, w.created_at, w.updated_at
       FROM workspaces w
       LEFT JOIN workspaces parent ON parent.id = w.parent_workspace_id
       WHERE w.id = $1
       LIMIT 1`,
      [resolvedId],
    )
    return rows[0] ?? null
  } finally {
    client.release()
  }
}

export async function getEntity (identifier) {
  const pool = getOrganizationPool()
  const client = await pool.connect()
  try {
    const resolvedId = await resolveEntityId(client, identifier ?? {})
    if (resolvedId == null) return null
    const { rows } = await client.query(
      `SELECT e.id, e.kind, e.slug, e.display_name, e.description, e.owner_user_id,
              e.home_workspace_id, w.slug AS home_scope_slug, e.metadata, e.created_at, e.updated_at
       FROM entities e
       LEFT JOIN workspaces w ON w.id = e.home_workspace_id
       WHERE e.id = $1
       LIMIT 1`,
      [resolvedId],
    )
    return rows[0] ?? null
  } finally {
    client.release()
  }
}
