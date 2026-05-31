/**
 * broker/src/context-assembler.js — Stage 1
 *
 * Builds the context packet prepended to every inference call.
 * No LLM involved — purely reading from SQLite + optional fast PPM status check.
 *
 * When a workspaceId is supplied the summary is scoped to that workspace.
 * Without one, a compact list of all registered workspaces is included.
 */

import { getWorkspaceInfo, getAllWorkspaces, getRecentHistory, getGlobalRecentHistory } from './db.js'

/**
 * @typedef {Object} ContextPacket
 * @property {string}        displayName
 * @property {string|null}   workspaceId
 * @property {string|null}   activeScope
 * @property {object|null}   workspace       — full WorkspaceInfo for the active workspace
 * @property {object[]|null} allWorkspaces   — set when no workspaceId supplied
 * @property {{ role: string, content: string }[]} history
 * @property {string}        contextSummary  — prompt-ready string
 * @property {string}        recentActivitySummary
 */
const USER_NAME    = () => process.env.USER_NAME    || 'User'
const DISPLAY_NAME = () => process.env.DISPLAY_NAME || 'Atlas'

const PPM_URL = (process.env.PPM_URL ?? 'http://localhost:7000').replace(/\/$/, '')
const PPM_STATUS_TIMEOUT_MS = 300

/** Fire-and-forget PPM health check. Returns a one-line status string or null. */
async function fetchPpmStatus () {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PPM_STATUS_TIMEOUT_MS)
  try {
    const res = await fetch(`${PPM_URL}/api/projects`, { signal: controller.signal })
    if (!res.ok) return null
    const projects = await res.json()
    if (!Array.isArray(projects) || !projects.length) return null
    const summary = projects
      .map(p => {
        const ok = p.status === 'alive' && (p.health?.status === 'healthy' || p.health?.score >= 80)
        return `${p.name}:${ok ? '✓' : '✗'}`
      })
      .join(' ')
    return `Services: ${summary}`
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function assembleContext (sessionId, userId = 'default', workspaceId = null) {
  const activeScope = `${workspaceId ?? ''}`.trim() || null

  const workspace     = activeScope ? getWorkspaceInfo(activeScope) : null
  const allWorkspaces = activeScope ? null : getAllWorkspaces()

  const history      = getRecentHistory(sessionId, 10, userId)
  const globalRecent = getGlobalRecentHistory(6, userId, activeScope)

  // Fire off PPM status in parallel with the rest of the assembly
  const ppmStatusPromise = fetchPpmStatus()

  // Build a compact prompt-ready workspace summary
  const lines = []
  const name = USER_NAME()
  const namePrefix = name && name !== 'User' ? `${name} | ` : ''
  const machineName = process.env.MACHINE_NAME || 'miracle'
  const machineSpec = process.env.MACHINE_SPEC || 'Windows 11 + RTX 5080'
  lines.push(`Developer: ${namePrefix}${machineName} | ${machineSpec}`)

  if (workspace) {
    lines.push(`Active workspace: ${workspace.name}  [${workspace.path}]`)
    if (workspace.description) lines.push(`  ${workspace.description}`)
    if (workspace.language)    lines.push(`  Language: ${workspace.language}`)
    if (workspace.buildCmd)    lines.push(`  Build: ${workspace.buildCmd}`)
    if (workspace.ppmService)  lines.push(`  PPM service: ${workspace.ppmService}`)
    if (workspace.conventions?.length) {
      lines.push(`  Conventions: ${workspace.conventions.join('; ')}`)
    }
    if (workspace.keyDirs?.length) {
      lines.push('  Key directories:')
      workspace.keyDirs.forEach(d => {
        const label = typeof d === 'string' ? d : `${d.path}: ${d.description}`
        lines.push(`    ${label}`)
      })
    }
  } else if (allWorkspaces?.length) {
    lines.push(`Registered workspaces (${allWorkspaces.length}):`)
    allWorkspaces.forEach(w => {
      const lang = w.language ? ` [${w.language}]` : ''
      lines.push(`  • ${w.id}${lang} — ${w.description ?? w.name}`)
    })
  } else {
    lines.push('(no workspace registry — run scripts/seed-workspaces.js)')
  }

  // Append PPM status if it came back in time
  const ppmStatus = await ppmStatusPromise
  if (ppmStatus) lines.push(ppmStatus)

  const contextSummary = lines.join('\n')

  const recentActivitySummary = globalRecent.length
    ? globalRecent.map(t =>
        `  ${t.role === 'user' ? USER_NAME() : DISPLAY_NAME()}: ${t.content?.slice(0, 120)}${t.content?.length > 120 ? '...' : ''}`
      ).join('\n')
    : ''

  return {
    displayName: USER_NAME(),
    workspaceId: activeScope,
    activeScope,
    workspace,
    allWorkspaces,
    history,
    contextSummary,
    recentActivitySummary,
  }
}
