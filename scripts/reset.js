/**
 * scripts/reset.js — Hard reset for Amphion dev/ops
 *
 * Clears ALL conversation history from SQLite and ALL canonical resource
 * knowledge from PostgreSQL. Preserves user_context (David's profile).
 *
 * Usage:
 *   node scripts/reset.js                   # wipe conversations + knowledge
 *   node scripts/reset.js --keep-knowledge  # wipe conversations only
 *   node scripts/reset.js --keep-convos     # wipe knowledge only
 *   node scripts/reset.js --all             # also wipe user_context
 */

import fs   from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

function loadEnv () {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const args        = new Set(process.argv.slice(2))
const wipeConvos  = !args.has('--keep-convos')
const wipeKnowl   = !args.has('--keep-knowledge')
const wipeCtx     = args.has('--all')

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------
function resetSqlite () {
  const dbPath = path.resolve(process.env.SQLITE_PATH ?? './data/memory.db')
  if (!fs.existsSync(dbPath)) {
    console.log('[reset] SQLite: no DB file found, skipping')
    return { conversations: 0, user_context: false }
  }

  const db = new DatabaseSync(dbPath)
  let convosDeleted = 0

  if (wipeConvos) {
    const result = db.prepare('DELETE FROM conversations').run()
    convosDeleted = result.changes
    console.log(`[reset] SQLite: deleted ${convosDeleted} conversation rows`)
  }

  if (wipeCtx) {
    db.prepare('DELETE FROM user_context').run()
    db.prepare('INSERT OR IGNORE INTO user_context (id) VALUES (1)').run()
    console.log('[reset] SQLite: user_context cleared (blank row re-inserted)')
  }

  db.close()
  return { conversations: convosDeleted }
}

// ---------------------------------------------------------------------------
// pgvector
// ---------------------------------------------------------------------------
async function resetPgvector () {
  if (!wipeKnowl) return { resources: 0, chunks: 0 }

  const pool = new pg.Pool({
    host:     process.env.PGHOST     ?? 'localhost',
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'amphion',
    user:     process.env.PGUSER     ?? 'amphion',
    password: process.env.PGPASSWORD ?? 'changeme',
    max:      2,
  })

  try {
    const candidateTables = ['resource_scope_stats', 'entity_links', 'resource_entities', 'resource_workspaces', 'entities', 'chunks', 'resources', 'artifacts', 'documents', 'knowledge_items']
    const { rows: tableRows } = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [candidateTables],
    )
    const existingTables = new Set(tableRows.map(row => row.table_name))
    const tablesToTruncate = candidateTables.filter(name => existingTables.has(name))

    const counts = {}
    for (const tableName of tablesToTruncate) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`)
      counts[tableName] = rows[0]?.count ?? 0
    }

    if (tablesToTruncate.length > 0) {
      await pool.query(`TRUNCATE TABLE ${tablesToTruncate.join(', ')} RESTART IDENTITY CASCADE`)
      console.log(`[reset] PostgreSQL: truncated ${tablesToTruncate.join(', ')}`)
    }

    return counts
  } finally {
    await pool.end()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  console.log('[reset] Starting Amphion data reset...')
  console.log(`[reset] Scope: conversations=${wipeConvos}, knowledge=${wipeKnowl}, user_context=${wipeCtx}`)

  const sqlite = resetSqlite()
  const pg     = await resetPgvector()

  console.log('[reset] Done.')
  console.log('[reset] Summary:', { ...sqlite, ...pg })
}

main().catch(err => {
  console.error('[reset] Error:', err.message)
  process.exit(1)
})
