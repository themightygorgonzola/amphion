/**
 * scripts/seed-workspaces.js
 *
 * Populates the workspace_registry SQLite table with all known projects
 * under C:\MySoftwareFolder\.
 *
 * Safe to re-run (uses upsert). Add new entries here as projects arrive
 * from the office machine via GitHub pull.
 *
 * Usage:
 *   node amphion/scripts/seed-workspaces.js
 *   (from C:\MySoftwareFolder\  — or adjust SQLITE_PATH)
 */

import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname  = path.dirname(fileURLToPath(import.meta.url))
const ROOT       = 'C:\\MySoftwareFolder'

// Inline the DB layer so we don't need to boot the full broker
process.env.SQLITE_PATH ??= path.join(__dirname, '..', 'data', 'memory.db')

// Dynamic import after env is set
const { initDb, upsertWorkspace } = await import('../apps/broker/src/db.js')
await initDb()

const WORKSPACES = [
  {
    id:          'lichess-bot-redux',
    name:        'lichess-bot-redux',
    path:        path.join(ROOT, 'lichess-bot-redux'),
    description: 'C++ UCI chess engine (HCE + NNUE), Node.js Lichess bot client, Python NNUE training pipeline',
    language:    'C++ / Node.js / Python',
    buildCmd:    '.\\make.ps1 build',
    ppmService:  'lichess-bot',
    conventions: [
      'Build via make.ps1 — never invoke cmake directly',
      'Engine source in src/, bot client in bot/, training in ml/',
      'Training data: data/training/*.bin, processed: data/processed/mean-alltime-dedup-shuffled.bin',
      'Binary format: 136-byte records, 32-byte header (NNUE_BIN magic)',
    ],
    keyDirs: [
      { path: 'src/',           description: 'C++ engine source (move gen, search, eval, NNUE)' },
      { path: 'bot/',           description: 'Node.js Lichess bot client' },
      { path: 'ml/',            description: 'Python NNUE training pipeline' },
      { path: 'engines/',       description: 'Reference engine binaries: stockfish, obsidian, berserk, stormphrax, clover' },
      { path: 'data/training/', description: 'Raw training data (.bin files)' },
      { path: 'data/processed/', description: 'Consolidated training data' },
      { path: 'releases/',      description: 'Packaged bot release zips' },
    ],
    tags: ['chess', 'engine', 'bot', 'cpp', 'nnue'],
  },

  {
    id:          'PersonalProjectManager',
    name:        'PersonalProjectManager',
    path:        path.join(ROOT, 'PersonalProjectManager'),
    description: 'Node.js monorepo: project orchestration platform (controller, agent, dashboard)',
    language:    'Node.js',
    buildCmd:    'npx pm2 start ecosystem.config.js',
    ppmService:  null,
    conventions: [
      'Monorepo under packages/: controller (port 7000), dashboard (port 7001), agent (port 7002)',
      'Run via pm2: npx pm2 start ecosystem.config.js from PersonalProjectManager/',
      'SQLite DB: packages/controller/data/controller.db',
      'SDK bots register via POST /api/projects/register, heartbeat via POST /api/projects/heartbeat',
      'CRITICAL when restarting llm-router: must pm2 delete then pm2 start — never pm2 restart (caches old env)',
    ],
    keyDirs: [
      { path: 'packages/controller/', description: 'PPM API server (port 7000)' },
      { path: 'packages/dashboard/',  description: 'React dashboard UI (port 3000)' },
      { path: 'packages/agent/',      description: 'PPM agent (port 7002)' },
      { path: 'ecosystem.config.js',  description: 'pm2 service registry — add new ppm-projects services here' },
    ],
    tags: ['ppm', 'orchestration', 'monorepo'],
  },

  {
    id:          'amphion',
    name:        'amphion',
    path:        path.join(ROOT, 'amphion'),
    description: 'Memory + ingest service + MCP surface. Stripped JARVIS pipeline. Broker on port 3001, SQLite memory, LiteLLM context enrichment callback.',
    language:    'Node.js',
    buildCmd:    'npx pm2 start ecosystem.config.js --only amphion-broker (from PersonalProjectManager/)',
    ppmService:  'amphion-broker',
    conventions: [
      'Broker HTTP API on port 3001 (POST /query SSE chat, GET /context for enrichment)',
      'MCP server at amphion/mcp-server/index.js (stdio, 5 tools)',
      'JARVIS/dispatcher/orchestrator/voice-layer all deleted — broker is now ~400 lines',
      'LiteLLM callback in ppm-projects/llm-router/callbacks/amphion_context.py enriches every :4000 call',
      'Ingest is stubbed (pgvector removed) — use /stage for HTML→Markdown staging only',
      'No_context gate: callOllama sets metadata.no_context=true to prevent callback recursion',
    ],
    keyDirs: [
      { path: 'apps/broker/src/',  description: 'Core broker: context-assembler, db, index, ollama' },
      { path: 'mcp-server/',       description: 'Standalone MCP stdio server — 5 tools for IDE integration' },
      { path: 'scripts/',          description: 'Admin: seed-workspaces.js, debug-query.js' },
      { path: 'data/memory.db',    description: 'SQLite: conversations, workspace_registry, query_log' },
    ],
    tags: ['ai', 'broker', 'rag', 'mcp'],
  },

  {
    id:          'ppm-projects',
    name:        'ppm-projects',
    path:        path.join(ROOT, 'ppm-projects'),
    description: 'Services managed by PPM — currently includes llm-router (LiteLLM on port 4000)',
    language:    'Node.js / Python',
    buildCmd:    null,
    ppmService:  null,
    conventions: [
      'Each subdirectory is a PPM-managed service',
      'llm-router: LiteLLM on port 4000, start via start.ps1 (loads .env first)',
      'LiteLLM master key: sk-amphion-local-bF9aL27dQxR8nT3kP1mY6vW0sZ4cH5jX',
      'Model aliases: fast=qwen3:14b, balanced=mistral-small3.1:24b, cloud-haiku=claude-haiku-4-5',
    ],
    keyDirs: [
      { path: 'llm-router/', description: 'LiteLLM proxy — model router for all AI tools (port 4000)' },
      { path: 'llm-router/callbacks/amphion_context.py', description: 'Pre-call hook: injects workspace context into every LLM request' },
    ],
    tags: ['ppm', 'llm', 'infrastructure'],
  },

  {
    id:          'chessrts',
    name:        'chessrts',
    path:        path.join(ROOT, 'chessrts'),
    description: 'Chess RTS game project — browser-based, webpack build',
    language:    'JavaScript',
    buildCmd:    'npm run dev',
    ppmService:  null,
    conventions: [
      'Webpack config split: webpack.common.js, webpack.dev.js, webpack.prod.js',
      'Source in src/, public assets in public/',
    ],
    keyDirs: [
      { path: 'src/',    description: 'Game source code' },
      { path: 'public/', description: 'Static assets' },
    ],
    tags: ['chess', 'game', 'browser'],
  },

  {
    id:          'project-zeus',
    name:        'project-zeus',
    path:        path.join(ROOT, 'project-zeus'),
    description: 'Multiplayer AI-assisted tabletop adventure (brother\'s project). SvelteKit + Turso + PartyKit + Trigger.dev. Repo is stale — may be picked up again soon.',
    language:    'JavaScript / SvelteKit',
    buildCmd:    'npm run dev (inside site/)',
    ppmService:  null,
    conventions: [
      'Site in site/ (SvelteKit), automation scripts in scripts/',
      'Uses Turso (SQLite edge DB), PartyKit (multiplayer), Trigger.dev (background jobs)',
      'Repo is stale — coordinate with repo owner before pushing',
    ],
    keyDirs: [
      { path: 'site/', description: 'SvelteKit frontend + server routes' },
    ],
    tags:        ['zeus'],
  },

  {
    id:          'shapez2',
    name:        'shapez2',
    path:        path.join(ROOT, 'shapez2'),
    description: 'Shapez 2 mods — extra-logic (ELG) including shifter, rewirer, and toolbar customizations',
    language:    'JavaScript',
    buildCmd:    null,
    ppmService:  null,
    conventions: [
      'ELG shifter reference loading pattern in repo memory',
      'Copy-paste config and mirrored badges patterns documented',
      'Toolbar grouping pattern documented',
    ],
    keyDirs: [],
    tags: ['shapez2', 'mod', 'game'],
  },
]

let ok = 0
let fail = 0
for (const ws of WORKSPACES) {
  try {
    upsertWorkspace(ws)
    console.log(`[seed] ✓ ${ws.id}`)
    ok++
  } catch (err) {
    console.error(`[seed] ✗ ${ws.id}: ${err.message}`)
    fail++
  }
}

console.log(`\n[seed] done — ${ok} upserted, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
