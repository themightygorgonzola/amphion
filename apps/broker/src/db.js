/**
 * broker/src/db.js — Database layer
 *
 * Two databases:
 *   node:sqlite (built-in, Node 24+) — conversations + user_context — fast, sync API, zero deps
 *   PostgreSQL (pg)                   — resources/chunks (vector retrieval) — async
 *
 * SQLite is the primary runtime store. PostgreSQL is for RAG queries and
 * is only touched by agents that need semantic search.
 */

import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import path from 'path'
import fs from 'fs'

const { Pool } = pg

// ---------------------------------------------------------------------------
// SQLite — conversations + user_context
// ---------------------------------------------------------------------------

let sqlite = null

function getSqlite () {
  if (!sqlite) throw new Error('SQLite not initialised — call initDb() first')
  return sqlite
}

function initSqlite () {
  const dbPath = path.resolve(process.env.SQLITE_PATH ?? './data/memory.db')

  // Ensure data directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  sqlite = new DatabaseSync(dbPath)

  // WAL mode for better concurrent read performance
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')

  // Create core tables if they don't exist (SQLite-side schema — mirrors PG minus vector)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      domain      TEXT,
      role        TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      metadata    TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS conversations_session_idx
      ON conversations (session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS user_context (
      id                  INTEGER PRIMARY KEY DEFAULT 1,
      display_name        TEXT,
      company             TEXT,
      role                TEXT,
      current_priorities  TEXT,
      active_deals        TEXT,
      key_contacts        TEXT,
      tone_preferences    TEXT,
      context_notes       TEXT,
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      CHECK (id = 1)
    );

    INSERT OR IGNORE INTO user_context (id) VALUES (1);
  `)

  // --- Incremental migrations for existing DBs ---
  // Add user_id column if missing (introduced in 007_add_user_id)
  try {
    sqlite.exec(`ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`)
    console.log('[db] SQLite: migrated conversations — added user_id column')
  } catch { /* column already exists */ }

  // Add workspace_id column if missing (introduced in 009_workspaces)
  try {
    sqlite.exec(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT`)
    console.log('[db] SQLite: migrated conversations — added workspace_id column')
  } catch { /* column already exists */ }

  // Create user_id indexes now that the column is guaranteed to exist
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS conversations_user_idx
      ON conversations (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS conversations_user_session_idx
      ON conversations (user_id, session_id, created_at DESC);
  `)

  // query_log — one row per user query, feeds the self-organizing agent
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT    NOT NULL DEFAULT 'default',
      session_id  TEXT    NOT NULL,
      workspace_id TEXT,
      intent      TEXT,
      domains     TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS query_log_user_idx
      ON query_log (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS query_log_created_idx
      ON query_log (created_at DESC);
  `)

  // staged_files — tracks every externally-sourced file through the quarantine pipeline
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS staged_files (
      id            TEXT    PRIMARY KEY,
      filename      TEXT    NOT NULL,
      inbox_path    TEXT    NOT NULL,
      review_path   TEXT,
      approved_path TEXT,
      source_url    TEXT,
      source_type   TEXT    NOT NULL DEFAULT 'upload',
      corpus        TEXT,
      domain        TEXT,
      learn_plan_id TEXT,
      status        TEXT    NOT NULL DEFAULT 'pending',
      scan_result   TEXT,
      scan_notes    TEXT,
      submitted_by  TEXT    NOT NULL DEFAULT 'default',
      submitted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      approved_at   TEXT,
      ingested_at   TEXT,
      metadata      TEXT
    );
    CREATE INDEX IF NOT EXISTS staged_files_status_idx
      ON staged_files (status);
    CREATE INDEX IF NOT EXISTS staged_files_submitted_idx
      ON staged_files (submitted_at DESC);

    CREATE TABLE IF NOT EXISTS learn_plans (
      id             TEXT    PRIMARY KEY,
      user_id        TEXT    NOT NULL DEFAULT 'default',
      requested_by   TEXT    NOT NULL DEFAULT 'default',
      title          TEXT,
      request        TEXT    NOT NULL,
      status         TEXT    NOT NULL DEFAULT 'draft',
      summary        TEXT,
      findings       TEXT,
      proposal       TEXT,
      metadata       TEXT,
      decision_notes TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      decided_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS learn_plans_status_idx
      ON learn_plans (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS learn_plans_user_idx
      ON learn_plans (user_id, created_at DESC);
  `)

  try {
    sqlite.exec(`ALTER TABLE staged_files ADD COLUMN corpus TEXT`)
    console.log('[db] SQLite: migrated staged_files — added corpus column')
  } catch { /* column already exists */ }
  try {
    sqlite.exec(`ALTER TABLE staged_files ADD COLUMN review_path TEXT`)
    console.log('[db] SQLite: migrated staged_files — added review_path column')
  } catch { /* column already exists */ }
  try {
    sqlite.exec(`ALTER TABLE staged_files ADD COLUMN learn_plan_id TEXT`)
    console.log('[db] SQLite: migrated staged_files — added learn_plan_id column')
  } catch { /* column already exists */ }
  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS staged_files_learn_plan_idx
      ON staged_files (learn_plan_id, submitted_at DESC)
  `)

  // workspace_registry — one row per project/repo under C:\MySoftwareFolder
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_registry (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      path         TEXT NOT NULL,
      description  TEXT,
      language     TEXT,
      build_cmd    TEXT,
      conventions  TEXT,
      key_dirs     TEXT,
      ppm_service  TEXT,
      tags         TEXT,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS workspace_registry_active_idx
      ON workspace_registry (active, name);
  `)

  console.log(`[db] SQLite ready at ${dbPath}`)
}

// ---------------------------------------------------------------------------
// PostgreSQL — pgvector (lazy connection, only needed for RAG queries)
// ---------------------------------------------------------------------------

let pgPool = null

function getPgPool () {
  if (!pgPool) {
    pgPool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER     ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max:      5,
      idleTimeoutMillis: 30000,
    })
    pgPool.on('error', (err) => {
      console.error('[db] PG pool error:', err.message)
    })
  }
  return pgPool
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function initDb () {
  initSqlite()
  // PG pool is lazy — don't force a connection at startup since the container
  // might not be available during local testing without Docker
}

/**
 * Save one turn of conversation history.
 * @param {string} sessionId
 * @param {'user'|'assistant'} role
 * @param {string} content
 * @param {object} [metadata]
 * @param {string} [userId]
 */
export function saveConversationTurn (sessionId, role, content, metadata = {}, userId = 'default', workspaceId = null) {
  const db = getSqlite()
  db.prepare(`
    INSERT INTO conversations (session_id, user_id, workspace_id, role, content, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%f', 'now'))
  `).run(sessionId, userId, workspaceId ?? null, role, content, JSON.stringify(metadata))
}

/**
 * Get recent conversation history for a session.
 * @param {string} sessionId
 * @param {number} [limit=10]
 * @param {string} [userId]
 * @returns {{ role: string, content: string }[]}
 */
export function getRecentHistory (sessionId, limit = 10, userId = 'default') {
  const db = getSqlite()
  const rows = db.prepare(`
    SELECT role, content, metadata
    FROM conversations
    WHERE session_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, userId, limit)
  return rows.reverse().map(r => {
    let meta = {}
    try { meta = JSON.parse(r.metadata ?? '{}') } catch {}
    return { role: r.role, content: r.content, metadata: meta }
  })
}

/**
 * Get the most recent turns across ALL sessions for one user (cross-session context).
 * Used to give Atlas awareness of recent activity even in a fresh session.
 * @param {number} [limit=5]
 * @param {string} [userId]
 * @returns {{ role: string, content: string, created_at: string }[]}
 */
export function getGlobalRecentHistory (limit = 5, userId = 'default', workspaceId = null) {
  const db = getSqlite()
  const rows = workspaceId
    ? db.prepare(`
        SELECT role, content, created_at
        FROM conversations
        WHERE user_id = ? AND workspace_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(userId, workspaceId, limit)
    : db.prepare(`
        SELECT role, content, created_at
        FROM conversations
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(userId, limit)
  return rows.reverse()
}

/**
 * Delete all conversation turns for a session.
 * @param {string} sessionId
 * @returns {number} rows deleted
 */
export function clearConversation (sessionId) {
  const db = getSqlite()
  return db.prepare(`DELETE FROM conversations WHERE session_id = ?`).run(sessionId).changes
}

/**
 * Delete ALL conversation turns for a user (full memory wipe).
 * @param {string} [userId]
 * @returns {number} rows deleted
 */
export function clearAllConversations (userId = 'default') {
  const db = getSqlite()
  return db.prepare(`DELETE FROM conversations WHERE user_id = ?`).run(userId).changes
}

/**
 * Search conversations by one or more keywords (LIKE match on content).
 * @param {string[]} keywords
 * @param {number} [limit=20]
 * @param {string} [userId]
 * @param {string|null} [workspaceId]
 * @returns {{ role: string, content: string, created_at: string, session_id: string }[]}
 */
export function searchConversationsByKeywords (keywords, limit = 20, userId = 'default', workspaceId = null) {
  if (!keywords.length) return []
  const db = getSqlite()
  const conditions = keywords.map(() => `content LIKE ?`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  const rows = workspaceId
    ? db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations
        WHERE user_id = ? AND workspace_id = ? AND (${conditions})
        ORDER BY created_at DESC
        LIMIT ?
      `).all(userId, workspaceId, ...params, limit)
    : db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations
        WHERE user_id = ? AND (${conditions})
        ORDER BY created_at DESC
        LIMIT ?
      `).all(userId, ...params, limit)
  return rows
}

/**
 * Search conversations within a date range.
 * @param {string} from  — ISO date string e.g. '2026-04-01'
 * @param {string} to    — ISO date string e.g. '2026-04-30'
 * @param {number} [limit=20]
 * @param {string} [userId]
 * @returns {{ role: string, content: string, created_at: string, session_id: string }[]}
 */
export function searchConversationsByDateRange (from, to, limit = 20, userId = 'default') {
  const db = getSqlite()
  const rows = db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE user_id = ? AND created_at BETWEEN ? AND ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, from, to + 'T23:59:59', limit)
  return rows
}

/**
 * Get the current user_context row.
 * @returns {object}
 */
export function getUserContext () {
  const db = getSqlite()
  const row = db.prepare('SELECT * FROM user_context WHERE id = 1').get()
  if (!row) return {}
  return {
    displayName:       row.display_name,
    company:           row.company,
    role:              row.role,
    currentPriorities: safeParseJson(row.current_priorities, []),
    activeDeals:       safeParseJson(row.active_deals, []),
    keyContacts:       safeParseJson(row.key_contacts, []),
    tonePreferences:   row.tone_preferences,
    contextNotes:      row.context_notes,
  }
}

/**
 * Vector similarity search in PostgreSQL.
 * Returns top-k resource excerpts for a given embedding.
 * @param {number[]} embedding  — 768-dim float array
 * @param {string}   domain     — filter by domain/corpus
 * @param {number}   [k=5]
 * @returns {Promise<{ content: string, title: string, score: number }[]>}
 */
export async function vectorSearch (embedding, domain, k = 5) {
  const pool = getPgPool()
  const vectorStr = `[${embedding.join(',')}]`
  const { rows } = await pool.query(`
    SELECT r.title,
           COALESCE(ch.content, r.summary, '') AS content,
           1 - (r.summary_embedding <=> $1::vector) AS score
    FROM resources r
    LEFT JOIN corpora co ON co.id = r.corpus_id
    LEFT JOIN LATERAL (
      SELECT content
      FROM chunks
      WHERE resource_id = r.id
      ORDER BY chunk_index
      LIMIT 1
    ) ch ON TRUE
    WHERE (co.domain = $2 OR co.slug = $2) AND r.summary_embedding IS NOT NULL
    ORDER BY r.summary_embedding <=> $1::vector
    LIMIT $3
  `, [vectorStr, domain, k])
  return rows
}

/**
 * Compatibility lookup for file-serving routes.
 * Resource-backed: returns a locally readable path for a given resource ID.
 */
export async function getArtifactById (id) {
  const pool = getPgPool()
  const { rows } = await pool.query(`
    SELECT r.id,
           r.title,
           r.mime_type,
           r.stored_path,
           r.source_ref,
           r.source_kind,
           co.domain,
           COALESCE(co.slug, co.domain) AS corpus
    FROM resources r
    LEFT JOIN corpora co ON co.id = r.corpus_id
    WHERE r.id = $1
    LIMIT 1
  `, [id])
  const row = rows[0] ?? null
  if (!row) return null
  return {
    ...row,
    stored_path: row.stored_path ?? (row.source_kind === 'path' ? row.source_ref : null),
  }
}

function safeParseJson (str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}

// ---------------------------------------------------------------------------
// Workspace Registry
// ---------------------------------------------------------------------------

function parseWorkspaceRow (row) {
  if (!row) return null
  return {
    id:          row.id,
    name:        row.name,
    path:        row.path,
    description: row.description,
    language:    row.language,
    buildCmd:    row.build_cmd,
    conventions: safeParseJson(row.conventions, []),
    keyDirs:     safeParseJson(row.key_dirs, []),
    ppmService:  row.ppm_service,
    tags:        safeParseJson(row.tags, []),
    active:      !!row.active,
    createdAt:   row.created_at,
    updatedAt:   row.updated_at,
  }
}

/** Get one workspace by ID. Returns null if not found. */
export function getWorkspaceInfo (workspaceId) {
  const db = getSqlite()
  return parseWorkspaceRow(
    db.prepare('SELECT * FROM workspace_registry WHERE id = ? AND active = 1').get(workspaceId)
  )
}

/** Get all active workspaces ordered by name. */
export function getAllWorkspaces () {
  const db = getSqlite()
  return db.prepare('SELECT * FROM workspace_registry WHERE active = 1 ORDER BY name').all()
    .map(parseWorkspaceRow)
}

/** Insert or update a workspace entry. */
export function upsertWorkspace (ws) {
  const db = getSqlite()
  db.prepare(`
    INSERT INTO workspace_registry
      (id, name, path, description, language, build_cmd, conventions, key_dirs, ppm_service, tags, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name        = excluded.name,
      path        = excluded.path,
      description = excluded.description,
      language    = excluded.language,
      build_cmd   = excluded.build_cmd,
      conventions = excluded.conventions,
      key_dirs    = excluded.key_dirs,
      ppm_service = excluded.ppm_service,
      tags        = excluded.tags,
      active      = 1,
      updated_at  = datetime('now')
  `).run(
    ws.id, ws.name, ws.path, ws.description ?? null, ws.language ?? null,
    ws.buildCmd ?? null,
    JSON.stringify(ws.conventions ?? []),
    JSON.stringify(ws.keyDirs ?? []),
    ws.ppmService ?? null,
    JSON.stringify(ws.tags ?? [])
  )
}

function parseLearnPlanRow (row) {
  if (!row) return null
  return {
    id: row.id,
    user_id: row.user_id,
    requested_by: row.requested_by,
    title: row.title,
    request: row.request,
    status: row.status,
    summary: row.summary,
    findings: safeParseJson(row.findings, null),
    proposal: safeParseJson(row.proposal, null),
    metadata: safeParseJson(row.metadata, {}),
    decision_notes: row.decision_notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    decided_at: row.decided_at,
  }
}

// ---------------------------------------------------------------------------
// Query log — records every user query for the self-organizing agent
// ---------------------------------------------------------------------------

/**
 * Log one user query turn.
 * @param {string} userId
 * @param {string} sessionId
 * @param {string|null} intent     — from jobTicket.intent
 * @param {string[]} domains       — from jobTicket.domains
 * @param {string|null} workspaceId
 */
export function logQuery (userId, sessionId, intent, domains, workspaceId = null) {
  try {
    const db = getSqlite()
    db.prepare(`
      INSERT INTO query_log (user_id, session_id, workspace_id, intent, domains)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, sessionId, workspaceId ?? null, intent ?? null, JSON.stringify(domains ?? []))
  } catch (err) {
    // Non-fatal — don't let a log write break the pipeline
    console.warn('[db] logQuery failed:', err.message)
  }
}

/**
 * Get query pattern aggregates for the self-organizing agent.
 * @param {object} opts
 * @param {string}  [opts.userId]      — filter to one user (omit for all)
 * @param {string}  [opts.since]       — ISO date string, default 30 days ago
 * @param {number}  [opts.limit=50]    — max rows per result set
 * @returns {{ topDomains, topIntents, dailyCounts, recentSamples }}
 */
export function getQueryPatterns ({ userId = null, since = null, limit = 50 } = {}) {
  const db = getSqlite()
  const cutoff = since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const userFilter  = userId ? `AND user_id = ?`    : ''
  const userParams  = userId ? [userId]              : []

  // Top domains (parse JSON array column, explode with json_each)
  const topDomains = db.prepare(`
    SELECT value AS domain, COUNT(*) AS queries
    FROM query_log, json_each(query_log.domains)
    WHERE created_at >= ? ${userFilter}
    GROUP BY value ORDER BY queries DESC LIMIT ?
  `).all(cutoff, ...userParams, 20)

  // Top intents
  const topIntents = db.prepare(`
    SELECT intent, COUNT(*) AS queries
    FROM query_log
    WHERE created_at >= ? AND intent IS NOT NULL ${userFilter}
    GROUP BY intent ORDER BY queries DESC LIMIT ?
  `).all(cutoff, ...userParams, limit)

  // Daily counts (last 30 days)
  const dailyCounts = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS queries
    FROM query_log
    WHERE created_at >= ? ${userFilter}
    GROUP BY day ORDER BY day DESC LIMIT 30
  `).all(cutoff, ...userParams)

  // Recent raw samples (for debugging / manual review)
  const recentSamples = db.prepare(`
    SELECT user_id, session_id, workspace_id, intent, domains, created_at
    FROM query_log
    WHERE created_at >= ? ${userFilter}
    ORDER BY created_at DESC LIMIT 20
  `).all(cutoff, ...userParams)

  return { topDomains, topIntents, dailyCounts, recentSamples }
}

// ---------------------------------------------------------------------------
// Learn plans — batched learn/report proposals before ingest
// ---------------------------------------------------------------------------

/**
 * Create a learn plan shell or finalized report.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.request
 * @param {string} [opts.userId]
 * @param {string} [opts.requestedBy]
 * @param {string|null} [opts.title]
 * @param {string} [opts.status]
 * @param {string|null} [opts.summary]
 * @param {object|null} [opts.findings]
 * @param {object|null} [opts.proposal]
 * @param {object} [opts.metadata]
 */
export function createLearnPlan ({ id, request, userId = 'default', requestedBy = 'default', title = null, status = 'draft', summary = null, findings = null, proposal = null, metadata = {} }) {
  if (!`${id ?? ''}`.trim()) throw new Error('id is required')
  if (!`${request ?? ''}`.trim()) throw new Error('request is required')

  const db = getSqlite()
  db.prepare(`
    INSERT INTO learn_plans (id, user_id, requested_by, title, request, status, summary, findings, proposal, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    requestedBy,
    title ?? null,
    request,
    status,
    summary ?? null,
    findings == null ? null : JSON.stringify(findings),
    proposal == null ? null : JSON.stringify(proposal),
    JSON.stringify(metadata ?? {}),
  )

  return getLearnPlanById(id)
}

/**
 * Update a learn plan.
 * @param {string} id
 * @param {object} patch
 */
export function updateLearnPlan (id, patch = {}) {
  if (!`${id ?? ''}`.trim()) throw new Error('id is required')

  const sets = ['updated_at = strftime(\'%Y-%m-%dT%H:%M:%f\', \'now\')']
  const params = []

  if (patch.userId !== undefined)        { sets.push('user_id = ?');        params.push(patch.userId) }
  if (patch.requestedBy !== undefined)   { sets.push('requested_by = ?');   params.push(patch.requestedBy) }
  if (patch.title !== undefined)         { sets.push('title = ?');          params.push(patch.title ?? null) }
  if (patch.request !== undefined)       { sets.push('request = ?');        params.push(patch.request ?? null) }
  if (patch.status !== undefined)        { sets.push('status = ?');         params.push(patch.status) }
  if (patch.summary !== undefined)       { sets.push('summary = ?');        params.push(patch.summary ?? null) }
  if (patch.findings !== undefined)      { sets.push('findings = ?');       params.push(patch.findings == null ? null : JSON.stringify(patch.findings)) }
  if (patch.proposal !== undefined)      { sets.push('proposal = ?');       params.push(patch.proposal == null ? null : JSON.stringify(patch.proposal)) }
  if (patch.metadata !== undefined)      { sets.push('metadata = ?');       params.push(patch.metadata == null ? null : JSON.stringify(patch.metadata)) }
  if (patch.decisionNotes !== undefined) { sets.push('decision_notes = ?'); params.push(patch.decisionNotes ?? null) }
  if (patch.decidedAt !== undefined)     { sets.push('decided_at = ?');     params.push(patch.decidedAt ?? null) }

  params.push(id)
  const db = getSqlite()
  db.prepare(`UPDATE learn_plans SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  return getLearnPlanById(id)
}

/**
 * Get learn plans, optionally filtered by status and user.
 * @param {object} [opts]
 * @param {string|string[]} [opts.status]
 * @param {string|null} [opts.userId]
 * @param {number} [opts.limit=50]
 */
export function getLearnPlans ({ status = null, userId = null, limit = 50 } = {}) {
  const db = getSqlite()
  const conditions = []
  const params = []

  if (status) {
    const statuses = Array.isArray(status) ? status : [status]
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (`${userId ?? ''}`.trim()) {
    conditions.push('user_id = ?')
    params.push(userId)
  }

  params.push(limit)
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT id, user_id, requested_by, title, request, status, summary,
           findings, proposal, metadata, decision_notes, created_at, updated_at, decided_at
    FROM learn_plans
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params)

  return rows.map(parseLearnPlanRow)
}

/**
 * Get one learn plan by ID.
 * @param {string} id
 */
export function getLearnPlanById (id) {
  const db = getSqlite()
  const row = db.prepare(`
    SELECT id, user_id, requested_by, title, request, status, summary,
           findings, proposal, metadata, decision_notes, created_at, updated_at, decided_at
    FROM learn_plans
    WHERE id = ?
    LIMIT 1
  `).get(id)
  return parseLearnPlanRow(row)
}

// ---------------------------------------------------------------------------
// Staged files — quarantine pipeline helpers
// ---------------------------------------------------------------------------

/**
 * Register a new file in the staging pipeline (status = 'pending').
 * @param {object} opts
 * @param {string} opts.id          — UUID
 * @param {string} opts.filename
 * @param {string} opts.inboxPath   — absolute path in inbox/
 * @param {string} [opts.sourceUrl]
 * @param {string} [opts.sourceType]  — 'upload' | 'download' | 'agent'
 * @param {string} [opts.corpus]
 * @param {string} [opts.domain]
 * @param {string} [opts.learnPlanId]
 * @param {string} [opts.submittedBy]
 * @param {object} [opts.metadata]
 */
export function registerStagedFile ({ id, filename, inboxPath, sourceUrl = null, sourceType = 'upload', corpus = null, domain = null, learnPlanId = null, submittedBy = 'default', metadata = {} }) {
  const db = getSqlite()
  db.prepare(`
    INSERT INTO staged_files (id, filename, inbox_path, source_url, source_type, corpus, domain, learn_plan_id, submitted_by, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(id, filename, inboxPath, sourceUrl ?? null, sourceType, corpus ?? null, domain ?? corpus ?? null, learnPlanId ?? null, submittedBy, JSON.stringify(metadata))
}

/**
 * Update the status and optional extra fields on a staged file.
 * @param {string} id
 * @param {string} status   — 'scanning' | 'approved' | 'rejected' | 'ingested'
 * @param {object} [extras] — { scanResult, scanNotes, reviewPath, approvedPath, approvedAt, ingestedAt }
 */
export function updateStagedStatus (id, status, extras = {}) {
  const db = getSqlite()
  const sets = ['status = ?']
  const params = [status]

  if (extras.scanResult  !== undefined) { sets.push('scan_result = ?');   params.push(extras.scanResult) }
  if (extras.scanNotes   !== undefined) { sets.push('scan_notes = ?');    params.push(extras.scanNotes) }
  if (extras.reviewPath  !== undefined) { sets.push('review_path = ?');   params.push(extras.reviewPath) }
  if (extras.approvedPath!== undefined) { sets.push('approved_path = ?'); params.push(extras.approvedPath) }
  if (extras.approvedAt  !== undefined) { sets.push('approved_at = ?');   params.push(extras.approvedAt) }
  if (extras.ingestedAt  !== undefined) { sets.push('ingested_at = ?');   params.push(extras.ingestedAt) }

  params.push(id)
  db.prepare(`UPDATE staged_files SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

/**
 * Get staged files, optionally filtered by status.
 * @param {object} [opts]
 * @param {string|string[]} [opts.status]   — filter by one or more statuses
 * @param {number}          [opts.limit=50]
 * @returns {object[]}
 */
export function getStagedFiles ({ status = null, limit = 50 } = {}) {
  const db = getSqlite()
  const statuses = status
    ? (Array.isArray(status) ? status : [status])
    : ['pending', 'scanning', 'review', 'approved', 'rejected', 'ingested']

  const placeholders = statuses.map(() => '?').join(', ')
  return db.prepare(`
    SELECT id, filename, inbox_path, review_path, approved_path, source_url, source_type,
           corpus, domain, learn_plan_id, status, scan_result, scan_notes, submitted_by,
           submitted_at, approved_at, ingested_at, metadata
    FROM staged_files
    WHERE status IN (${placeholders})
    ORDER BY submitted_at DESC
    LIMIT ?
  `).all(...statuses, limit)
}

export function getStagedFileById (id) {
  const db = getSqlite()
  return db.prepare(`
    SELECT id, filename, inbox_path, review_path, approved_path, source_url, source_type,
           corpus, domain, learn_plan_id, status, scan_result, scan_notes, submitted_by,
           submitted_at, approved_at, ingested_at, metadata
    FROM staged_files
    WHERE id = ?
    LIMIT 1
  `).get(id) ?? null
}

export function getStagedFileByPath (sourcePath) {
  const db = getSqlite()
  return db.prepare(`
    SELECT id, filename, inbox_path, review_path, approved_path, source_url, source_type,
           corpus, domain, learn_plan_id, status, scan_result, scan_notes, submitted_by,
           submitted_at, approved_at, ingested_at, metadata
    FROM staged_files
    WHERE approved_path = ? OR review_path = ? OR inbox_path = ?
    ORDER BY submitted_at DESC
    LIMIT 1
  `).get(sourcePath, sourcePath, sourcePath) ?? null
}

export function getStagedFilesByLearnPlanId (learnPlanId, { status = null, limit = 200 } = {}) {
  const db = getSqlite()
  const conditions = ['learn_plan_id = ?']
  const params = [learnPlanId]

  if (status) {
    const statuses = Array.isArray(status) ? status : [status]
    conditions.push(`status IN (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }

  params.push(limit)
  return db.prepare(`
    SELECT id, filename, inbox_path, review_path, approved_path, source_url, source_type,
           corpus, domain, learn_plan_id, status, scan_result, scan_notes, submitted_by,
           submitted_at, approved_at, ingested_at, metadata
    FROM staged_files
    WHERE ${conditions.join(' AND ')}
    ORDER BY submitted_at DESC
    LIMIT ?
  `).all(...params)
}

/**
 * Mark a staged file as ingested, looked up by its approved_path or inbox_path.
 * Called by watch-ingest after a successful ingestFile() call.
 * @param {string} sourcePath — absolute path that was ingested
 */
export function markStagedIngested (sourcePath) {
  try {
    const db = getSqlite()
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE staged_files
      SET status = 'ingested', ingested_at = ?
      WHERE approved_path = ? OR inbox_path = ?
    `).run(now, sourcePath, sourcePath)
  } catch (err) {
    console.warn('[db] markStagedIngested failed:', err.message)
  }
}

