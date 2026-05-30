/**
 * broker/src/context-assembler.js — Stage 1
 *
 * Builds the context packet that gets prepended to EVERY inference call.
 * No LLM involved — purely reading from SQLite.
 *
 * Returns an object that both the Dispatcher prompt and Voice Layer prompt
 * will receive as structured context.
 */

import { getUserContext, getRecentHistory, getGlobalRecentHistory } from './db.js'

/**
 * Build the context packet for a given session.
 *
 * @param {string} sessionId
 * @param {string} [userId]   — who is asking; scopes all history lookups
 * @returns {ContextPacket}
 *
 * @typedef {Object} ContextPacket
 * @property {string}   displayName
 * @property {string}   company
 * @property {string}   role
 * @property {string[]} currentPriorities
 * @property {object[]} activeDeals
 * @property {object[]} keyContacts
 * @property {string}   tonePreferences
 * @property {string}   contextNotes
 * @property {{ role: string, content: string }[]} history
 * @property {string}   contextSummary  — formatted string ready to inject into a prompt
 * @property {string}   recentActivitySummary — last few turns across all sessions
 */
export function assembleContext (sessionId, userId = 'default', workspaceId = null) {
  const user = getUserContext()
  const history = getRecentHistory(sessionId, 10, userId)
  const globalRecent = getGlobalRecentHistory(6, userId, workspaceId)
  const activeScope = `${workspaceId ?? ''}`.trim() || null

  const displayName = user.displayName ?? process.env.DISPLAY_NAME ?? 'Atlas'

  // Build a compact prompt-ready summary of who the user is
  const lines = []

  if (user.company || user.role) {
    lines.push(`User: ${[user.displayName, user.role, user.company].filter(Boolean).join(' | ')}`)
  }

  if (user.currentPriorities?.length) {
    lines.push(`Current priorities: ${user.currentPriorities.join('; ')}`)
  }

  if (user.activeDeals?.length) {
    const dealSummary = user.activeDeals
      .map(d => `${d.name} (${d.stage}, ${d.value ?? '?'})`)
      .join('; ')
    lines.push(`Active deals: ${dealSummary}`)
  }

  if (user.tonePreferences) {
    lines.push(`Tone: ${user.tonePreferences}`)
  }

  if (user.contextNotes) {
    lines.push(`Notes: ${user.contextNotes}`)
  }

  const contextSummary = lines.length ? lines.join('\n') : '(no user profile configured — run scripts/seed-context.js)'

  // Build a cross-session recent activity summary for dispatcher awareness
  const recentActivitySummary = globalRecent.length
    ? globalRecent.map(t =>
        `  ${t.role === 'user' ? 'David' : 'Atlas'}: ${t.content?.slice(0, 120)}${t.content?.length > 120 ? '...' : ''}`
      ).join('\n')
    : ''

  return {
    ...user,
    displayName,
    workspaceId: activeScope,
    activeScope,
    history,
    contextSummary,
    recentActivitySummary,
  }
}
