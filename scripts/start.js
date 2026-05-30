/**
 * scripts/start.js — Amphion service supervisor
 *
 * Starts and supervises all four runtime services as child processes:
 *   broker       — Express HTTP server + SSE pipeline  (apps/broker/src/index.js)
 *   stage-watch  — Quarantine inbox scanner            (scripts/stage-watch.js)
 *   watch-ingest — Corpus auto-ingest watcher          (scripts/watch-ingest.js)
 *   desktop      — Electron UI                         (apps/desktop/src/main.js)
 *
 * Features:
 *   - Labeled, colour-coded stdout/stderr per service
 *   - Automatic restart on crash with exponential backoff (cap 30 s)
 *   - Exit code 0 = clean/intentional quit (user closed window) — never restarted
 *   - Non-zero exit = crash — restarted with backoff
 *   - One-shot --no-restart flag for CI / single runs
 *   - --headless flag: starts everything except the desktop window
 *   - Graceful shutdown on SIGINT / SIGTERM (SIGTERM to children, then SIGKILL after 5 s)
 *   - Broker health-check gate: all dependents start only after broker answers /health
 *
 * Usage:
 *   node scripts/start.js                    # start everything including Electron UI
 *   node scripts/start.js --headless         # backend services only (no Electron)
 *   node scripts/start.js --no-restart       # don't restart crashed services
 *   node scripts/start.js --only broker      # start a single service
 *   node scripts/start.js --only broker,stage-watch
 */

import { config as loadEnv } from 'dotenv'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import fs from 'fs'

const __dirname   = path.dirname(fileURLToPath(import.meta.url))
const ROOT        = path.resolve(__dirname, '..')
const _require    = createRequire(import.meta.url)
const BROKER_PORT = process.env.BROKER_PORT ?? 3000

// ---------------------------------------------------------------------------
// Resolve Electron binary (package exports its own binary path)
// ---------------------------------------------------------------------------
function resolveElectron () {
  const candidates = [
    path.join(ROOT, 'apps', 'desktop', 'node_modules', 'electron'),
    path.join(ROOT, 'node_modules', 'electron'),
  ]
  for (const pkgPath of candidates) {
    try {
      const bin = _require(pkgPath)
      if (typeof bin === 'string' && bin && fs.existsSync(bin)) {
        return { cmd: bin, extraArgs: [] }
      }
    } catch { /* not installed there */ }
  }
  // Fallback: npx (works if electron is anywhere on PATH / in node_modules)
  return {
    cmd:       process.platform === 'win32' ? 'npx.cmd' : 'npx',
    extraArgs: ['--no', 'electron'],
    shell:     process.platform === 'win32',
  }
}

const electronBin = resolveElectron()
const BROKER_HOST = (() => {
  const raw = (process.env.BROKER_HOST ?? '127.0.0.1').replace(/^https?:\/\//, '')
  return `http://${raw}`
})()

// ---------------------------------------------------------------------------
// Service definitions
// ---------------------------------------------------------------------------
const SERVICES = [
  {
    name:  'broker',
    label: '[broker]    ',
    color: '\x1b[36m',   // cyan
    cmd:   'node',
    args:  ['apps/broker/src/index.js'],
    // Broker must be up before dependents start
    dependsOn: null,
  },
  {
    name:  'stage-watch',
    label: '[stage]     ',
    color: '\x1b[33m',   // yellow
    cmd:   'node',
    args:  ['scripts/stage-watch.js'],
    dependsOn: 'broker',
  },
  {
    name:  'watch-ingest',
    label: '[watch]     ',
    color: '\x1b[32m',   // green
    cmd:   'node',
    args:  ['scripts/watch-ingest.js'],
    dependsOn: 'broker',
  },
  {
    name:  'desktop',
    label: '[desktop]   ',
    color: '\x1b[35m',   // magenta
    cmd:   electronBin.cmd,
    args:  [...(electronBin.extraArgs ?? []), 'apps/desktop/src/main.js'],
    shell: electronBin.shell ?? false,
    dependsOn: 'broker',
    // Exit code 0 = user closed the window intentionally — don't restart.
    // Exit code non-zero = crash — restart with backoff (handled by default logic).
  },
]

const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const RED   = '\x1b[31m'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args       = process.argv.slice(2)
const noRestart  = args.includes('--no-restart')
const headless   = args.includes('--headless')
const onlyIdx    = args.indexOf('--only')
const onlyNames  = onlyIdx >= 0
  ? args[onlyIdx + 1].split(',').map(s => s.trim())
  : null

const activeServices = (() => {
  let svcs = onlyNames ? SERVICES.filter(s => onlyNames.includes(s.name)) : SERVICES
  if (headless) svcs = svcs.filter(s => s.name !== 'desktop')
  return svcs
})()

if (activeServices.length === 0) {
  console.error('No matching services. Available:', SERVICES.map(s => s.name).join(', '))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function prefix (svc) {
  return `${svc.color}${svc.label}${RESET}`
}

function log (svc, line) {
  process.stdout.write(`${prefix(svc)} ${line}\n`)
}

function logErr (svc, line) {
  process.stderr.write(`${prefix(svc)} ${RED}${line}${RESET}\n`)
}

function logSupervisor (msg) {
  process.stdout.write(`${DIM}[supervisor] ${msg}${RESET}\n`)
}

// ---------------------------------------------------------------------------
// Broker health check
// ---------------------------------------------------------------------------
async function isBrokerAlive () {
  try {
    const res = await fetch(`${BROKER_HOST}:${BROKER_PORT}/health`, { signal: AbortSignal.timeout(1000) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForBroker (maxMs = 30_000) {
  const url      = `${BROKER_HOST}:${BROKER_PORT}/health`
  const deadline = Date.now() + maxMs
  let attempt    = 0

  while (Date.now() < deadline) {
    attempt++
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        logSupervisor(`broker healthy after ${attempt} attempt(s)`)
        return true
      }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------
const procs = new Map()     // name → ChildProcess
const backoff = new Map()   // name → ms
let shuttingDown = false

function getBackoff (name) {
  const b = backoff.get(name) ?? 1000
  backoff.set(name, Math.min(b * 2, 30_000))
  return b
}

function resetBackoff (name) {
  backoff.set(name, 1000)
}

// ---------------------------------------------------------------------------
// Spawn a service
// ---------------------------------------------------------------------------
function spawnService (svc) {
  if (shuttingDown) return

  // Re-read .env each time a service spawns so env changes take effect on restart
  // without needing to kill the supervisor itself.
  const freshEnv = { ...process.env }
  loadEnv({ processEnv: freshEnv, override: true })
  const child = spawn(svc.cmd, svc.args, {
    cwd:         ROOT,
    env:         freshEnv,
    stdio:       'pipe',
    shell:       svc.shell ?? false,
    windowsHide: svc.name !== 'desktop',  // hide console for all background services; desktop IS the window
  })

  procs.set(svc.name, child)
  logSupervisor(`started ${svc.name} (pid ${child.pid})`)

  // Pipe stdout line-by-line
  let stdoutBuf = ''
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk.toString()
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop()
    for (const line of lines) {
      if (line.trim()) log(svc, line)
    }
  })

  // Pipe stderr line-by-line
  let stderrBuf = ''
  child.stderr.on('data', chunk => {
    stderrBuf += chunk.toString()
    const lines = stderrBuf.split('\n')
    stderrBuf = lines.pop()
    for (const line of lines) {
      // Suppress noisy non-actionable warnings
      if (line.includes('ExperimentalWarning'))    continue
      if (line.includes('MODULE_TYPELESS_PACKAGE')) continue
      if (line.includes('cache_util_win.cc'))       continue
      if (line.includes('disk_cache.cc'))           continue
      if (line.includes('gpu_disk_cache.cc'))       continue
      logErr(svc, line)
    }
  })

  // Flush partial lines on close
  child.stdout.on('end', () => { if (stdoutBuf.trim()) log(svc, stdoutBuf) })
  child.stderr.on('end', () => { if (stderrBuf.trim()) logErr(svc, stderrBuf) })

  child.on('exit', (code, signal) => {
    procs.delete(svc.name)

    if (shuttingDown) return

    if (code === 0) {
      logSupervisor(`${svc.name} exited cleanly`)
      resetBackoff(svc.name)
      return
    }

    logSupervisor(`${svc.name} exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`)

    if (noRestart) {
      logSupervisor(`--no-restart: will not restart ${svc.name}`)
      return
    }

    const delay = getBackoff(svc.name)
    logSupervisor(`restarting ${svc.name} in ${delay / 1000}s...`)
    setTimeout(() => {
      if (!shuttingDown) spawnService(svc)
    }, delay)
  })

  // Reset backoff after 60 s of stable running
  const stabilityTimer = setTimeout(() => resetBackoff(svc.name), 60_000)
  stabilityTimer.unref()
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown (reason) {
  if (shuttingDown) return
  shuttingDown = true

  logSupervisor(`shutting down (${reason})...`)

  // Send SIGTERM to all children
  for (const [name, child] of procs) {
    logSupervisor(`stopping ${name} (pid ${child.pid})`)
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }

  // Give them 5 s to exit gracefully, then SIGKILL
  const deadline = Date.now() + 5000
  while (procs.size > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200))
  }
  for (const [name, child] of procs) {
    logSupervisor(`force-killing ${name}`)
    try { child.kill('SIGKILL') } catch { /* already gone */ }
  }

  logSupervisor('all services stopped')
  process.exit(0)
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------
async function main () {
  logSupervisor(`Amphion starting — node ${process.version}`)
  logSupervisor(`services: ${activeServices.map(s => s.name).join(', ')}`)
  if (noRestart) logSupervisor('--no-restart mode')
  if (headless)   logSupervisor('--headless mode (no desktop window)')

  // Start the broker first (if it's in the active set)
  const brokerSvc = activeServices.find(s => s.name === 'broker')
  if (brokerSvc) {
    // If a broker is already running (e.g. started by the MCP tool or a previous session),
    // adopt it rather than spawning a second one that will EADDRINUSE-crash in a loop.
    const alreadyUp = await isBrokerAlive()
    if (alreadyUp) {
      logSupervisor('broker already running — adopting existing process (skipping spawn)')
    } else {
      spawnService(brokerSvc)
    }

    // Wait for dependents that need the broker
    const hasDependents = activeServices.some(s => s.dependsOn === 'broker')
    if (hasDependents) {
      if (!alreadyUp) logSupervisor('waiting for broker to become healthy...')
      const healthy = await waitForBroker(30_000)
      if (!healthy) {
        logSupervisor('broker did not become healthy in 30 s — starting dependents anyway')
      }
    }
  }

  // Start all other services (broker was already started above)
  for (const svc of activeServices) {
    if (svc.name === 'broker') continue
    spawnService(svc)
  }

  logSupervisor('all services started')
}

main().catch(err => {
  console.error('[supervisor] fatal:', err.message)
  process.exit(1)
})
