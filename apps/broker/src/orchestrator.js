/**
 * broker/src/orchestrator.js — Stage 3
 *
 * Reads the job ticket from the Dispatcher and executes the plan.
 *
 * Execution modes:
 *   single     — one domain agent, called directly
 *   sequential — multiple domains, called one after another (each gets previous results)
 *   parallel   — multiple domains, all called simultaneously (jobTicket.parallel === true)
 *
 * At this stage (Session 2) agents are stubs that return structured mock data.
 * In Session 3+ each domain will be a real MCP server process spawned over STDIO.
 *
 * Returns an AgentResultSet: { [domain]: AgentResult }
 *
 * @typedef {Object} AgentResult
 * @property {string}   domain
 * @property {boolean}  success
 * @property {string}   summary       — prose summary the Voice Layer will use
 * @property {object[]} [items]        — structured data (optional, for UI)
 * @property {string}   [error]        — set if success === false
 */

import { runAgent } from './agent-runner.js'

/**
 * Execute the job ticket and return results from all domains.
 *
 * @param {import('./dispatcher.js').JobTicket} jobTicket
 * @param {string} originalMessage
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {Promise<Object.<string, AgentResult>>}
 */
export async function orchestrate (jobTicket, originalMessage, context) {
  const { domains, parallel, instructions } = jobTicket

  if (domains.length === 0) {
    return { research: stubResult('research', 'No domain selected — routing defaulted to research.') }
  }

  if (domains.length === 1) {
    const domain = domains[0]
    const result = await runAgent(domain, instructions[domain] ?? originalMessage, context)
    return { [domain]: result }
  }

  if (parallel) {
    // Run all domains simultaneously
    const entries = await Promise.all(
      domains.map(async domain => {
        const result = await runAgent(domain, instructions[domain] ?? originalMessage, context)
        return [domain, result]
      })
    )
    return Object.fromEntries(entries)
  }

  // Sequential — run domains in order, passing accumulated context forward
  const results = {}
  let accumulatedContext = context

  for (const domain of domains) {
    const result = await runAgent(domain, instructions[domain] ?? originalMessage, accumulatedContext)
    results[domain] = result
    // Enrich context with this domain's summary for the next agent
    accumulatedContext = {
      ...accumulatedContext,
      previousResults: { ...(accumulatedContext.previousResults ?? {}), [domain]: result.summary }
    }
  }

  return results
}

function stubResult (domain, message) {
  return { domain, success: true, summary: message, items: [] }
}
