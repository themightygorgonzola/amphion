/**
 * apps/broker/src/tracer.js — Per-request pipeline trace
 *
 * Creates a Trace object at the start of each /query request and threads it
 * through every pipeline stage. Each stage calls trace.stage(name, data) to
 * record what it received, what it computed, and how long it took.
 *
 * Traces are written to data/traces/ as JSON files and served via the broker
 * GET /traces and GET /traces/:id endpoints.
 *
 * Design rules:
 *  - trace.save() is fire-and-forget — failures are logged but never throw
 *  - All stage functions accept trace as an optional last parameter
 *  - No trace logic ever blocks or throws in production paths
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// data/traces/ sits at the amphion repo root
const DEFAULT_TRACES_DIR = path.resolve(__dirname, '../../../data/traces')

export class Trace {
  constructor (requestId, sessionId, message) {
    this.requestId  = requestId
    this.sessionId  = sessionId
    this.message    = message
    this.startedAt  = Date.now()
    this.stages     = []
    this.response   = null
    this.durationMs = null
  }

  /**
   * Record a pipeline stage.
   * @param {string} name  — e.g. 'context', 'dispatcher', 'agent:legal', 'voice'
   * @param {object} data  — any serializable payload
   */
  stage (name, data) {
    this.stages.push({ name, ts: Date.now(), data })
  }

  /**
   * Record the final synthesized response and total duration.
   * @param {string} finalResponse
   */
  finish (finalResponse) {
    this.response   = finalResponse
    this.durationMs = Date.now() - this.startedAt
  }

  toJSON () {
    return {
      requestId:  this.requestId,
      sessionId:  this.sessionId,
      message:    this.message,
      startedAt:  new Date(this.startedAt).toISOString(),
      durationMs: this.durationMs,
      response:   this.response,
      stages:     this.stages,
    }
  }

  /**
   * Write this trace to data/traces/ as a JSON file.
   * Non-blocking — errors are swallowed so they never affect the query response.
   * @param {string} [dir]
   */
  save (dir = DEFAULT_TRACES_DIR) {
    // Fire-and-forget via setImmediate so we never block SSE completion
    setImmediate(() => {
      try {
        fs.mkdirSync(dir, { recursive: true })
        const ts      = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const suffix  = this.requestId.replace(/[^a-z0-9]/gi, '').slice(-8)
        const file    = path.join(dir, `${ts}_${suffix}.json`)
        fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2), 'utf8')
      } catch (err) {
        console.warn('[tracer] failed to save trace:', err.message)
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Static helpers for the /traces API
  // ---------------------------------------------------------------------------

  /**
   * List saved traces, newest first.
   * @param {string} [dir]
   * @param {number} [limit=50]
   * @returns {{ id: string, ts: string, sessionId: string, messagePreview: string, durationMs: number|null }[]}
   */
  static list (dir = DEFAULT_TRACES_DIR, limit = 50) {
    try {
      if (!fs.existsSync(dir)) return []
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, limit)

      return files.map(f => {
        const id = f.replace(/\.json$/, '')
        try {
          const raw  = fs.readFileSync(path.join(dir, f), 'utf8')
          const data = JSON.parse(raw)
          return {
            id,
            ts:             data.startedAt,
            sessionId:      data.sessionId,
            messagePreview: (data.message ?? '').slice(0, 80),
            durationMs:     data.durationMs ?? null,
          }
        } catch {
          return { id, ts: null, sessionId: null, messagePreview: '(unreadable)', durationMs: null }
        }
      })
    } catch (err) {
      console.warn('[tracer] failed to list traces:', err.message)
      return []
    }
  }

  /**
   * Read a full trace by ID.
   * @param {string} id   — filename without .json
   * @param {string} [dir]
   * @returns {object|null}
   */
  static read (id, dir = DEFAULT_TRACES_DIR) {
    try {
      const file = path.join(dir, `${id}.json`)
      const raw  = fs.readFileSync(file, 'utf8')
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
}
