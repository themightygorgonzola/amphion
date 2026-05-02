/**
 * broker/src/db.js — Database layer
 *
 * Two databases:
 *   node:sqlite (built-in, Node 24+) — conversations + user_context — fast, sync API, zero deps
 *   PostgreSQL (pg)                   — knowledge_items (pgvector RAG) — async
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

  // Create tables if they don't exist (SQLite-side schema — mirrors PG minus vector)
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
 */
export function saveConversationTurn (sessionId, role, content, metadata = {}) {
  const db = getSqlite()
  db.prepare(`
    INSERT INTO conversations (session_id, role, content, metadata)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, role, content, JSON.stringify(metadata))
}

/**
 * Get recent conversation history for a session.
 * @param {string} sessionId
 * @param {number} [limit=10]
 * @returns {{ role: string, content: string }[]}
 */
export function getRecentHistory (sessionId, limit = 10) {
  const db = getSqlite()
  const rows = db.prepare(`
    SELECT role, content
    FROM conversations
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sessionId, limit)
  return rows.reverse() // chronological order
}

/**
 * Get the most recent turns across ALL sessions (cross-session context).
 * Used to give Atlas awareness of recent activity even in a fresh session.
 * @param {number} [limit=5]
 * @returns {{ role: string, content: string, created_at: string }[]}
 */
export function getGlobalRecentHistory (limit = 5) {
  const db = getSqlite()
  const rows = db.prepare(`
    SELECT role, content, created_at
    FROM conversations
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit)
  return rows.reverse()
}

/**
 * Search conversations by one or more keywords (LIKE match on content).
 * @param {string[]} keywords
 * @param {number} [limit=20]
 * @returns {{ role: string, content: string, created_at: string, session_id: string }[]}
 */
export function searchConversationsByKeywords (keywords, limit = 20) {
  if (!keywords.length) return []
  const db = getSqlite()
  const conditions = keywords.map(() => `content LIKE ?`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  const rows = db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE ${conditions}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit)
  return rows
}

/**
 * Search conversations within a date range.
 * @param {string} from  — ISO date string e.g. '2026-04-01'
 * @param {string} to    — ISO date string e.g. '2026-04-30'
 * @param {number} [limit=20]
 * @returns {{ role: string, content: string, created_at: string, session_id: string }[]}
 */
export function searchConversationsByDateRange (from, to, limit = 20) {
  const db = getSqlite()
  const rows = db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE created_at BETWEEN ? AND ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(from, to + 'T23:59:59', limit)
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
 * Vector similarity search in pgvector.
 * Returns top-k knowledge items for a given embedding.
 * @param {number[]} embedding  — 768-dim float array
 * @param {string}   domain     — filter by domain
 * @param {number}   [k=5]
 * @returns {Promise<{ content: string, title: string, score: number }[]>}
 */
export async function vectorSearch (embedding, domain, k = 5) {
  const pool = getPgPool()
  const vectorStr = `[${embedding.join(',')}]`
  const { rows } = await pool.query(`
    SELECT title, content, 1 - (embedding <=> $1::vector) AS score
    FROM knowledge_items
    WHERE domain = $2
    ORDER BY embedding <=> $1::vector
    LIMIT $3
  `, [vectorStr, domain, k])
  return rows
}

function safeParseJson (str, fallback) {
  if (!str) return fallback
  try { return JSON.parse(str) } catch { return fallback }
}
