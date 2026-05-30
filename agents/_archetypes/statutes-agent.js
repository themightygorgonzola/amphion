/**
 * agents/_archetypes/statutes-agent.js — Parameterized Statutes Agent
 *
 * Thin adapter over the canonical resource-backed legal agent. This keeps new
 * statutes-style corpora on the shared resource retrieval path instead of
 * preserving a second legacy SQL implementation.
 */

import { fileURLToPath } from 'url'
import { LegalAgent } from '../legal/index.js'

export class StatutesAgent extends LegalAgent {
  constructor () {
    super()
    this.domain = process.env.AMPHION_AGENT ?? 'legal'
  }

  get name () { return this.domain }
  get description () { return `Statute corpus agent for domain: ${this.domain}` }

  get tools () {
    return [
      {
        name: 'search_statutes',
        description: `Hybrid search over the ${this.domain} corpus using semantic and keyword matching. Use for citations, sections, or regulatory topics in this corpus.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language question or citation' },
            k: { type: 'integer', description: 'Number of chunks to return (default 8, max 20)' },
            neighbors: { type: 'boolean', description: 'Include neighboring chunks for context (default true)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_section',
        description: `Retrieve a specific section from the ${this.domain} corpus by title and section identifier.`,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Chapter or title identifier, e.g. "46.63" or "9A.36"' },
            section_header: { type: 'string', description: 'Full section number to match, e.g. "46.63.220"' },
            k: { type: 'integer', description: 'Max chunks to return (default 20)' },
          },
        },
      },
      {
        name: 'get_chapter',
        description: `Fetch a full chapter from the ${this.domain} corpus by resource ID or title keyword. Returns all sections in order.`,
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'integer', description: 'Exact resource ID' },
            title: { type: 'string', description: 'Chapter title keyword' },
          },
        },
      },
      {
        name: 'review_contract',
        description: 'Find relevant legal or regulatory material for a topic (alias for search_statutes).',
        inputSchema: { type: 'object', properties: { topic: { type: 'string' }, k: { type: 'integer' } }, required: ['topic'] },
      },
      {
        name: 'flag_risks',
        description: 'Surface legal or regulatory risk material for a situation (alias for search_statutes).',
        inputSchema: { type: 'object', properties: { description: { type: 'string' } }, required: ['description'] },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_statutes': return this._searchStatutes(args)
      case 'get_section': return this._getSection(args)
      case 'get_chapter': return this._getChapter(args)
      case 'review_contract': return this._searchStatutes({ query: args.topic, k: args.k })
      case 'flag_risks': return this._searchStatutes({ query: `legal risk: ${args.description}` })
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await import('dotenv/config') } catch {}
  new StatutesAgent().run()
}
