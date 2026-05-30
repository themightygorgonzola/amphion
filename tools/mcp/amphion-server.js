import 'dotenv/config'
import pg from 'pg'
import { randomUUID } from 'crypto'
import { spawn, spawnSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'
import { BaseAgent } from '../../agents/_base/index.js'
import { runAgent } from '../../apps/broker/src/agent-runner.js'
import { assembleContext } from '../../apps/broker/src/context-assembler.js'
import {
  addCharOffsets,
  CHUNKING_VERSION,
  chunkDocument,
  embed as ingestEmbed,
  replaceChunks,
  sha256 as ingestSha256,
  upsertResource,
} from '../../scripts/_ingest-lib.mjs'
import {
  createLearnPlan,
  getLearnPlanById,
  getLearnPlans,
  initDb,
  getRecentHistory,
  getGlobalRecentHistory,
  getUserContext,
  searchConversationsByKeywords,
  getQueryPatterns,
  getStagedFileById,
  getStagedFiles,
  getStagedFilesByLearnPlanId,
  updateStagedStatus,
  updateLearnPlan,
} from '../../apps/broker/src/db.js'
import {
  attachResourceToEntity,
  attachResourceToScope,
  getEntity,
  getScope,
  linkEntities,
  listEntities,
  listScopes,
  upsertEntity,
  upsertScope,
} from '../../apps/broker/src/organization-store.js'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AMPHION_ROOT = path.resolve(__dirname, '../..')
const KNOWLEDGE_AGENT_ENTRY = path.join(AMPHION_ROOT, 'agents', 'knowledge', 'index.js')
const STAGING_REVIEW_DIR = path.join(AMPHION_ROOT, 'data', 'staging', 'review')
const STAGING_APPROVED_DIR = path.join(AMPHION_ROOT, 'data', 'staging', 'approved')
const STAGING_REJECTED_DIR = path.join(AMPHION_ROOT, 'data', 'staging', 'rejected')

const BROKER_PORT = parseInt(process.env.BROKER_PORT ?? '3000', 10)

function buildBrokerBaseUrl () {
  const raw = (process.env.BROKER_HOST ?? '').trim()
  const withScheme = raw
    ? (raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`)
    : 'http://127.0.0.1'

  try {
    const url = new URL(withScheme)
    if (!url.port) url.port = String(BROKER_PORT)
    return url.origin
  } catch {
    return `http://127.0.0.1:${BROKER_PORT}`
  }
}

const BROKER_URL = buildBrokerBaseUrl()
let brokerHealthGraceUntil = 0

function ensureDirectory (dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function moveFileSafe (fromPath, toPath) {
  ensureDirectory(path.dirname(toPath))
  try {
    fs.renameSync(fromPath, toPath)
  } catch {
    fs.copyFileSync(fromPath, toPath)
    fs.unlinkSync(fromPath)
  }
}

function resolveCurrentStagedPath (row) {
  if (!row) return null
  if (row.status === 'review' && row.review_path) return row.review_path
  if (row.status === 'approved' && row.approved_path) return row.approved_path
  if (row.status === 'rejected') return path.join(STAGING_REJECTED_DIR, path.basename(row.inbox_path))
  return row.inbox_path
}

let _pg = null
function getPgPool () {
  if (!_pg) {
    _pg = new Pool({
      host: process.env.PGHOST ?? 'localhost',
      port: parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user: process.env.PGUSER ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max: 3,
    })
  }
  return _pg
}

function parseSse (raw) {
  const events = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6).trim()
    if (!payload) continue
    try {
      events.push(JSON.parse(payload))
    } catch {
      // Ignore malformed SSE event lines
    }
  }
  return events
}

function parseToolPayload (text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function coerceLimit (limit, fallback = 10, max = 100) {
  const n = Number.isFinite(limit) ? limit : parseInt(limit ?? `${fallback}`, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, max)
}

async function callLocalAgentTool (agentEntry, toolName, args = {}, context = {}, timeoutMs = 30000) {
  return await new Promise((resolve, reject) => {
    const child = spawn('node', [agentEntry], {
      cwd: AMPHION_ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const requestId = randomUUID()
    let stdoutBuffer = ''
    let stderrBuffer = ''
    let settled = false

    const timer = setTimeout(() => {
      fail(new Error(`Timed out calling ${toolName}`))
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timer)
      if (!child.killed) child.kill()
    }

    const fail = (err) => {
      if (settled) return
      settled = true
      cleanup()
      const detail = stderrBuffer.trim()
      if (detail && !String(err.message).includes(detail)) {
        reject(new Error(`${err.message}\n${detail}`))
        return
      }
      reject(err)
    }

    const succeed = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    child.on('error', fail)

    child.stderr.on('data', chunk => {
      stderrBuffer += chunk.toString()
    })

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString()
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let msg
        try {
          msg = JSON.parse(trimmed)
        } catch {
          continue
        }

        if (msg.id !== requestId) continue
        if (msg.error) {
          fail(new Error(msg.error.message ?? `Agent error calling ${toolName}`))
          return
        }

        const text = msg.result?.content?.find(item => item.type === 'text')?.text ?? ''
        succeed(parseToolPayload(text))
        return
      }
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      fail(new Error(`Agent exited before replying (code=${code ?? 'null'}, signal=${signal ?? 'null'})`))
    })

    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args ?? {},
        context: context ?? {},
      },
    }) + '\n')
  })
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function armBrokerHealthGraceWindow (ms = 3000) {
  brokerHealthGraceUntil = Math.max(brokerHealthGraceUntil, Date.now() + ms)
}

function getBrokerHealthGraceMs () {
  return Math.max(0, brokerHealthGraceUntil - Date.now())
}

// ---------------------------------------------------------------------------
// Recall debug helpers — mirrors recall agent logic but exposes internals
// ---------------------------------------------------------------------------

const RECALL_STOP_WORDS = new Set([
  'what','when','where','which','who','how','did','was','were','the','a','an',
  'we','i','you','he','she','they','our','my','your','his','her','their',
  'about','regarding','related','tell','me','said','talked','spoke','discussed',
  'mentioned','think','remember','recall','find','get','search','look','show',
  'conversation','conversations','something','anything',
  'topic','topics','information','info','context','history','past','previous',
  'had','has','have','been','any','all','some','more','other','this','that',
])

function recallExtractKeywords (task) {
  return task
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !RECALL_STOP_WORDS.has(w.toLowerCase()))
    .map(w => w.toLowerCase())
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 8)
}

function recallParseDateRange (task) {
  const now = new Date()
  const text = task.toLowerCase()
  const toDate = d => d.toISOString().slice(0, 10)

  if (/last week/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 7)
    return { from: toDate(from), to: toDate(now) }
  }
  if (/last month|past month/.test(text)) {
    const from = new Date(now); from.setMonth(now.getMonth() - 1)
    return { from: toDate(from), to: toDate(now) }
  }
  if (/yesterday/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 1)
    return { from: toDate(from), to: toDate(from) }
  }
  if (/today/.test(text)) {
    return { from: toDate(now), to: toDate(now) }
  }
  const months = ['january','february','march','april','may','june',
                  'july','august','september','october','november','december']
  for (let i = 0; i < months.length; i++) {
    if (text.includes(months[i])) {
      const year = now.getMonth() <= i ? now.getFullYear() - 1 : now.getFullYear()
      return { from: toDate(new Date(year, i, 1)), to: toDate(new Date(year, i + 1, 0)) }
    }
  }
  const daysMatch = text.match(/last (\d+) days?/)
  if (daysMatch) {
    const from = new Date(now); from.setDate(now.getDate() - parseInt(daysMatch[1], 10))
    return { from: toDate(from), to: toDate(now) }
  }
  if (/\brecent\b/.test(text)) {
    const from = new Date(now); from.setDate(now.getDate() - 3)
    return { from: toDate(from), to: toDate(now) }
  }
  return null
}

function recallScoreRows (rows, keywords) {
  const nowTs = Date.now()
  const minKeywordHits = Math.max(1, Math.min(4, Math.ceil(keywords.length * 0.5)))
  const minScore = keywords.length >= 5 ? 0.52 : 0.42

  return rows.map(r => {
    const text = (r.content ?? '').toLowerCase()
    const keywordHits = keywords.filter(k => text.includes(k))
    const coverage = keywordHits.length / Math.max(keywords.length, 1)
    const exactPhrase = keywords.length > 1 && text.includes(keywords.join(' '))

    let recencyScore = 0
    const ts = Date.parse(r.created_at ?? '')
    if (Number.isFinite(ts)) {
      const ageDays = Math.max(0, (nowTs - ts) / 86_400_000)
      recencyScore = Math.max(0, 1 - Math.min(ageDays / 30, 1))
    }

    const roleScore = r.role === 'user' ? 0.1 : -0.05
    const score = (coverage * 0.68) + (recencyScore * 0.17) + (exactPhrase ? 0.1 : 0) + roleScore

    const passes = keywordHits.length >= minKeywordHits && score >= minScore
    return {
      role: r.role,
      session_id: r.session_id,
      created_at: r.created_at,
      content_preview: (r.content ?? '').slice(0, 200),
      keyword_hits: keywordHits,
      hit_count: keywordHits.length,
      coverage: +coverage.toFixed(3),
      recency_score: +recencyScore.toFixed(3),
      exact_phrase: exactPhrase,
      score: +score.toFixed(3),
      passes_filter: passes,
      filter_reason: passes ? null
        : keywordHits.length < minKeywordHits ? `hit_count ${keywordHits.length} < min ${minKeywordHits}`
        : `score ${score.toFixed(3)} < threshold ${minScore}`,
    }
  }).sort((a, b) => b.score - a.score)
}

async function brokerIsUp () {
  try {
    const res = await fetch(`${BROKER_URL}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForBrokerState (shouldBeUp, timeoutMs = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const up = await brokerIsUp()
    if (up === shouldBeUp) return true
    await sleep(250)
  }
  return false
}

function killBrokerByPort () {
  if (process.platform === 'win32') {
    const ps = `Get-NetTCPConnection -LocalPort ${BROKER_PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; Write-Output \"ok\"`
    const result = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
      cwd: AMPHION_ROOT,
      encoding: 'utf8',
      timeout: 8000,
    })
    if (result.error) throw result.error
    return {
      platform: 'win32',
      exitCode: result.status ?? 0,
      stdout: result.stdout?.trim() ?? '',
      stderr: result.stderr?.trim() ?? '',
    }
  }

  const cmd = `lsof -ti tcp:${BROKER_PORT} | xargs -r kill -9`
  const result = spawnSync('sh', ['-lc', cmd], {
    cwd: AMPHION_ROOT,
    encoding: 'utf8',
    timeout: 8000,
  })
  if (result.error) throw result.error
  return {
    platform: process.platform,
    exitCode: result.status ?? 0,
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  }
}

async function startBrokerProcess () {
  // If a supervisor (start.js) is already running it will restart the broker
  // automatically within a second or two. Wait for that before spawning anything,
  // so we don't accumulate orphan supervisors on every MCP restart call.
  const selfHealed = await waitForBrokerState(true, 4000)
  if (selfHealed) return { pid: null, up: true, selfHealed: true }

  // No supervisor — spawn the broker directly (single process, no supervisor overhead).
  const child = spawn('node', ['apps/broker/src/index.js'], {
    cwd: AMPHION_ROOT,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  const up = await waitForBrokerState(true, 15000)
  return { pid: child.pid, up }
}

function touchReloadFlag () {
  // Writing this file signals the Electron main process (via fs.watch) to
  // reload the renderer page — no process kill, no window flicker.
  const flagPath = path.join(AMPHION_ROOT, 'data', 'reload-renderer.flag')
  try {
    fs.writeFileSync(flagPath, Date.now().toString())
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}

function isElectronRunning () {
  // On Windows, check for the Electron binary or any process with our main.js
  if (process.platform === 'win32') {
    const result = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -like '*electron*dist*electron.exe' } | Measure-Object).Count`
    ], { cwd: AMPHION_ROOT, encoding: 'utf8', timeout: 4000 })
    return parseInt(result.stdout?.trim() ?? '0', 10) > 0
  }
  const result = spawnSync('sh', ['-lc', 'pgrep -f "electron.*main.js" | wc -l'],
    { encoding: 'utf8', timeout: 4000 })
  return parseInt(result.stdout?.trim() ?? '0', 10) > 0
}

function spawnElectron () {
  // Strip VS Code / Electron-host env vars that would break Electron's startup.
  // VS Code runs on Electron and sets ELECTRON_RUN_AS_NODE=1 for its Node children.
  // If that variable propagates to our electron.exe, it runs as plain Node.js and
  // crashes trying to resolve built-in Electron modules.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  delete env.ELECTRON_ENABLE_LOGGING
  delete env.VSCODE_PID
  delete env.VSCODE_NLS_CONFIG
  delete env.VSCODE_HANDLES_UNCAUGHT_ERRORS

  const logPath = path.join(AMPHION_ROOT, 'data', 'traces', 'electron-launch.log')
  const logFd   = fs.openSync(logPath, 'a')
  const child = spawn('node', ['scripts/start.js', '--only', 'desktop'], {
    cwd:         AMPHION_ROOT,
    env,
    detached:    true,
    stdio:       ['ignore', logFd, logFd],
    windowsHide: true,
  })
  fs.closeSync(logFd)
  child.unref()
  return { supervisorPid: child.pid }
}

class AmphionMcpServer extends BaseAgent {
  get name () { return 'amphion-mcp-server' }
  get description () { return 'MCP bridge into Amphion broker, SQLite memory, pgvector KB, and domain agents' }

  // Auto-start services when VS Code connects (notifications/initialized)
  _handleLine (line) {
    let msg
    try { msg = JSON.parse(line) } catch { return super._handleLine(line) }
    if (msg?.method === 'notifications/initialized') {
      brokerIsUp().then(up => {
        if (!up) {
          this.log('broker not running — starting headless services...')
          startBrokerProcess().catch(err => this.log(`auto-start failed: ${err.message}`))
        }
      })
      return
    }
    super._handleLine(line)
  }

  get tools () {
    return [
      {
        name: 'system_restart',
        description: 'Full Amphion system restart: kills the supervisor, broker, watchers, and Electron, then starts everything fresh. Use this after code changes to pick up all modifications.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'broker_health',
        description: 'Check whether Amphion broker is reachable and healthy.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'broker_query',
        description: 'Send a message through Amphion broker (/query), parse SSE, and return ticket plus final response. Also returns all source cards emitted during the response, each with chunk_id, section_header, highlight_phrase, and a content preview — showing exactly what the user would see in the source panel.',
        inputSchema: {
          type: 'object',
          properties: {
            message:   { type: 'string', description: 'User message to send to broker' },
            sessionId: { type: 'string', description: 'Optional session ID to continue context' },
            userId:    { type: 'string', description: 'User identifier for conversation scoping (default: "default")' },
            workspaceId: { type: 'string', description: 'Optional workspace identifier for context scoping' },
          },
          required: ['message'],
        },
      },
      {
        name: 'recent_conversations',
        description: 'Get recent conversation turns from SQLite, either by session or across all sessions.',
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: { type: 'string',  description: 'Optional session ID; if omitted returns global recent turns' },
            userId:    { type: 'string',  description: 'User identifier to scope results (default: "default")' },
            workspaceId: { type: 'string', description: 'Optional workspace identifier for global recent history' },
            limit:     { type: 'integer', description: 'Max turns to return (default 10)' },
          },
        },
      },
      {
        name: 'search_conversations',
        description: 'Keyword search over conversation history in SQLite.',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string',  description: 'Space-separated keywords to search in conversation content' },
            userId: { type: 'string',  description: 'User identifier to scope results (default: "default")' },
            workspaceId: { type: 'string', description: 'Optional workspace identifier to scope conversation search' },
            limit:  { type: 'integer', description: 'Max turns to return (default 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'user_context',
        description: 'Read the current user_context profile from SQLite.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'recall',
        description: 'Resource-native retrieval across corpora, conversations, and reachable external resources. Use this to inform yourself about a topic.',
        inputSchema: {
          type: 'object',
          properties: {
            topic:  { type: 'string', description: 'Topic or question that needs evidence' },
            corpus: { type: 'string', description: 'Optional corpus key, e.g. legal, research, conversations' },
            k:      { type: 'integer', description: 'Number of excerpts to return (default 8, max 20)' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'find',
        description: 'Locate resources by title, filename, path, or subject label. Returns resource_id values you can pass to load.',
        inputSchema: {
          type: 'object',
          properties: {
            name:   { type: 'string', description: 'Name, title, filename, path, or partial label to locate' },
            type:   { type: 'string', description: 'Optional resource type filter: file, directory, document, conversation' },
            corpus: { type: 'string', description: 'Optional corpus key' },
            k:      { type: 'integer', description: 'Max resources to return (default 12, max 50)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'load',
        description: 'Load a resource by resource_id. Works for database resources and external fs: paths returned by find.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Resource ID from recall/find, including fs:C:\\path external IDs' },
            max_chars:   { type: 'integer', description: 'Max characters to return for file-like resources (default 12000)' },
          },
          required: ['resource_id'],
        },
      },
      {
        name: 'reflect',
        description: 'Report the current reflection contract for resource gathering. In the live broker path, sufficiency is computed from observed evidence.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'knowledge_items',
        description: 'Legacy compatibility: read recent resource rows from the canonical store using the old knowledge_items tool name.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Optional domain filter: research|finance|legal|comms|proposals' },
            limit: { type: 'integer', description: 'Max rows to return (default 10)' },
          },
        },
      },
      {
        name: 'run_domain_agent',
        description: 'Compatibility escape hatch: invoke a named Amphion domain agent directly. Prefer recall/find/load for resource-native knowledge access.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Domain name' },
            task: { type: 'string', description: 'Natural language task for that agent' },
            sessionId: { type: 'string', description: 'Optional session ID for context assembly' },
            userId: { type: 'string', description: 'Optional user identifier for context assembly' },
            workspaceId: { type: 'string', description: 'Optional workspace identifier for context assembly' },
          },
          required: ['domain', 'task'],
        },
      },
      {
        name: 'recall_debug',
        description: 'Diagnostic tool: shows exactly how recall would process a query — extracted keywords, parsed date range, every candidate row with its score breakdown, and which rows pass or fail the relevance filter.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Same task string you would send to the recall agent' },
            limit: { type: 'integer', description: 'Max raw candidates to fetch from SQLite before scoring (default 40)' },
          },
          required: ['task'],
        },
      },
      {
        name: 'db_reset',
        description: 'Hard reset: clears Amphion conversation history from SQLite and/or canonical resource knowledge from PostgreSQL. Preserves user_context by default. Use for dev/ops resets before re-ingestion.',
        inputSchema: {
          type: 'object',
          properties: {
            wipe_conversations: { type: 'boolean', description: 'Delete all rows from SQLite conversations table (default true)' },
            wipe_knowledge: { type: 'boolean', description: 'TRUNCATE pgvector knowledge_items table (default true)' },
            wipe_user_context: { type: 'boolean', description: 'Also clear user_context profile row (default false)' },
          },
        },
      },
      {
        name: 'mcp_server_restart',
        description: 'Restart this MCP server process. Exits cleanly so VS Code auto-respawns it, picking up any code changes made to tools/mcp/amphion-server.js or its dependencies. Call this after modifying the MCP server.',
        inputSchema: { type: 'object', properties: {} },
      },
      // -----------------------------------------------------------------------
      {
        name: 'corpus_list',
        description: 'List all corpus registry entries from the corpora table. Shows domain, agent_type, display_name, scope_notes, is_active. Use this to see what knowledge domains exist in the system.',
        inputSchema: {
          type: 'object',
          properties: {
            include_inactive: { type: 'boolean', description: 'Include disabled corpora rows (default false)' },
          },
        },
      },
      {
        name: 'corpus_upsert',
        description: 'Insert or update a corpus registry entry. Use to add a new knowledge domain or modify an existing one. After adding, ingest documents with domain=<new_domain> and restart the broker to activate.',
        inputSchema: {
          type: 'object',
          properties: {
            domain:                  { type: 'string', description: 'Domain key, e.g. "federal", "hr", "engineering"' },
            display_name:            { type: 'string', description: 'Human label, e.g. "US Federal Law"' },
            agent_type:              { type: 'string', description: '"statutes" for chapter/section text, "documents" for free-form files' },
            dispatcher_description:  { type: 'string', description: 'One-sentence description shown to the dispatcher model for routing decisions' },
            scope_notes:             { type: 'string', description: 'What IS in this corpus — injected into the agent ReAct system prompt' },
            not_in_corpus:           { type: 'string', description: 'What is NOT in this corpus — tells model when to stop retrying' },
            is_active:               { type: 'boolean', description: 'Whether the domain is active (default true)' },
          },
          required: ['domain', 'display_name', 'agent_type', 'dispatcher_description', 'scope_notes'],
        },
      },
      {
        name: 'corpus_stats',
        description: 'Resource and chunk counts grouped by corpus.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Optional: filter to a single corpus key' },
          },
        },
      },
      // -----------------------------------------------------------------------
      // Resource-native direct ingest plus compatibility aliases
      // -----------------------------------------------------------------------
      {
        name: 'resources_ingest',
        description: 'Ingest text directly as a resource plus chunk set without using the file staging flow.',
        inputSchema: {
          type: 'object',
          properties: {
            corpus:        { type: 'string', description: 'Target corpus key' },
            title:         { type: 'string', description: 'Resource title' },
            content:       { type: 'string', description: 'Full text content to ingest' },
            resource_type: { type: 'string', description: 'Resource type: document|note|report|spec (default: note)' },
            source_ref:    { type: 'string', description: 'Optional canonical source reference for deduplication' },
            mime_type:     { type: 'string', description: 'Optional mime type (default text/plain)' },
            scope_slug:    { type: 'string', description: 'Optional internal scope slug to make the primary home for this resource' },
            scope_display_name: { type: 'string', description: 'Optional display name when auto-creating the scope' },
            scope_type:    { type: 'string', description: 'Optional internal scope type (default: scope)' },
            scope_metadata:{ type: 'object', description: 'Optional metadata to merge into an auto-created scope' },
            owner_user_id: { type: 'string', description: 'Optional scope owner user identifier (default: default)' },
          },
          required: ['corpus', 'title', 'content'],
        },
      },
      {
        name: 'documents_search',
        description: 'Legacy alias for recall(). Returns resource-backed excerpt results using the old tool name.',
        inputSchema: {
          type: 'object',
          properties: {
            query:   { type: 'string',  description: 'Natural language search query' },
            domain:  { type: 'string',  description: 'Optional domain filter (e.g. "legal", "research")' },
            k:       { type: 'integer', description: 'Number of chunks to return (default 8, max 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'documents_ingest',
        description: 'Legacy alias for resources_ingest(). Keeps older callers working while direct ingest moves to resources.',
        inputSchema: {
          type: 'object',
          properties: {
            domain:    { type: 'string', description: 'Target domain (must exist in corpora table)' },
            title:     { type: 'string', description: 'Document title' },
            content:   { type: 'string', description: 'Full text content to ingest' },
            doc_type:  { type: 'string', description: 'Document type: document|note|report|spec (default: note)' },
            source_path: { type: 'string', description: 'Optional canonical source path or URL for deduplication' },
            scope_slug: { type: 'string', description: 'Optional internal scope slug to make the primary home for this resource' },
            scope_display_name: { type: 'string', description: 'Optional display name when auto-creating the scope' },
            scope_type: { type: 'string', description: 'Optional internal scope type (default: scope)' },
            scope_metadata: { type: 'object', description: 'Optional metadata to merge into an auto-created scope' },
            owner_user_id: { type: 'string', description: 'Optional scope owner user identifier (default: default)' },
          },
          required: ['domain', 'title', 'content'],
        },
      },
      {
        name: 'learn_plan_create',
        description: 'Create a learn-plan record for a background collection job before content is approved for ingest.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional short title for the learn job' },
            request: { type: 'string', description: 'The original learn request, e.g. "learn about helicopters"' },
            user_id: { type: 'string', description: 'Owning user identifier (default: default)' },
            requested_by: { type: 'string', description: 'Actor that created the plan (default: default)' },
            status: { type: 'string', description: 'Initial plan status (default: draft)' },
            summary: { type: 'string', description: 'Optional summary of what has been found so far' },
            findings: { type: 'object', description: 'Optional structured findings payload' },
            proposal: { type: 'object', description: 'Optional proposed corpus/scope/entity actions' },
            metadata: { type: 'object', description: 'Optional structured metadata for the learn job' },
          },
          required: ['request'],
        },
      },
      {
        name: 'learn_plan_run',
        description: 'Run one inline learn batch: create or update a learn plan, expand local folders into supported files, and stage direct URLs or local files into review hold.',
        inputSchema: {
          type: 'object',
          properties: {
            learn_plan_id: { type: 'string', description: 'Optional existing learn plan to append sources to' },
            title: { type: 'string', description: 'Optional short title for the learn batch' },
            request: { type: 'string', description: 'The original learn request, e.g. "learn about helicopters"' },
            user_id: { type: 'string', description: 'Owning user identifier (default: default)' },
            requested_by: { type: 'string', description: 'Actor that started the run (default: default)' },
            corpus: { type: 'string', description: 'Target corpus key (default: research)' },
            domain: { type: 'string', description: 'Legacy alias for corpus' },
            metadata: { type: 'object', description: 'Optional structured metadata stored on the plan and staged files' },
            urls: {
              type: 'array',
              description: 'Optional list of direct URLs to acquire',
              items: { type: 'string' },
            },
            file_paths: {
              type: 'array',
              description: 'Optional list of local file or folder paths',
              items: { type: 'string' },
            },
            sources: {
              type: 'array',
              description: 'Optional mixed source list. Each item may provide url or filePath plus optional label/metadata.',
              items: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  filePath: { type: 'string' },
                  label: { type: 'string' },
                  metadata: { type: 'object' },
                },
              },
            },
          },
        },
      },
      {
        name: 'learn_plan_list',
        description: 'List learn plans and their review state.',
        inputSchema: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'Optional status filter' },
            user_id: { type: 'string', description: 'Optional owner filter' },
            limit: { type: 'integer', description: 'Max rows to return (default 50)' },
          },
        },
      },
      {
        name: 'learn_plan_get',
        description: 'Read one learn plan plus the staged files currently attached to it.',
        inputSchema: {
          type: 'object',
          properties: {
            learn_plan_id: { type: 'string', description: 'Learn plan identifier' },
          },
          required: ['learn_plan_id'],
        },
      },
      {
        name: 'learn_plan_update',
        description: 'Update a learn plan report as a background collection job discovers sources and proposes structure.',
        inputSchema: {
          type: 'object',
          properties: {
            learn_plan_id: { type: 'string', description: 'Learn plan identifier' },
            title: { type: 'string', description: 'Optional revised title' },
            request: { type: 'string', description: 'Optional revised request text' },
            status: { type: 'string', description: 'Updated plan status' },
            summary: { type: 'string', description: 'Updated summary text' },
            findings: { type: 'object', description: 'Structured findings payload' },
            proposal: { type: 'object', description: 'Structured proposal payload' },
            metadata: { type: 'object', description: 'Structured metadata payload' },
            decision_notes: { type: 'string', description: 'Optional operator notes' },
          },
          required: ['learn_plan_id'],
        },
      },
      {
        name: 'learn_plan_decide',
        description: 'Approve or reject a learn plan. Approval releases review-held files into approved/ so watch-ingest can process them.',
        inputSchema: {
          type: 'object',
          properties: {
            learn_plan_id: { type: 'string', description: 'Learn plan identifier' },
            decision: { type: 'string', description: 'approve or reject' },
            decision_notes: { type: 'string', description: 'Optional operator rationale' },
            apply_to_staged_files: { type: 'boolean', description: 'Whether to move attached review-held files automatically (default true)' },
          },
          required: ['learn_plan_id', 'decision'],
        },
      },
      // -----------------------------------------------------------------------
      // Self-organizing agent data
      // -----------------------------------------------------------------------
      {
        name: 'query_patterns',
        description: 'Returns aggregated query pattern data from the query_log table: top domains hit, top intents, daily query counts, and recent samples. Used to understand what topics are accumulating and whether a new workspace or corpus is warranted.',
        inputSchema: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: 'Filter to a specific user (omit for all users)' },
            since:  { type: 'string', description: 'ISO date string, e.g. "2026-04-01" (default: last 30 days)' },
          },
        },
      },
      {
        name: 'organization_report',
        description: 'Returns the most recent organization notes written by the self-organizing agent (organizer.js). Shows what workspaces were auto-created, what topics triggered them, and when. Ask Atlas "what have you organized lately?" to surface this.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'Max number of notes to return (default 5)' },
          },
        },
      },
      {
        name: 'scope_upsert',
        description: 'Create or update an internal scope container used for active task isolation, project organization, or grouped knowledge routing.',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Stable internal scope key' },
            display_name: { type: 'string', description: 'Human-readable scope label' },
            owner_user_id: { type: 'string', description: 'Owning user identifier (default: default)' },
            description: { type: 'string', description: 'Optional summary of what this scope represents' },
            scope_type: { type: 'string', description: 'Optional internal scope type such as scope, project, matter, or collection' },
            parent_scope_slug: { type: 'string', description: 'Optional parent scope slug for hierarchy' },
            metadata: { type: 'object', description: 'Optional structured metadata such as client, stage, or operational hints' },
            is_active: { type: 'boolean', description: 'Whether the scope is active (default true)' },
            closed_at: { type: 'string', description: 'Optional archival timestamp in ISO format' },
          },
        },
      },
      {
        name: 'scope_list',
        description: 'List internal scopes with optional owner, parent, or text filters.',
        inputSchema: {
          type: 'object',
          properties: {
            owner_user_id: { type: 'string', description: 'Optional scope owner filter' },
            parent_scope_slug: { type: 'string', description: 'Optional parent scope slug filter' },
            include_closed: { type: 'boolean', description: 'Include archived or inactive scopes' },
            query: { type: 'string', description: 'Optional text filter over slug, name, and description' },
            limit: { type: 'integer', description: 'Max scopes to return (default 50)' },
          },
        },
      },
      {
        name: 'scope_attach_resource',
        description: 'Attach an existing resource to an internal scope, optionally marking that scope as the resource\'s primary home.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Existing resource ID to attach' },
            scope_slug: { type: 'string', description: 'Internal scope slug' },
            is_primary: { type: 'boolean', description: 'Mark this scope as the primary home for the resource' },
            metadata: { type: 'object', description: 'Optional metadata for this membership' },
          },
          required: ['resource_id', 'scope_slug'],
        },
      },
      {
        name: 'entity_upsert',
        description: 'Create or update a reusable entity such as a person, company, project, part, vendor, or task.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'Entity type such as person, company, part, task, project, or deal' },
            display_name: { type: 'string', description: 'Human-readable entity name' },
            slug: { type: 'string', description: 'Optional stable entity slug; defaults to a slugified display name' },
            description: { type: 'string', description: 'Optional short description' },
            owner_user_id: { type: 'string', description: 'Owning user identifier (default: default)' },
            home_scope_slug: { type: 'string', description: 'Optional home scope slug for this entity' },
            metadata: { type: 'object', description: 'Optional structured metadata' },
          },
          required: ['kind', 'display_name'],
        },
      },
      {
        name: 'entity_list',
        description: 'List reusable entities with optional kind, home scope, or text filters.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', description: 'Optional entity kind filter' },
            home_scope_slug: { type: 'string', description: 'Optional home scope slug filter' },
            query: { type: 'string', description: 'Optional text filter over name and description' },
            limit: { type: 'integer', description: 'Max entities to return (default 50)' },
          },
        },
      },
      {
        name: 'entity_attach_resource',
        description: 'Attach an existing resource to a reusable entity with a typed relationship such as mentions, describes, or evidence_for.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Existing resource ID to attach' },
            entity_kind: { type: 'string', description: 'Entity kind' },
            entity_slug: { type: 'string', description: 'Entity slug' },
            relation_type: { type: 'string', description: 'Relationship type (default: mentions)' },
            confidence: { type: 'number', description: 'Confidence between 0 and 1 (default 1)' },
            metadata: { type: 'object', description: 'Optional structured metadata for this link' },
          },
          required: ['resource_id', 'entity_kind', 'entity_slug'],
        },
      },
      {
        name: 'entity_link',
        description: 'Create or update a typed relationship between two reusable entities.',
        inputSchema: {
          type: 'object',
          properties: {
            from_entity_kind: { type: 'string', description: 'Source entity kind' },
            from_entity_slug: { type: 'string', description: 'Source entity slug' },
            to_entity_kind: { type: 'string', description: 'Target entity kind' },
            to_entity_slug: { type: 'string', description: 'Target entity slug' },
            relation_type: { type: 'string', description: 'Typed relationship label' },
            strength: { type: 'number', description: 'Relationship strength between 0 and 1 (default 1)' },
            source_resource_id: { type: 'string', description: 'Optional source resource grounding this relationship' },
            metadata: { type: 'object', description: 'Optional structured metadata for this relationship' },
          },
          required: ['from_entity_kind', 'from_entity_slug', 'to_entity_kind', 'to_entity_slug', 'relation_type'],
        },
      },
      {
        name: 'staging_list',
        description: 'Lists files currently in the staging pipeline (inbox → scan → review/approved/rejected → ingested). Use this to see what content is queued, pending review, or waiting manual action.',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: pending | scanning | review | approved | rejected | ingested (omit for all active files)',
            },
            limit: { type: 'integer', description: 'Max rows to return (default 50)' },
          },
        },
      },
      {
        name: 'staging_approve',
        description: 'Manually promote a rejected file to approved so it gets ingested. Use when you have reviewed a file in data/staging/rejected/ and determined it is safe.',
        inputSchema: {
          type: 'object',
          properties: {
            stagingId: { type: 'string', description: 'UUID of the staged_files row (from staging_list)' },
          },
          required: ['stagingId'],
        },
      },
      {
        name: 'staging_reject',
        description: 'Manually reject a staged file (e.g. one that passed scan but you do not want ingested). The file stays in rejected/ and will not be auto-ingested.',
        inputSchema: {
          type: 'object',
          properties: {
            stagingId: { type: 'string', description: 'UUID of the staged_files row (from staging_list)' },
            reason:    { type: 'string', description: 'Optional reason for rejection' },
          },
          required: ['stagingId'],
        },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'system_restart':
        return this.systemRestart()
      case 'broker_health':
        return this.brokerHealth()
      case 'broker_query':
        return this.brokerQuery(args)
      case 'recent_conversations':
        return this.recentConversations(args)
      case 'search_conversations':
        return this.searchConversations(args)
      case 'user_context':
        return this.userContext()
      case 'recall':
        return this.recall(args)
      case 'find':
        return this.find(args)
      case 'load':
        return this.load(args)
      case 'reflect':
        return this.reflect(args)
      case 'knowledge_items':
        return this.knowledgeItems(args)
      case 'run_domain_agent':
        return this.runDomainAgent(args)
      case 'recall_debug':
        return this.recallDebug(args)
      case 'db_reset':
        return this.dbReset(args)
      case 'mcp_server_restart':
        return this.mcpServerRestart()
      case 'corpus_list':
        return this.corpusList(args)
      case 'corpus_upsert':
        return this.corpusUpsert(args)
      case 'corpus_stats':
        return this.corpusStats(args)
      case 'resources_ingest':
        return this.resourcesIngest(args)
      case 'documents_search':
        return this.documentsSearch(args)
      case 'documents_ingest':
        return this.documentsIngest(args)
      case 'learn_plan_create':
        return this.learnPlanCreate(args)
      case 'learn_plan_run':
        return this.learnPlanRun(args)
      case 'learn_plan_list':
        return this.learnPlanList(args)
      case 'learn_plan_get':
        return this.learnPlanGet(args)
      case 'learn_plan_update':
        return this.learnPlanUpdate(args)
      case 'learn_plan_decide':
        return this.learnPlanDecide(args)
      case 'query_patterns':
        return this.queryPatterns(args)
      case 'organization_report':
        return this.organizationReport(args)
      case 'scope_upsert':
        return this.scopeUpsert(args)
      case 'scope_list':
        return this.scopeList(args)
      case 'scope_attach_resource':
        return this.scopeAttachResource(args)
      case 'entity_upsert':
        return this.entityUpsert(args)
      case 'entity_list':
        return this.entityList(args)
      case 'entity_attach_resource':
        return this.entityAttachResource(args)
      case 'entity_link':
        return this.entityLink(args)
      case 'staging_list':
        return this.stagingList(args)
      case 'staging_approve':
        return this.stagingApprove(args)
      case 'staging_reject':
        return this.stagingReject(args)
      default:
        throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async systemRestart () {
    // 1. Kill Electron
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        'Get-WmiObject Win32_Process | Where-Object { $_.ExecutablePath -like "*electron*dist*electron.exe" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output "ok"'
      ], { cwd: AMPHION_ROOT, encoding: 'utf8', timeout: 6000 })
    } else {
      spawnSync('sh', ['-lc', 'pkill -f "electron.*main.js" || true'], { encoding: 'utf8', timeout: 6000 })
    }

    // 2. Kill the start.js supervisor (its children — broker, watchers — die with it)
    if (process.platform === 'win32') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        'Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like "*start.js*" -and $_.CommandLine -notlike "*system32*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Write-Output "ok"'
      ], { cwd: AMPHION_ROOT, encoding: 'utf8', timeout: 6000 })
    } else {
      spawnSync('sh', ['-lc', 'pkill -f "scripts/start.js" || true'], { encoding: 'utf8', timeout: 6000 })
    }

    // 3. Kill anything still holding the broker port
    killBrokerByPort()

    // Wait for broker to go down
    await waitForBrokerState(false, 6000)

    // 4. Start fresh supervisor (headless — no electron)
    const supervisor = spawn('node', ['scripts/start.js', '--headless'], {
      cwd: AMPHION_ROOT,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    supervisor.unref()

    // 5. Wait for broker to come up
    const healthy = await waitForBrokerState(true, 20000)
    if (healthy) armBrokerHealthGraceWindow(3000)

    // 6. Start Electron fresh
    const electronResult = spawnElectron()

    return {
      ok: healthy,
      supervisorPid: supervisor.pid,
      electron: electronResult,
      message: healthy
        ? 'Full system restart complete — supervisor, broker, watchers, and Electron all fresh.'
        : 'Supervisor started but broker did not become healthy in time.',
    }
  }

  async brokerHealth () {
    const graceMs = getBrokerHealthGraceMs()
    if (graceMs > 0) {
      await waitForBrokerState(true, graceMs)
    }

    const res = await fetch(`${BROKER_URL}/health`, {
      signal: AbortSignal.timeout(graceMs > 0 ? 3000 : 1500),
    })
    if (!res.ok) throw new Error(`Broker health failed: HTTP ${res.status}`)
    const payload = await res.json()
    if (graceMs > 0) payload.settle_wait_ms = graceMs
    return payload
  }

  async brokerStart () {
    if (await brokerIsUp()) {
      return { ok: true, alreadyRunning: true, message: 'Broker already running.' }
    }

    const started = await startBrokerProcess()
    if (!started.up) {
      return {
        ok: false,
        startedPid: started.pid,
        message: 'Broker process started but health check did not become ready in time.',
      }
    }

    return { ok: true, alreadyRunning: false, startedPid: started.pid, message: 'Broker started successfully.' }
  }

  async brokerStop () {
    const wasUp = await brokerIsUp()
    const killResult = killBrokerByPort()
    const down = await waitForBrokerState(false, 8000)

    return {
      ok: down,
      wasUp,
      stopped: down,
      kill: killResult,
      message: down ? 'Broker stopped successfully.' : 'Broker stop requested but health endpoint still appears up.',
    }
  }

  async brokerRestart () {
    // Always do a full system restart — cleaner than a partial broker-only restart.
    return this.systemRestart()
  }

  async brokerRecover () {
    const before = await brokerIsUp()
    if (before) {
      return { ok: true, action: 'none', message: 'Broker already healthy; no recovery action needed.' }
    }

    const restart = await this.brokerRestart()
    const after = await brokerIsUp()

    return {
      ok: after,
      action: 'restart',
      beforeHealthy: before,
      afterHealthy: after,
      restart,
      message: after ? 'Recovery succeeded (restart healthy).' : 'Recovery failed (broker still unhealthy after restart).',
    }
  }

  async brokerQuery ({ message, sessionId, userId = 'default', workspaceId = null }) {
    const res = await fetch(`${BROKER_URL}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: sessionId ?? randomUUID(), userId, workspaceId }),
    })

    if (!res.ok) throw new Error(`Broker query failed: HTTP ${res.status}`)

    const raw = await res.text()
    const events = parseSse(raw)

    const ticketEvent = events.find(e => e.type === 'ticket')
    const responseEvent = events.find(e => e.type === 'response')
    const tokenContent = events.filter(e => e.type === 'token').map(e => e.token ?? '').join('')

    const cards = events
      .filter(e => (e.type === 'evidence_card' || e.type === 'card') && e.card)
      .map(e => ({
        chunk_id:        e.card.chunk_id ?? null,
        title:           e.card.title ?? null,
        section_header:  e.card.section_header ?? null,
        highlight_phrase: e.card.highlight_phrase ?? null,
        content_preview: (e.card.content ?? '').slice(0, 300),
      }))

    return {
      sessionId:  responseEvent?.sessionId ?? sessionId,
      ticket:     ticketEvent?.data ?? null,
      response:   responseEvent?.content ?? tokenContent,
      eventCount: events.length,
      cards,
    }
  }

  recentConversations ({ sessionId, userId = 'default', workspaceId = null, limit = 10 } = {}) {
    const n = coerceLimit(limit, 10, 100)
    if (sessionId?.trim()) {
      return { scope: 'session', sessionId, userId, turns: getRecentHistory(sessionId, n, userId) }
    }
    return { scope: 'global', userId, workspaceId, turns: getGlobalRecentHistory(n, userId, workspaceId) }
  }

  searchConversations ({ query, userId = 'default', workspaceId = null, limit = 20 }) {
    const terms = String(query)
      .split(/\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 8)

    const rows = searchConversationsByKeywords(terms, coerceLimit(limit, 20, 100), userId, workspaceId)
    return { terms, userId, workspaceId, count: rows.length, turns: rows }
  }

  queryPatterns ({ userId = null, since = null } = {}) {
    return getQueryPatterns({ userId: userId || null, since: since || null })
  }

  async organizationReport ({ limit = 5 } = {}) {
    const pool = getPgPool()
    const n = coerceLimit(limit, 5, 20)
    const { rows } = await pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             COALESCE(r.stored_path, r.source_ref) AS source_path,
             r.created_at,
             LEFT(COALESCE(c.content, r.summary, ''), 1200) AS content
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT content FROM chunks
        WHERE resource_id = r.id ORDER BY chunk_index LIMIT 1
      ) c ON TRUE
      WHERE co.domain = $1 OR co.slug = $1
      ORDER BY r.created_at DESC
      LIMIT $2
    `, ['system-notes', n])
    return {
      count: rows.length,
      notes: rows.map(r => ({
        resource_id: r.resource_id,
        title:      r.title,
        created_at: r.created_at,
        source_path: r.source_path,
        content:    r.content ?? '(no content)',
      })),
    }
  }

  async scopeUpsert ({
    slug,
    display_name,
    owner_user_id = 'default',
    description = null,
    scope_type = 'scope',
    parent_scope_slug = null,
    metadata = {},
    is_active = true,
    closed_at = null,
  } = {}) {
    const scope = await upsertScope({
      slug,
      displayName: display_name,
      ownerUserId: owner_user_id,
      description,
      scopeType: scope_type,
      parentScopeSlug: parent_scope_slug,
      metadata,
      isActive: is_active,
      closedAt: closed_at,
    })
    return { ok: true, scope }
  }

  async scopeList ({ owner_user_id = null, parent_scope_slug = null, include_closed = false, query = null, limit = 50 } = {}) {
    const scopes = await listScopes({
      ownerUserId: owner_user_id,
      parentScopeSlug: parent_scope_slug,
      includeClosed: include_closed,
      query,
      limit,
    })
    return { count: scopes.length, scopes }
  }

  async scopeAttachResource ({ resource_id, scope_slug, is_primary = false, metadata = {} } = {}) {
    if (!`${resource_id ?? ''}`.trim()) throw new Error('resource_id is required')
    if (!`${scope_slug ?? ''}`.trim()) throw new Error('scope_slug is required')
    const link = await attachResourceToScope({
      resourceId: resource_id,
      scopeSlug: scope_slug,
      isPrimary: is_primary,
      metadata,
    })
    const scope = await getScope({ scopeSlug: scope_slug })
    return { ok: true, link, scope }
  }

  async entityUpsert ({
    kind,
    display_name,
    slug = null,
    description = null,
    owner_user_id = 'default',
    home_scope_slug = null,
    metadata = {},
  } = {}) {
    const entity = await upsertEntity({
      kind,
      displayName: display_name,
      slug,
      description,
      ownerUserId: owner_user_id,
      homeScopeSlug: home_scope_slug,
      metadata,
    })
    return { ok: true, entity }
  }

  async entityList ({ kind = null, home_scope_slug = null, query = null, limit = 50 } = {}) {
    const entities = await listEntities({
      kind,
      homeScopeSlug: home_scope_slug,
      query,
      limit,
    })
    return { count: entities.length, entities }
  }

  async entityAttachResource ({ resource_id, entity_kind, entity_slug, relation_type = 'mentions', confidence = 1, metadata = {} } = {}) {
    if (!`${resource_id ?? ''}`.trim()) throw new Error('resource_id is required')
    if (!`${entity_kind ?? ''}`.trim()) throw new Error('entity_kind is required')
    if (!`${entity_slug ?? ''}`.trim()) throw new Error('entity_slug is required')
    const link = await attachResourceToEntity({
      resourceId: resource_id,
      entityKind: entity_kind,
      entitySlug: entity_slug,
      relationType: relation_type,
      confidence,
      metadata,
    })
    const entity = await getEntity({ entityKind: entity_kind, entitySlug: entity_slug })
    return { ok: true, link, entity }
  }

  async entityLink ({
    from_entity_kind,
    from_entity_slug,
    to_entity_kind,
    to_entity_slug,
    relation_type,
    strength = 1,
    source_resource_id = null,
    metadata = {},
  } = {}) {
    const link = await linkEntities({
      fromEntityKind: from_entity_kind,
      fromEntitySlug: from_entity_slug,
      toEntityKind: to_entity_kind,
      toEntitySlug: to_entity_slug,
      relationType: relation_type,
      strength,
      sourceResourceId: source_resource_id,
      metadata,
    })
    return { ok: true, link }
  }

  stagingList ({ status = null, limit = 50 } = {}) {
    const n = coerceLimit(limit, 50, 200)
    const rows = getStagedFiles({ status: status || null, limit: n })
    return {
      count: rows.length,
      files: rows,
    }
  }

  stagingApprove ({ stagingId } = {}) {
    if (!stagingId) throw new Error('stagingId is required')
    const row = getStagedFileById(stagingId)
    if (!row) throw new Error(`No staged file found with id=${stagingId}`)
    if (!['review', 'rejected'].includes(row.status)) {
      throw new Error(`stagingId=${stagingId} is not awaiting approval (status=${row.status})`)
    }

    const currentPath = resolveCurrentStagedPath(row)
    const approvedPath = path.join(STAGING_APPROVED_DIR, path.basename(currentPath))

    if (!currentPath || !fs.existsSync(currentPath)) {
      throw new Error(`File not found for approval: ${path.basename(row.inbox_path)}`)
    }
    moveFileSafe(currentPath, approvedPath)

    const now = new Date().toISOString()
    updateStagedStatus(stagingId, 'approved', {
      scanResult:   'pass',
      scanNotes:    'manually approved via MCP tool',
      reviewPath:   null,
      approvedPath,
      approvedAt:   now,
    })

    return { ok: true, stagingId, approvedPath, message: 'File moved to approved/ — watch-ingest will pick it up shortly.' }
  }

  stagingReject ({ stagingId, reason = 'manually rejected' } = {}) {
    if (!stagingId) throw new Error('stagingId is required')
    const row = getStagedFileById(stagingId)
    if (!row) throw new Error(`No staged file found with id=${stagingId}`)

    if (['review', 'approved'].includes(row.status)) {
      const currentPath = resolveCurrentStagedPath(row)
      if (currentPath && fs.existsSync(currentPath)) {
        const rejectedPath = path.join(STAGING_REJECTED_DIR, path.basename(currentPath))
        moveFileSafe(currentPath, rejectedPath)
      }
    }

    updateStagedStatus(stagingId, 'rejected', {
      scanResult: 'fail',
      scanNotes:  reason,
      reviewPath: null,
      approvedPath: null,
    })
    return { ok: true, stagingId, reason }
  }

  userContext () {
    return getUserContext()
  }

  async recall ({ topic, corpus, k = 8 } = {}) {
    if (!`${topic ?? ''}`.trim()) throw new Error('topic is required')
    return await callLocalAgentTool(KNOWLEDGE_AGENT_ENTRY, 'recall', { topic, corpus, k })
  }

  async find ({ name, type, corpus, k = 12 } = {}) {
    if (!`${name ?? ''}`.trim()) throw new Error('name is required')
    return await callLocalAgentTool(KNOWLEDGE_AGENT_ENTRY, 'find', { name, type, corpus, k })
  }

  async load ({ resource_id, max_chars = 12000 } = {}) {
    if (!`${resource_id ?? ''}`.trim()) throw new Error('resource_id is required')
    return await callLocalAgentTool(KNOWLEDGE_AGENT_ENTRY, 'load', { resource_id, max_chars })
  }

  async reflect (_args = {}) {
    return await callLocalAgentTool(KNOWLEDGE_AGENT_ENTRY, 'reflect', {})
  }

  async knowledgeItems ({ domain, limit = 10 } = {}) {
    const pool = getPgPool()
    const n = coerceLimit(limit, 10, 100)

    const params = []
    const filters = []
    if (domain?.trim()) {
      params.push(domain)
      filters.push(`(co.domain = $1 OR co.slug = $1)`)
    }
    params.push(n)
    const limitParam = params.length

    const { rows } = await pool.query(`
      SELECT r.id AS resource_id,
             r.title,
             co.domain,
             COALESCE(co.slug, co.domain) AS corpus,
             COALESCE(r.stored_path, r.source_ref) AS source_path,
             r.metadata,
             r.created_at,
             LEFT(COALESCE(ch.content, r.summary, ''), 300) AS preview
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      LEFT JOIN LATERAL (
        SELECT content
        FROM chunks
        WHERE resource_id = r.id
        ORDER BY chunk_index
        LIMIT 1
      ) ch ON TRUE
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC
      LIMIT $${limitParam}
    `, params)

    return {
      domain: domain ?? null,
      count: rows.length,
      compatibility_alias: 'resources',
      items: rows,
    }
  }

  async runDomainAgent ({ domain, task, sessionId, userId = 'default', workspaceId = null }) {
    const sid = sessionId ?? randomUUID()
    const context = assembleContext(sid, userId, workspaceId)
    return await runAgent(domain, task, context)
  }

  recallDebug ({ task, limit = 40 }) {
    const sqlitePath = process.env.SQLITE_PATH
      ? path.resolve(process.env.SQLITE_PATH)
      : path.resolve(AMPHION_ROOT, 'data/memory.db')

    const db = new DatabaseSync(sqlitePath)

    const keywords = recallExtractKeywords(task)
    const dateRange = recallParseDateRange(task)

    let rawRows = []
    let queryDesc = ''

    if (keywords.length) {
      const conditions = keywords.map(() => `content LIKE ?`).join(' OR ')
      const params = keywords.map(k => `%${k}%`)
      rawRows = db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations
        WHERE ${conditions}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...params, coerceLimit(limit, 40, 200))
      queryDesc = `keyword OR-match: [${keywords.join(', ')}]`
    } else if (dateRange) {
      rawRows = db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(dateRange.from, dateRange.to + 'T23:59:59', coerceLimit(limit, 40, 200))
      queryDesc = `date range: ${dateRange.from} → ${dateRange.to}`
    } else {
      rawRows = db.prepare(`
        SELECT role, content, created_at, session_id
        FROM conversations ORDER BY created_at DESC LIMIT ?
      `).all(coerceLimit(limit, 40, 200))
      queryDesc = 'recency (no topic anchor)'
    }

    const scored = keywords.length
      ? recallScoreRows(rawRows, keywords)
      : rawRows.map(r => ({
          role: r.role,
          session_id: r.session_id,
          created_at: r.created_at,
          content_preview: (r.content ?? '').slice(0, 200),
          keyword_hits: [],
          hit_count: 0,
          coverage: 0,
          recency_score: 0,
          exact_phrase: false,
          score: 0,
          passes_filter: true,
          filter_reason: null,
        }))

    db.close()

    const passing = scored.filter(r => r.passes_filter)
    const filtered = scored.filter(r => !r.passes_filter)

    return {
      task,
      keywords,
      date_range: dateRange,
      sql_query: queryDesc,
      raw_candidate_count: rawRows.length,
      passing_count: passing.length,
      filtered_count: filtered.length,
      passing_rows: passing,
      filtered_rows: filtered,
    }
  }

  async dbReset ({ wipe_conversations = true, wipe_knowledge = true, wipe_user_context = false } = {}) {
    const result = {}

    // SQLite
    const sqlitePath = process.env.SQLITE_PATH
      ? path.resolve(process.env.SQLITE_PATH)
      : path.resolve(AMPHION_ROOT, 'data/memory.db')

    const db = new DatabaseSync(sqlitePath)

    if (wipe_conversations) {
      const r = db.prepare('DELETE FROM conversations').run()
      result.conversations_deleted = r.changes
    }

    if (wipe_user_context) {
      db.prepare('DELETE FROM user_context').run()
      db.prepare('INSERT OR IGNORE INTO user_context (id) VALUES (1)').run()
      result.user_context_cleared = true
    }

    db.close()

    // PostgreSQL — wipe canonical resource storage plus any remaining legacy tables.
    if (wipe_knowledge) {
      const pool = getPgPool()

      const candidateTables = ['resource_scope_stats', 'entity_links', 'resource_entities', 'resource_workspaces', 'entities', 'chunks', 'resources', 'artifacts', 'documents', 'knowledge_items']
      const { rows: tableRows } = await pool.query(
        `SELECT table_name
         FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [candidateTables],
      )
      const existingTables = new Set(tableRows.map(row => row.table_name))
      const tablesToTruncate = candidateTables.filter(name => existingTables.has(name))

      for (const tableName of tablesToTruncate) {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`)
        result[`${tableName}_deleted`] = rows[0]?.count ?? 0
      }

      if (tablesToTruncate.length > 0) {
        await pool.query(`TRUNCATE TABLE ${tablesToTruncate.join(', ')} RESTART IDENTITY CASCADE`)
      }
    }

    result.ok = true
    result.message = `Reset complete. ${result.conversations_deleted ?? 0} conversations, ${result.resources_deleted ?? result.documents_deleted ?? result.knowledge_items_deleted ?? 0} resources, ${result.chunks_deleted ?? 0} chunks wiped.`
    return result
  }

  mcpServerRestart () {
    // Reply is sent before the process exits, so VS Code receives the result
    // then detects the clean exit and auto-respawns the server.
    setImmediate(() => {
      process.exit(0)
    })
    return { ok: true, message: 'MCP server restarting — VS Code will respawn it momentarily.' }
  }

  // ---------------------------------------------------------------------------
  // Corpus registry tools
  // ---------------------------------------------------------------------------

  async corpusList ({ include_inactive = false } = {}) {
    const pool = getPgPool()
    const { rows } = await pool.query(
      `SELECT domain, display_name, agent_type, dispatcher_description,
              scope_notes, not_in_corpus, is_active, created_at, updated_at
       FROM corpora
       ${include_inactive ? '' : 'WHERE is_active = true'}
       ORDER BY domain`
    )
    return { count: rows.length, corpora: rows }
  }

  async corpusUpsert ({
    domain, display_name, agent_type, dispatcher_description,
    scope_notes, not_in_corpus = '', is_active = true,
  }) {
    const pool = getPgPool()
    const { rows } = await pool.query(
      `INSERT INTO corpora (domain, display_name, agent_type, dispatcher_description, scope_notes, not_in_corpus, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (domain) DO UPDATE SET
         display_name           = EXCLUDED.display_name,
         agent_type             = EXCLUDED.agent_type,
         dispatcher_description = EXCLUDED.dispatcher_description,
         scope_notes            = EXCLUDED.scope_notes,
         not_in_corpus          = EXCLUDED.not_in_corpus,
         is_active              = EXCLUDED.is_active,
         updated_at             = NOW()
       RETURNING domain, display_name, agent_type, is_active, updated_at`,
      [domain, display_name, agent_type, dispatcher_description, scope_notes, not_in_corpus, is_active]
    )
    return { ok: true, corpus: rows[0] }
  }

  async corpusStats ({ domain } = {}) {
    const pool = getPgPool()
    let rows
    if (domain?.trim()) {
      ;({ rows } = await pool.query(
        `SELECT COALESCE(c.slug, c.domain) AS corpus,
                COUNT(DISTINCT r.id)::int AS resource_count,
                COUNT(ch.id)::int AS chunk_count,
                MAX(r.updated_at) AS last_updated
         FROM corpora c
         LEFT JOIN resources r ON r.corpus_id = c.id
         LEFT JOIN chunks ch ON ch.resource_id = r.id
         WHERE c.domain = $1 OR c.slug = $1
         GROUP BY c.domain, c.slug`,
        [domain]
      ))
    } else {
      ;({ rows } = await pool.query(
        `SELECT COALESCE(c.slug, c.domain) AS corpus,
                COUNT(DISTINCT r.id)::int AS resource_count,
                COUNT(ch.id)::int AS chunk_count,
                MAX(r.updated_at) AS last_updated
         FROM corpora c
         LEFT JOIN resources r ON r.corpus_id = c.id
         LEFT JOIN chunks ch ON ch.resource_id = r.id
         GROUP BY c.domain, c.slug
         ORDER BY COALESCE(c.slug, c.domain)`
      ))
    }
    return { stats: rows }
  }

  // ---------------------------------------------------------------------------
  // Resource ingest and compatibility aliases
  // ---------------------------------------------------------------------------

  async resourcesIngest ({
    corpus,
    title,
    content,
    resource_type = 'note',
    source_ref,
    mime_type = 'text/plain',
    scope_slug = null,
    scope_display_name = null,
    scope_type = 'scope',
    scope_metadata = {},
    owner_user_id = 'default',
  }) {
    const corpusSlug = `${corpus ?? ''}`.trim()
    if (!corpusSlug) throw new Error('corpus is required')
    if (!`${title ?? ''}`.trim()) throw new Error('title is required')
    if (!`${content ?? ''}`.trim()) throw new Error('content is required')

    const normalizedContent = `${content}`
    const contentHash = ingestSha256(normalizedContent)
    const canonRef = source_ref?.trim()
      ? source_ref.trim()
      : `direct-ingest:${corpusSlug}:${contentHash}`
    const chunkPlan = chunkDocument(normalizedContent, { title })
    const chunkDefs = addCharOffsets(normalizedContent, chunkPlan.chunks)
    const embeddedChunks = []
    for (let i = 0; i < chunkDefs.length; i++) {
      const chunk = chunkDefs[i]
      const embedding = await ingestEmbed(chunk.embeddingText ?? chunk.content)
      embeddedChunks.push({
        chunkIndex: i,
        sectionHeader: chunk.sectionHeader,
        sectionPath: chunk.sectionPath ?? [],
        content: chunk.content,
        embedding,
        charStart: chunk.charStart ?? null,
        charEnd: chunk.charEnd ?? null,
      })
    }

    const summary = normalizedContent.slice(0, 1000).trim() || title
    const summaryEmbedding = await ingestEmbed(summary)
    const resourceId = await upsertResource({
      corpusSlug,
      type: resource_type,
      title,
      sourceRef: canonRef,
      sourceKind: source_ref?.trim() ? 'ref' : 'inline',
      contentHash,
      summary,
      summaryEmbedding,
      metadata: {
        direct_ingest: true,
        corpus: corpusSlug,
        chunking: chunkPlan.router,
        chunking_version: CHUNKING_VERSION,
      },
      mimeType: mime_type,
    })
    await replaceChunks(resourceId, embeddedChunks)

    let scope = null
    let scopeLink = null
    if (`${scope_slug ?? ''}`.trim()) {
      scope = await upsertScope({
        slug: scope_slug,
        displayName: scope_display_name ?? scope_slug,
        ownerUserId: owner_user_id,
        scopeType: scope_type,
        metadata: scope_metadata,
      })
      scopeLink = await attachResourceToScope({
        resourceId,
        scopeId: scope.id,
        isPrimary: true,
        metadata: {
          ingested_via: 'resources_ingest',
          corpus: corpusSlug,
        },
      })
    }

    return {
      ok: true,
      corpus: corpusSlug,
      resource_id: String(resourceId),
      title,
      chunk_count: embeddedChunks.length,
      source_ref: canonRef,
      scope,
      scope_link: scopeLink,
      message: `Ingested "${title}" into ${corpusSlug} as resource_id=${resourceId} with ${embeddedChunks.length} chunks.`,
    }
  }

  async documentsSearch ({ query, domain, k = 8 }) {
    const recallResult = await this.recall({ topic: query, corpus: domain, k })
    const rows = Array.isArray(recallResult?.results) ? recallResult.results : []
    return {
      query,
      domain: domain ?? 'all',
      count: rows.length,
      compatibility_alias: 'recall',
      results: rows.map(row => ({
        chunk_id:       row.chunk_id,
        resource_id:    row.resource_id,
        title:          row.title,
        corpus:         row.corpus ?? row.domain ?? null,
        section_header: row.section_header ?? null,
        rrf_score:      row.rrf_score ?? 0,
        content:        row.content,
      })),
    }
  }

  async documentsIngest ({ domain, title, content, doc_type = 'note', source_path, scope_slug = null, scope_display_name = null, scope_type = 'scope', scope_metadata = {}, owner_user_id = 'default' }) {
    return await this.resourcesIngest({
      corpus: domain,
      title,
      content,
      resource_type: doc_type,
      source_ref: source_path,
      scope_slug,
      scope_display_name,
      scope_type,
      scope_metadata,
      owner_user_id,
    })
  }

  learnPlanCreate ({ title = null, request, user_id = 'default', requested_by = 'default', status = 'draft', summary = null, findings = null, proposal = null, metadata = {} } = {}) {
    const plan = createLearnPlan({
      id: randomUUID(),
      title,
      request,
      userId: user_id,
      requestedBy: requested_by,
      status,
      summary,
      findings,
      proposal,
      metadata,
    })
    return { ok: true, plan }
  }

  async learnPlanRun ({
    learn_plan_id = null,
    title = null,
    request = null,
    user_id = 'default',
    requested_by = 'default',
    corpus = null,
    domain = null,
    metadata = {},
    urls = [],
    file_paths = [],
    sources = [],
  } = {}) {
    const payload = {
      learnPlanId: learn_plan_id,
      title,
      request,
      userId: user_id,
      requestedBy: requested_by,
      corpus,
      domain,
      metadata,
      urls,
      filePaths: file_paths,
      sources,
    }

    const res = await fetch(`${BROKER_URL}/learn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const raw = await res.text()
    const body = parseToolPayload(raw)
    if (!res.ok) {
      const message = body?.error ?? body?.message ?? `Learn plan run failed: HTTP ${res.status}`
      throw new Error(message)
    }
    return body
  }

  learnPlanList ({ status = null, user_id = null, limit = 50 } = {}) {
    const plans = getLearnPlans({ status, userId: user_id, limit: coerceLimit(limit, 50, 200) })
    return { count: plans.length, plans }
  }

  learnPlanGet ({ learn_plan_id } = {}) {
    if (!`${learn_plan_id ?? ''}`.trim()) throw new Error('learn_plan_id is required')
    const plan = getLearnPlanById(learn_plan_id)
    if (!plan) throw new Error(`Unknown learn plan: ${learn_plan_id}`)
    const stagedFiles = getStagedFilesByLearnPlanId(learn_plan_id, { limit: 500 })
    return { ok: true, plan, staged_files: stagedFiles, staged_count: stagedFiles.length }
  }

  learnPlanUpdate ({ learn_plan_id, title, request, status, summary, findings, proposal, metadata, decision_notes } = {}) {
    if (!`${learn_plan_id ?? ''}`.trim()) throw new Error('learn_plan_id is required')
    const plan = updateLearnPlan(learn_plan_id, {
      title,
      request,
      status,
      summary,
      findings,
      proposal,
      metadata,
      decisionNotes: decision_notes,
    })
    if (!plan) throw new Error(`Unknown learn plan: ${learn_plan_id}`)
    return { ok: true, plan }
  }

  learnPlanDecide ({ learn_plan_id, decision, decision_notes = null, apply_to_staged_files = true } = {}) {
    if (!`${learn_plan_id ?? ''}`.trim()) throw new Error('learn_plan_id is required')
    const normalizedDecision = `${decision ?? ''}`.trim().toLowerCase()
    if (!['approve', 'reject'].includes(normalizedDecision)) {
      throw new Error('decision must be "approve" or "reject"')
    }

    const existing = getLearnPlanById(learn_plan_id)
    if (!existing) throw new Error(`Unknown learn plan: ${learn_plan_id}`)

    const reviewedFiles = getStagedFilesByLearnPlanId(learn_plan_id, { status: 'review', limit: 1000 })
    const moved = []
    const now = new Date().toISOString()

    if (apply_to_staged_files) {
      for (const row of reviewedFiles) {
        const currentPath = resolveCurrentStagedPath(row)
        if (!currentPath || !fs.existsSync(currentPath)) continue

        const targetDir = normalizedDecision === 'approve' ? STAGING_APPROVED_DIR : STAGING_REJECTED_DIR
        const targetPath = path.join(targetDir, path.basename(currentPath))
        moveFileSafe(currentPath, targetPath)

        if (normalizedDecision === 'approve') {
          updateStagedStatus(row.id, 'approved', {
            scanResult: 'pass',
            scanNotes: decision_notes ?? 'approved via learn plan decision',
            reviewPath: null,
            approvedPath: targetPath,
            approvedAt: now,
          })
        } else {
          updateStagedStatus(row.id, 'rejected', {
            scanResult: 'fail',
            scanNotes: decision_notes ?? 'rejected via learn plan decision',
            reviewPath: null,
            approvedPath: null,
          })
        }

        moved.push({ staging_id: row.id, filename: row.filename, target_path: targetPath, status: normalizedDecision === 'approve' ? 'approved' : 'rejected' })
      }
    }

    const plan = updateLearnPlan(learn_plan_id, {
      status: normalizedDecision === 'approve' ? 'approved' : 'rejected',
      decisionNotes: decision_notes,
      decidedAt: now,
    })

    return {
      ok: true,
      plan,
      moved_count: moved.length,
      moved_files: moved,
      message: normalizedDecision === 'approve'
        ? 'Learn plan approved and review-held files released to approved/.'
        : 'Learn plan rejected and review-held files moved to rejected/.',
    }
  }
}

await initDb()
new AmphionMcpServer().run()
