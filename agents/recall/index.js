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
import { BaseAgent } from '../_base/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve SQLite path the same way the broker does
const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.resolve(__dirname, '../../data/memory.db')

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

  // "last week"
  if (/last week/.test(text)) {
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
  'conversation','conversations','last','time','times','back','something','anything',
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

// Merge and deduplicate results, rank by match score (number of keywords matched)
function rankAndDedupe (rows, keywords) {
  const seen = new Set()
  const unique = rows.filter(r => {
    const key = `${r.created_at}-${r.role}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  if (!keywords.length) return unique

  return unique
    .map(r => ({
      ...r,
      _score: keywords.filter(k => r.content?.toLowerCase().includes(k)).length,
    }))
    .sort((a, b) => b._score - a._score || b.created_at.localeCompare(a.created_at))
    .map(({ _score, ...r }) => r)  // strip internal score field
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

  _searchMemory (task, limit) {
    this.log(`search_memory: "${task.slice(0, 80)}"`)

    const dateRange = parseDateRange(task)
    const keywords  = extractKeywords(task)

    this.log(`  date range: ${dateRange ? `${dateRange.from} → ${dateRange.to}` : 'none'} | keywords: [${keywords.join(', ')}]`)

    let rows = []

    if (dateRange && keywords.length) {
      // Both — date-scoped keyword search
      rows = searchByDateAndKeywords(dateRange.from, dateRange.to, keywords, limit)
      // Also do a keyword-only search in case there are relevant turns outside the date range
      const kOnly = searchByKeywords(keywords, Math.ceil(limit / 2))
      rows = rankAndDedupe([...rows, ...kOnly], keywords).slice(0, limit)
    } else if (dateRange) {
      rows = searchByDateRange(dateRange.from, dateRange.to, limit)
    } else if (keywords.length) {
      rows = searchByKeywords(keywords, limit)
      rows = rankAndDedupe(rows, keywords)
    } else {
      // No useful search terms — return most recent turns
      const db = getDb()
      rows = db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations ORDER BY created_at DESC LIMIT ?
      `).all(limit)
    }

    const summary = rows.length
      ? `Found ${rows.length} relevant conversation turn(s). Matched on: ${keywords.length ? keywords.join(', ') : 'recency'}${dateRange ? ` | date range: ${dateRange.from} to ${dateRange.to}` : ''}`
      : `No conversation history found matching this request.`

    this.log(summary)

    return {
      turns: rows,
      summary,
      matched_on: keywords,
      date_range: dateRange,
    }
  }
}

// Auto-run when spawned as a child process
const agent = new RecallAgent()
agent.run()
