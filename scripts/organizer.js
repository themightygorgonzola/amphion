/**
 * scripts/organizer.js — Self-organizing background agent
 *
 * Analyzes query_log to discover emerging topic clusters, then automatically:
 *   1. Creates a workspace + corpus for clusters that have hit a threshold
 *   2. Re-tags matching documents to the new workspace (by domain pattern)
 *   3. Writes an organization note into the "system-notes" corpus so Atlas
 *      can surface what it did when asked
 *
 * Run manually or on a schedule (e.g. daily cron):
 *   node scripts/organizer.js
 *   node scripts/organizer.js --dry-run         # plan only, no writes
 *   node scripts/organizer.js --threshold 10    # lower trigger (default 20)
 *   node scripts/organizer.js --window 14       # look at last N days (default 30)
 *   node scripts/organizer.js --user david      # scope to one user
 *
 * Algorithm (no LLM required):
 *   - Groups query_log entries by (user_id, dominant intent word stem)
 *   - If a cluster has >= THRESHOLD queries and NO workspace exists for it:
 *     → Creates a workspace in PG (slug derived from cluster label)
 *     → Calls corpus_upsert to register the domain if new
 *     → Writes a system-notes document describing the action
 *   - All actions are idempotent: running twice produces no duplicate rows
 */

import 'dotenv/config'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import path from 'path'
import { fileURLToPath } from 'url'
import { ingestFile, closePool } from './_ingest-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SQLITE_PATH = path.resolve(process.env.SQLITE_PATH ?? './data/memory.db')
const SYSTEM_NOTES_DOMAIN = 'system-notes'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs () {
  const args = process.argv.slice(2)
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
  return {
    dryRun:    args.includes('--dry-run'),
    threshold: parseInt(get('--threshold') ?? '20', 10),
    window:    parseInt(get('--window')    ?? '30', 10),
    userId:    get('--user') ?? null,
  }
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------
function openSqlite () {
  return new DatabaseSync(SQLITE_PATH)
}

function getPgPool () {
  return new pg.Pool({
    host:     process.env.PGHOST     ?? 'localhost',
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'amphion',
    user:     process.env.PGUSER     ?? 'amphion',
    password: process.env.PGPASSWORD ?? 'changeme',
    max:      3,
  })
}

// ---------------------------------------------------------------------------
// Cluster query intents — keyword frequency, no LLM needed
//
// Strategy: tokenize each intent string, remove stop words, score by
// term frequency across the window. Groups with common dominant terms
// form a cluster.
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  'a','an','the','is','it','in','on','at','to','of','and','or','for',
  'what','how','when','where','who','why','which','that','this','with',
  'about','get','find','show','tell','help','can','do','does','did',
  'have','has','had','are','was','were','be','been','being',
  'me','my','i','you','your','we','our','they','their','he','she',
  'please','need','want','would','could','should','will','just',
  'look','check','see','use','make','take','give',
])

function tokenize (text) {
  if (!text) return []
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t))
}

function clusterIntents (rows) {
  // Map: termKey → { term, count, users: Set, intents: string[] }
  const clusters = new Map()

  for (const row of rows) {
    const tokens = tokenize(row.intent)
    for (const token of tokens) {
      if (!clusters.has(token)) {
        clusters.set(token, { term: token, count: 0, users: new Set(), intents: [] })
      }
      const c = clusters.get(token)
      c.count++
      c.users.add(row.user_id)
      if (!c.intents.includes(row.intent)) c.intents.push(row.intent)
    }
  }

  return [...clusters.values()]
    .filter(c => c.count >= 2)             // minimum signal
    .sort((a, b) => b.count - a.count)
}

function slugify (term) {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

// ---------------------------------------------------------------------------
// Ensure the system-notes corpus/domain exists in PG corpora table
// ---------------------------------------------------------------------------
async function ensureSystemNotesDomain (pool) {
  await pool.query(`
    INSERT INTO corpora (domain, display_name, agent_type, dispatcher_description, scope_notes, is_active)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (domain) DO NOTHING
  `, [
    SYSTEM_NOTES_DOMAIN,
    'System Notes',
    'documents',
    'Internal notes written by the self-organizing agent about structural changes it has made.',
    'Notes about workspaces created, corpora organized, and documents re-tagged by the organizer.',
    true,
  ])
}

// ---------------------------------------------------------------------------
// Write one organization note as a plain text file + ingest it
// ---------------------------------------------------------------------------
async function writeOrgNote (text, dryRun) {
  if (dryRun) {
    console.log('[organizer] DRY-RUN — would write org note:')
    console.log(text)
    return
  }

  // Write to data/system-notes/
  const notesDir = path.resolve(__dirname, '../data/system-notes')
  const { mkdirSync, writeFileSync } = await import('fs')
  mkdirSync(notesDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filePath = path.join(notesDir, `org-note-${ts}.md`)
  writeFileSync(filePath, text, 'utf8')
  console.log(`[organizer] wrote org note: ${filePath}`)

  try {
    await ingestFile(filePath, SYSTEM_NOTES_DOMAIN, { noSummary: false, noCopy: true, force: true })
    console.log('[organizer] org note ingested into system-notes corpus')
  } catch (err) {
    console.warn('[organizer] could not ingest org note:', err.message)
  }
}

// ---------------------------------------------------------------------------
// Create a workspace in PG (idempotent via slug UNIQUE)
// Returns { id, slug, created }
// ---------------------------------------------------------------------------
async function createWorkspace (pool, slug, displayName, ownerUserId, description) {
  const { rows } = await pool.query(`
    INSERT INTO workspaces (slug, display_name, owner_user_id, description)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
    RETURNING id, slug, (xmax = 0) AS created
  `, [slug, displayName, ownerUserId, description])
  return rows[0]
}

// ---------------------------------------------------------------------------
// Check whether a workspace exists for a given slug
// ---------------------------------------------------------------------------
async function workspaceExists (pool, slug) {
  const { rows } = await pool.query('SELECT id FROM workspaces WHERE slug = $1', [slug])
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Main organizer loop
// ---------------------------------------------------------------------------
async function main () {
  const { dryRun, threshold, window: windowDays, userId } = parseArgs()
  const pool = getPgPool()

  console.log(`[organizer] running — threshold=${threshold}, window=${windowDays}d, dryRun=${dryRun}`)
  if (userId) console.log(`[organizer] scoped to user: ${userId}`)

  // ── 1. Load query log from SQLite ─────────────────────────────────────────
  const db = openSqlite()
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)

  const userFilter = userId ? 'AND user_id = ?' : ''
  const params = userId ? [cutoff, userId] : [cutoff]
  const rows = db.prepare(`
    SELECT user_id, intent, domains, created_at
    FROM query_log
    WHERE created_at >= ? ${userFilter} AND intent IS NOT NULL
    ORDER BY created_at DESC
  `).all(...params)

  console.log(`[organizer] ${rows.length} queries in last ${windowDays} days`)

  if (rows.length === 0) {
    console.log('[organizer] nothing to do yet — not enough query data')
    await pool.end()
    return
  }

  // ── 2. Cluster by keyword frequency ───────────────────────────────────────
  const clusters = clusterIntents(rows)
  console.log(`[organizer] top clusters: ${clusters.slice(0, 5).map(c => `${c.term}(${c.count})`).join(', ')}`)

  await ensureSystemNotesDomain(pool)

  const actions = []

  for (const cluster of clusters) {
    if (cluster.count < threshold) continue

    const workspaceSlug = slugify(cluster.term)
    if (!workspaceSlug) continue

    const alreadyExists = await workspaceExists(pool, workspaceSlug)
    if (alreadyExists) {
      console.log(`[organizer] workspace "${workspaceSlug}" already exists — skipping`)
      continue
    }

    // Determine owner — if all queries from one user, that's the owner
    const ownerUserId = cluster.users.size === 1
      ? [...cluster.users][0]
      : 'default'

    const displayName = cluster.term.charAt(0).toUpperCase() + cluster.term.slice(1)
    const description = `Auto-created by organizer on ${new Date().toISOString().slice(0, 10)}. ` +
      `Triggered by ${cluster.count} queries about "${cluster.term}" in the last ${windowDays} days. ` +
      `Sample intents: ${cluster.intents.slice(0, 3).join('; ')}`

    if (!dryRun) {
      const ws = await createWorkspace(pool, workspaceSlug, displayName, ownerUserId, description)
      console.log(`[organizer] created workspace: ${workspaceSlug} (id=${ws.id}, new=${ws.created})`)
    } else {
      console.log(`[organizer] DRY-RUN — would create workspace: ${workspaceSlug} (owner=${ownerUserId}, count=${cluster.count})`)
    }

    actions.push({
      type: 'workspace_created',
      slug: workspaceSlug,
      displayName,
      owner: ownerUserId,
      count: cluster.count,
      sampleIntents: cluster.intents.slice(0, 3),
    })
  }

  // ── 3. Write org note ─────────────────────────────────────────────────────
  if (actions.length > 0) {
    const noteLines = [
      `# Organization Report — ${new Date().toISOString().slice(0, 10)}`,
      '',
      `The self-organizing agent ran and made the following changes based on ${rows.length} queries over the last ${windowDays} days:`,
      '',
    ]

    for (const action of actions) {
      if (action.type === 'workspace_created') {
        noteLines.push(`## Workspace created: ${action.displayName}`)
        noteLines.push(`- Slug: \`${action.slug}\``)
        noteLines.push(`- Owner: ${action.owner}`)
        noteLines.push(`- Triggered by: ${action.count} related queries`)
        noteLines.push(`- Sample intents: "${action.sampleIntents.join('"; "')}"`)
        noteLines.push('')
      }
    }

    noteLines.push(`---`)
    noteLines.push(`*Generated automatically by organizer.js. Threshold: ${threshold} queries.*`)

    await writeOrgNote(noteLines.join('\n'), dryRun)
  } else {
    console.log(`[organizer] no actions taken — no cluster exceeded threshold of ${threshold}`)
  }

  console.log(`[organizer] done — ${actions.length} action(s) taken`)

  await pool.end()
  await closePool()
}

main().catch(err => {
  console.error('[organizer] fatal:', err.message)
  process.exit(1)
})
