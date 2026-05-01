/**
 * broker/src/agent-runner.js — Agent execution layer
 *
 * Spawns each domain agent as a child process (MCP STDIO transport).
 * Sends an initialize handshake then a tools/call message.
 * The agent process is short-lived: spawned per-call, killed on response.
 *
 * Agent entry points:  agents/{domain}/index.js
 * Protocol:            JSON-RPC 2.0 over newline-delimited stdout/stdin
 *
 * @typedef {import('./orchestrator.js').AgentResult} AgentResult
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// agents/ is 3 levels up from apps/broker/src/
const AGENTS_ROOT = path.resolve(__dirname, '../../../agents')

// Map domain → { file, tool, argBuilder }
const DOMAIN_CONFIG = {
  research: {
    file:       'research/index.js',
    tool:       'search_knowledge',
    argBuilder: (task) => ({ query: task, k: 5 }),
  },
  finance: {
    file:       'finance/index.js',
    tool:       'search_financials',
    argBuilder: (task) => ({ query: task, k: 5 }),
  },
  legal: {
    file:       'legal/index.js',
    tool:       'review_contract',
    argBuilder: (task) => ({ topic: task, k: 5 }),
  },
  comms: {
    file:       'comms/index.js',
    tool:       'draft_email',
    argBuilder: (task, context) => ({
      recipient: context?.keyContacts?.[0]?.name ?? 'the relevant party',
      purpose:   task,
      tone:      context?.tonePreferences ?? 'professional',
    }),
  },
  proposals: {
    file:       'proposals/index.js',
    tool:       'find_similar_proposals',
    argBuilder: (task) => ({ description: task, k: 5 }),
  },
}

/**
 * Run a domain agent with the given task.
 *
 * @param {string} domain  — 'research' | 'finance' | 'legal' | 'comms' | 'proposals'
 * @param {string} task    — natural-language instruction for this agent
 * @param {object} context — context packet from the assembler
 * @returns {Promise<AgentResult>}
 */
export async function runAgent (domain, task, context) {
  const config = DOMAIN_CONFIG[domain]

  if (!config) {
    console.warn(`[agent-runner] unknown domain "${domain}" — no agent configured`)
    return { domain, success: false, summary: `No agent configured for domain: ${domain}`, items: [] }
  }

  console.log(`[agent-runner] spawning ${domain} | task: "${task.slice(0, 80)}..."`)

  try {
    const rawResult = await callAgentProcess(config, task, context)
    return parseAgentResult(domain, rawResult)
  } catch (err) {
    console.error(`[agent-runner] ${domain} failed: ${err.message}`)
    return {
      domain,
      success: false,
      summary: `Agent error: ${err.message}`,
      items:   [],
      error:   err.message,
    }
  }
}

/**
 * Spawn an agent process and exchange MCP messages.
 */
function callAgentProcess (config, task, context) {
  return new Promise((resolve, reject) => {
    const agentPath = path.join(AGENTS_ROOT, config.file)
    const domainName = config.file.split('/')[0]

    const child = spawn('node', [agentPath], {
      env: { ...process.env, AMPHION_AGENT: domainName },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuf = ''
    let msgId = 1
    let initialized = false
    let settled = false

    const settle = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.destroy()
      fn()
    }

    const send = (msg) => {
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk
      const lines = stdoutBuf.split('\n')
      stdoutBuf = lines.pop()

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let msg
        try { msg = JSON.parse(trimmed) } catch { continue }

        if (!initialized) {
          // Got initialize response — send tools/call
          initialized = true
          send({
            jsonrpc: '2.0',
            id: ++msgId,
            method: 'tools/call',
            params: {
              name:      config.tool,
              arguments: config.argBuilder(task, context),
            },
          })
        } else {
          // Got tools/call response — done
          if (msg.error) {
            settle(() => reject(new Error(msg.error.message)))
          } else {
            settle(() => resolve(msg.result))
          }
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      chunk.split('\n').filter(Boolean).forEach(l => console.log(`  [${domainName}] ${l}`))
    })

    child.on('error', (err) => settle(() => reject(err)))

    // 30-second hard timeout
    const timer = setTimeout(() => {
      child.kill()
      settle(() => reject(new Error(`Agent ${domainName} timed out after 30s`)))
    }, 30_000)

    // Start MCP handshake
    send({
      jsonrpc: '2.0',
      id: msgId,
      method: 'initialize',
      params: { clientInfo: { name: 'amphion-broker', version: '0.1.0' } },
    })
  })
}

/**
 * Convert raw MCP tool result into our AgentResult shape.
 */
function parseAgentResult (domain, mcpResult) {
  const text = mcpResult?.content?.[0]?.text ?? '{}'
  let parsed = {}
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }

  if (parsed.results) {
    return {
      domain,
      success: true,
      summary: `Found ${parsed.results.length} result(s) from the ${domain} knowledge base.${parsed.message ? ' ' + parsed.message : ''}`,
      items:   parsed.results,
    }
  }

  if (parsed.draft) {
    return {
      domain,
      success: true,
      summary: `Drafted communication for: ${parsed.purpose ?? parsed.recipient ?? 'request'}`,
      items:   [{ draft: parsed.draft }],
    }
  }

  if (parsed.outline) {
    return {
      domain,
      success: true,
      summary: `Generated proposal outline for: ${parsed.opportunity ?? 'opportunity'}`,
      items:   [{ outline: parsed.outline }],
    }
  }

  if (parsed.deals) {
    return {
      domain,
      success: true,
      summary: `Retrieved ${parsed.count ?? parsed.deals.length} deal record(s).`,
      items:   parsed.deals,
    }
  }

  if (parsed.win_rate !== undefined) {
    return {
      domain,
      success: true,
      summary: `Win rate: ${parsed.win_rate} (${parsed.won}/${parsed.total} proposals)`,
      items:   [parsed],
    }
  }

  return {
    domain,
    success: true,
    summary: parsed.message ?? `${domain} agent completed.`,
    items:   [],
  }
}

