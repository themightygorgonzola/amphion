/**
 * broker/src/context-assembler.js — Stage 1
 *
 * Builds the context packet prepended to every inference call.
 * No LLM involved — purely reading from SQLite.
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
export function assembleContext (sessionId, userId = 'default', workspaceId = null) {
  const activeScope = `${workspaceId ?? ''}`.trim() || null

  const workspace     = activeScope ? getWorkspaceInfo(activeScope) : null
  const allWorkspaces = activeScope ? null : getAllWorkspaces()

  const history      = getRecentHistory(sessionId, 10, userId)
  const globalRecent = getGlobalRecentHistory(6, userId, activeScope)

  // Build a compact prompt-ready workspace summary
  const lines = []
  lines.push('Developer: David | Home machine (miracle) | Windows 11 + RTX 5080')

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

  const contextSummary = lines.join('\n')

  const recentActivitySummary = globalRecent.length
    ? globalRecent.map(t =>
        `  ${t.role === 'user' ? 'David' : 'Atlas'}: ${t.content?.slice(0, 120)}${t.content?.length > 120 ? '...' : ''}`
      ).join('\n')
    : ''

  return {
    displayName: 'David',
    workspaceId: activeScope,
    activeScope,
    workspace,
    allWorkspaces,
    history,
    contextSummary,
    recentActivitySummary,
  }
}
