/**
 * broker/src/agent-runner.js — Agent execution layer
 *
 * Current state (Session 2): All agents are stubs.
 * Each returns a realistic-looking result so the full pipeline can be
 * tested end-to-end without any real MCP processes.
 *
 * Session 3 upgrade path:
 *   Replace each domain case below with a real MCP STDIO call:
 *   spawn(`node agents/${domain}/index.js`, ...)
 *   then send a JSON-RPC "tools/call" message and await the response.
 *
 * @typedef {import('./orchestrator.js').AgentResult} AgentResult
 */

/**
 * Run a domain agent with the given task.
 *
 * @param {string} domain  — 'research' | 'finance' | 'legal' | 'comms' | 'proposals'
 * @param {string} task    — natural-language instruction for this agent
 * @param {object} context — context packet from the assembler
 * @returns {Promise<AgentResult>}
 */
export async function runAgent (domain, task, context) {
  console.log(`[agent-runner] running ${domain} stub | task: "${task.slice(0, 80)}..."`)

  // Simulate a small amount of work
  await sleep(50)

  switch (domain) {
    case 'research':
      return {
        domain: 'research',
        success: true,
        summary: `Research stub: I searched the knowledge base for "${task.slice(0, 60)}" and found 3 relevant documents. The most relevant item is a market analysis from Q1 2024 that aligns with this query. No real semantic search performed yet — this is a stub response pending pgvector integration.`,
        items: [
          { title: 'Market Analysis Q1 2024', relevance: 0.91 },
          { title: 'Industry Overview 2023', relevance: 0.84 },
          { title: 'Competitive Landscape Notes', relevance: 0.78 },
        ],
      }

    case 'finance':
      return {
        domain: 'finance',
        success: true,
        summary: `Finance stub: Retrieved relevant financial data for "${task.slice(0, 60)}". Current pipeline pull shows no outstanding red flags. Budget tracking and deal valuations are nominal. Awaiting real data ingestion via scripts/ingest.js.`,
        items: [
          { category: 'Q2 Budget', status: 'on-track' },
        ],
      }

    case 'legal':
      return {
        domain: 'legal',
        success: true,
        summary: `Legal stub: Reviewed relevant legal context for "${task.slice(0, 60)}". No flagged compliance issues found in stub data. NDA and contract templates are available. Real document analysis pending ingest.`,
        items: [],
      }

    case 'comms':
      return {
        domain: 'comms',
        success: true,
        summary: `Comms stub: Drafted a communication approach for "${task.slice(0, 60)}". Recommended channel: email. Tone: professional. Full draft generation awaiting real agent implementation.`,
        items: [
          { channel: 'email', status: 'draft-pending' },
        ],
      }

    case 'proposals':
      return {
        domain: 'proposals',
        success: true,
        summary: `Proposals stub: Searched proposal library for "${task.slice(0, 60)}". Found 2 similar past proposals. Win rate for this proposal type: 67%. Template matching and full generation pending real agent implementation.`,
        items: [
          { title: 'Henderson Construction Proposal', status: 'won', year: 2023 },
          { title: 'Meridian Group RFP Response', status: 'pending', year: 2024 },
        ],
      }

    case 'dev':
      return {
        domain: 'dev',
        success: true,
        summary: `Dev stub: Analyzed the code request: "${task.slice(0, 60)}". devstral agent is stubbed. Full coding capability pending MCP STDIO integration.`,
        items: [],
      }

    default:
      return {
        domain,
        success: false,
        summary: `Unknown domain "${domain}" — no agent available.`,
        error: `No agent registered for domain: ${domain}`,
      }
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
