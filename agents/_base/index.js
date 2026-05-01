/**
 * agents/_base/index.js — BaseAgent
 *
 * Every domain agent extends this class. It implements the MCP STDIO transport:
 *   - Reads JSON-RPC 2.0 messages from stdin (newline-delimited)
 *   - Writes JSON-RPC 2.0 responses to stdout (newline-delimited)
 *   - Handles: initialize, tools/list, tools/call
 *   - Log/debug output goes to stderr (never stdout — that's the RPC channel)
 *
 * Subclasses must implement:
 *   get name()        — agent identifier e.g. 'research'
 *   get description() — one-line description
 *   get tools()       — array of MCP tool definitions { name, description, inputSchema }
 *   async callTool(toolName, args, context) — dispatch to tool handlers
 *
 * Usage (in each agent's index.js):
 *   import { BaseAgent } from '../_base/index.js'
 *   class ResearchAgent extends BaseAgent { ... }
 *   new ResearchAgent().run()
 */

export class BaseAgent {
  // Subclasses override these
  get name () { return 'base' }
  get description () { return 'Base agent' }
  get tools () { return [] }

  // -------------------------------------------------------------------------
  // MCP STDIO transport
  // -------------------------------------------------------------------------

  run () {
    this.log(`${this.name} agent starting`)

    let buffer = ''

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed) this._handleLine(trimmed)
      }
    })

    process.stdin.on('end', () => {
      this.log('stdin closed, shutting down')
      process.exit(0)
    })
  }

  _handleLine (line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      this._error(null, -32700, 'Parse error')
      return
    }

    const { id, method, params } = msg

    switch (method) {
      case 'initialize':
        this._respond(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: this.name, version: '0.1.0' },
          capabilities: { tools: {} },
        })
        break

      case 'tools/list':
        this._respond(id, { tools: this.tools })
        break

      case 'tools/call': {
        const { name: toolName, arguments: args } = params ?? {}
        const context = params?.context ?? {}
        this._callTool(id, toolName, args ?? {}, context)
        break
      }

      case 'notifications/initialized':
        // Acknowledgement from client — no response needed
        break

      default:
        this._error(id, -32601, `Method not found: ${method}`)
    }
  }

  async _callTool (id, toolName, args, context) {
    try {
      const result = await this.callTool(toolName, args, context)
      this._respond(id, {
        content: [
          { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
        ],
      })
    } catch (err) {
      this.log(`tool error: ${err.message}`)
      this._error(id, -32000, err.message)
    }
  }

  // Override in subclasses
  async callTool (toolName, args, context) {
    throw new Error(`Unknown tool: ${toolName}`)
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  _respond (id, result) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result })
    process.stdout.write(msg + '\n')
  }

  _error (id, code, message) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
    process.stdout.write(msg + '\n')
  }

  log (msg) {
    process.stderr.write(`[${this.name}] ${msg}\n`)
  }
}
