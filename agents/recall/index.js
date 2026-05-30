/**
 * agents/recall/index.js — Recall Agent
 *
 * Searches conversation history stored in SQLite to surface relevant past
 * context on demand. No LLM call inside this agent — the dispatcher
 * (qwen3:14b) already interpreted the user's intent into a task string.
 * This agent parses that task string for date references and topic keywords,
 * runs targeted SQLite queries, and returns ranked conversation turns.
 *
 * MCP Tools:
 *   search_memory — searches past conversations by topic and/or date range
 */

import path from 'path'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve SQLite path the same way the broker does
const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.resolve(__dirname, '../../data/memory.db')

const { Pool } = pg
let _pgPool = null
function getPgPool () {
  if (!_pgPool) {
    _pgPool = new Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER     ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max: 3,
    })
    _pgPool.on('error', err => process.stderr.write(`[recall] pg error: ${err.message}\n`))
  }
  return _pgPool
}

let _db = null
function getDb () {
  if (!_db) {
    _db = new DatabaseSync(SQLITE_PATH)
  }
  return _db
}

// ---------------------------------------------------------------------------
// Date parsing — convert natural language date refs to ISO date strings
// ---------------------------------------------------------------------------

function parseDateRange (task) {
  const now = new Date()
  const text = task.toLowerCase()

  // "last week" or "this week"
  if (/last week|this week|past week/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 7)
    return { from: toDate(from), to: toDate(now) }
  }
  // "last month" / "past month"
  if (/last month|past month/.test(text)) {
    const from = new Date(now); from.setMonth(now.getMonth() - 1)
    return { from: toDate(from), to: toDate(now) }
  }
  // "yesterday"
  if (/yesterday/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 1)
    return { from: toDate(from), to: toDate(from) }
  }
  // "today"
  if (/today/.test(text)) {
    return { from: toDate(now), to: toDate(now) }
  }
  // Named month e.g. "in April", "last April", "back in September"
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december']
  for (let i = 0; i < months.length; i++) {
    if (text.includes(months[i])) {
      const year = now.getMonth() <= i ? now.getFullYear() - 1 : now.getFullYear()
      const from = new Date(year, i, 1)
      const to   = new Date(year, i + 1, 0)  // last day of month
      return { from: toDate(from), to: toDate(to) }
    }
  }
  // "last N days"
  const daysMatch = text.match(/last (\d+) days?/)
  if (daysMatch) {
    const from = new Date(now); from.setDate(now.getDate() - parseInt(daysMatch[1], 10))
    return { from: toDate(from), to: toDate(now) }
  }

  // "recent" / "recently" / "lately" => last 7 days
  if (/\b(recent|recently|lately)\b/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 7)
    return { from: toDate(from), to: toDate(now) }
  }

  return null  // no date range detected
}

function toDate (d) {
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Keyword extraction — pull meaningful terms from the task string
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'what','when','where','which','who','how','did','was','were','the','a','an',
  'we','i','you','he','she','they','our','my','your','his','her','their',
  'about','regarding','related','tell','me','said','talked','spoke','discussed',
  'mentioned','think','remember','recall','find','get','search','look','show',
  'conversation','conversations','something','anything',
  'topic','topics','information','info','context','history','past','previous',
  'had','has','have','been','any','all','some','more','other','this','that',
])

function extractKeywords (task) {
  return task
    .replace(/[^\w\s]/g, ' ')  // strip punctuation
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase())
    .filter((w, i, arr) => arr.indexOf(w) === i)  // deduplicate
    .slice(0, 8)  // cap at 8 keywords
}

function hasTemporalIntent (task) {
  return /\b(last|latest|recent|recently|previous|earlier|before|today|yesterday|week|month|year|minutes?)\b/i.test(task)
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

function searchByKeywords (keywords, limit) {
  if (!keywords.length) return []
  const db = getDb()
  const conditions = keywords.map(() => `content LIKE ?`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  return db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE ${conditions}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params, limit)
}

function searchByDateRange (from, to, limit) {
  const db = getDb()
  return db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE created_at BETWEEN ? AND ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(from, to + 'T23:59:59', limit)
}

function searchByDateAndKeywords (from, to, keywords, limit) {
  if (!keywords.length) return searchByDateRange(from, to, limit)
  const db = getDb()
  const conditions = keywords.map(() => `content LIKE ?`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  return db.prepare(`
    SELECT role, content, created_at, session_id
    FROM conversations
    WHERE created_at BETWEEN ? AND ?
      AND (${conditions})
    ORDER BY created_at DESC
    LIMIT ?
  `).all(from, to + 'T23:59:59', ...params, limit)
}

// Merge and deduplicate results, rank by relevance, and drop weak matches.
function rankAndDedupe (rows, keywords) {
  const seen = new Set()
  const unique = rows.filter(r => {
    const key = `${r.created_at}-${r.role}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (!keywords.length) {
    return {
      rows: unique,
      confidence: unique.length ? 0.45 : 0,
    }
  }

  const nowTs = Date.now()
  const minKeywordHits = Math.max(1, Math.min(4, Math.ceil(keywords.length * 0.5)))

  const scored = unique
    .map(r => {
      const text = (r.content ?? '').toLowerCase()
      const keywordHits = keywords.filter(k => text.includes(k)).length
      const coverage = keywordHits / Math.max(keywords.length, 1)
      const exactPhrase = keywords.length > 1 && text.includes(keywords.join(' '))

      let recencyScore = 0
      const ts = Date.parse(r.created_at ?? '')
      if (Number.isFinite(ts)) {
        const ageDays = Math.max(0, (nowTs - ts) / 86_400_000)
        recencyScore = Math.max(0, 1 - Math.min(ageDays / 30, 1))
      }

      const roleScore = r.role === 'user' ? 0.1 : -0.05
      const score = (coverage * 0.68) + (recencyScore * 0.17) + (exactPhrase ? 0.1 : 0) + roleScore

      return {
        ...r,
        _keywordHits: keywordHits,
        _score: score,
      }
    })
    .filter(r => {
      const minScore = keywords.length >= 5 ? 0.52 : 0.42
      return r._keywordHits >= minKeywordHits && r._score >= minScore
    })
    .sort((a, b) => b._score - a._score || b.created_at.localeCompare(a.created_at))

  const confidence = scored.length ? scored[0]._score : 0
  const rowsOut = scored.map(({ _score, _keywordHits, ...r }) => r)

  return { rows: rowsOut, confidence }
}

// ---------------------------------------------------------------------------
// PG async query helpers (mirror the SQLite helpers above)
// ---------------------------------------------------------------------------

async function pgSearchByKeywords (keywords, limit) {
  if (!keywords.length) return []
  const conditions = keywords.map((_, i) => `content ILIKE $${i + 1}`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  const { rows } = await getPgPool().query(
    `SELECT role, content, created_at::text AS created_at, session_id
     FROM conversations WHERE ${conditions}
     ORDER BY created_at DESC LIMIT $${params.length + 1}`,
    [...params, limit]
  )
  return rows
}

async function pgSearchByDateRange (from, to, limit) {
  const { rows } = await getPgPool().query(
    `SELECT role, content, created_at::text AS created_at, session_id
     FROM conversations
     WHERE created_at BETWEEN $1 AND $2
     ORDER BY created_at DESC LIMIT $3`,
    [from, to + 'T23:59:59', limit]
  )
  return rows
}

async function pgSearchByDateAndKeywords (from, to, keywords, limit) {
  if (!keywords.length) return pgSearchByDateRange(from, to, limit)
  const conditions = keywords.map((_, i) => `content ILIKE $${i + 3}`).join(' OR ')
  const params = keywords.map(k => `%${k}%`)
  const { rows } = await getPgPool().query(
    `SELECT role, content, created_at::text AS created_at, session_id
     FROM conversations
     WHERE created_at BETWEEN $1 AND $2 AND (${conditions})
     ORDER BY created_at DESC LIMIT $${params.length + 3}`,
    [from, to + 'T23:59:59', ...params, limit]
  )
  return rows
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

class RecallAgent extends BaseAgent {
  get name () { return 'recall' }
  get description () { return 'Searches past conversation history by topic, date, or both' }

  get tools () {
    return [
      {
        name: 'search_memory',
        description: 'Search past conversations by natural language task description. Handles date references ("last week", "in April") and topic keywords automatically.',
        inputSchema: {
          type: 'object',
          properties: {
            task:  { type: 'string', description: 'Natural language description of what to find — topic, timeframe, or both' },
            limit: { type: 'integer', description: 'Max turns to return (default 20)' },
          },
          required: ['task'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    if (toolName === 'search_memory') {
      return this._searchMemory(args.task ?? '', args.limit ?? 20)
    }
    throw new Error(`Unknown tool: ${toolName}`)
  }

  async _searchMemory (task, limit) {
    this.log(`search_memory: "${task.slice(0, 80)}"`)

    const dateRange = parseDateRange(task)
    const keywords  = extractKeywords(task)
    const temporalIntent = hasTemporalIntent(task)

    this.log(`  date range: ${dateRange ? `${dateRange.from} → ${dateRange.to}` : 'none'} | keywords: [${keywords.join(', ')}]`)

    let sqliteRows = []
    let pgRows = []
    let confidence = 0
    let reason = ''

    if (dateRange && keywords.length) {
      const [sq, pq] = await Promise.allSettled([
        Promise.resolve([
          ...searchByDateAndKeywords(dateRange.from, dateRange.to, keywords, limit),
          ...searchByKeywords(keywords, Math.ceil(limit / 2)),
        ]),
        pgSearchByDateAndKeywords(dateRange.from, dateRange.to, keywords, limit)
          .then(r => r.concat ? r : []),
      ])
      sqliteRows = sq.status === 'fulfilled' ? sq.value : []
      pgRows     = pq.status === 'fulfilled' ? pq.value : []
    } else if (dateRange) {
      const [sq, pq] = await Promise.allSettled([
        Promise.resolve(searchByDateRange(dateRange.from, dateRange.to, limit)),
        pgSearchByDateRange(dateRange.from, dateRange.to, limit),
      ])
      sqliteRows = sq.status === 'fulfilled' ? sq.value : []
      pgRows     = pq.status === 'fulfilled' ? pq.value : []
      confidence = (sqliteRows.length + pgRows.length) ? 0.6 : 0
    } else if (keywords.length) {
      const [sq, pq] = await Promise.allSettled([
        Promise.resolve(searchByKeywords(keywords, limit)),
        pgSearchByKeywords(keywords, limit),
      ])
      sqliteRows = sq.status === 'fulfilled' ? sq.value : []
      pgRows     = pq.status === 'fulfilled' ? pq.value : []
      if (!(sqliteRows.length + pgRows.length)) reason = 'No strong evidence matched all key terms.'
    } else if (temporalIntent) {
      const db = getDb()
      sqliteRows = db.prepare(
        `SELECT role, content, created_at, session_id FROM conversations ORDER BY created_at DESC LIMIT ?`
      ).all(limit)
      try {
        const { rows } = await getPgPool().query(
          `SELECT role, content, created_at::text AS created_at, session_id FROM conversations ORDER BY created_at DESC LIMIT $1`,
          [limit]
        )
        pgRows = rows
      } catch { pgRows = [] }
      confidence = (sqliteRows.length + pgRows.length) ? 0.4 : 0
    } else {
      reason = 'Request lacked searchable topic or time anchors.'
    }

    // Merge SQLite + PG, deduplicate by content fingerprint, then rank
    const merged = [...sqliteRows, ...pgRows]
    const rows = rankAndDedupe(merged, keywords)

    const { rows: rankedRows, confidence: rankedConfidence } = rows
    if (keywords.length && !dateRange) confidence = rankedConfidence
    const finalRows = rankedRows.slice(0, limit)
    const foundNothing = finalRows.length === 0
    if (foundNothing && !reason) {
      reason = 'No conversation turns met relevance threshold.'
    }

    const summary = !foundNothing
      ? `Found ${finalRows.length} relevant conversation turn(s). Matched on: ${keywords.length ? keywords.join(', ') : 'recency'}${dateRange ? ` | date range: ${dateRange.from} to ${dateRange.to}` : ''} | confidence: ${confidence.toFixed(2)}`
      : `No conversation history found matching this request. ${reason}`

    this.log(summary)

    return {
      turns: finalRows,
      summary,
      matched_on: keywords,
      date_range: dateRange,
      found_nothing: foundNothing,
      confidence,
      reason,
    }
  }
}

// Auto-run when spawned as a child process
const agent = new RecallAgent()
agent.run()
