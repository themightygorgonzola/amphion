/**
 * broker/src/index.js — Amphion Broker
 *
 * The central pipeline. Every user message passes through four layers:
 *   1. Context Assembler  — reads SQLite, builds context packet (no LLM call)
 *   2. Dispatcher         — one fast LLM call, outputs a JSON job ticket
 *   3. Orchestrator       — pure logic, executes the plan (calls agents)
 *   4. Voice Layer        — one final LLM call, writes unified JARVIS response
 *
 * Routes:
 *   POST /query     — accepts { message, sessionId? }, streams response via SSE
 *   GET  /health    — returns { ok: true }
 *   POST /ingest    — ingest a single file directly into the corpus
 */

import { config as loadEnv } from 'dotenv'
loadEnv({ override: true })  // always win over inherited supervisor env
import express from 'express'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { assembleContext } from './context-assembler.js'
import { dispatch } from './dispatcher.js'
import { orchestrate } from './orchestrator.js'
import { synthesizeStream } from './voice-layer.js'
import {
  initDb,
  saveConversationTurn,
  clearConversation,
  clearAllConversations,
  getArtifactById as db_getArtifactById,
  logQuery,
  registerStagedFile,
  updateStagedStatus,
  createLearnPlan,
  updateLearnPlan,
  getLearnPlanById,
  getLearnPlans,
  getStagedFilesByLearnPlanId,
} from './db.js'
import { recordScopeResourceHits } from './scope-experience.js'
import { Trace } from './tracer.js'
import { htmlToMarkdown, ingestFile } from '../../../scripts/_ingest-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AMPHION_ROOT   = path.resolve(__dirname, '../../..')
const ARTIFACTS_ROOT = path.resolve(AMPHION_ROOT, 'data/artifacts')
const STAGING_INBOX  = path.resolve(AMPHION_ROOT, 'data/staging/inbox')
const STAGING_REVIEW = path.resolve(AMPHION_ROOT, 'data/staging/review')
const STAGING_APPROVED = path.resolve(AMPHION_ROOT, 'data/staging/approved')
const STAGING_REJECTED = path.resolve(AMPHION_ROOT, 'data/staging/rejected')

const app = express()
app.use(express.json())

// --- Auth middleware (active when BROKER_API_KEY is set) ---
// /health stays open for PPM + supervisor health checks.
const BROKER_API_KEY = process.env.BROKER_API_KEY
if (BROKER_API_KEY) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next()
    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== BROKER_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    next()
  })
}

const PORT = process.env.BROKER_PORT ?? 3000
const HOST = process.env.BROKER_HOST ?? '127.0.0.1'
const VALID_STAGING_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm'])
const TRANSIENT_DOWNLOAD_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

// ---------------------------------------------------------------------------
// Filesystem result_item helpers
// ---------------------------------------------------------------------------

/**
 * Build typed result_item payloads from a filesystem agent result.
 * Each item corresponds to one tool call (browse_path, find_path, or read_file).
 * These are emitted as SSE events BEFORE voice synthesis so the UI can render
 * them directly without the LLM narrating the raw data.
 */
function buildFilesystemItems (result) {
  const raw = result.filesystemRaw ?? {}
  if (raw.observations?.length) {
    return raw.observations.map(o => _singleFsItem(o.tool, o.raw)).filter(Boolean)
  }
  return [_singleFsItem(raw.tool, raw)].filter(Boolean)
}

function _singleFsItem (tool, raw) {
  if (!raw) return null
  if (tool === 'browse_path') {
    const entries = (raw.entries ?? []).filter(e => e.name !== 'node_modules' && !e.name.startsWith('.'))
    return { kind: 'fs_dir', path: raw.path, entries, totalEntries: raw.entries?.length ?? 0 }
  }
  if (tool === 'find_path') {
    return { kind: 'fs_find', query: raw.query, results: raw.results ?? [], roots: raw.roots ?? [] }
  }
  if (tool === 'read_file' && raw.content) {
    return { kind: 'fs_file', path: raw.path, content: raw.content, truncated: raw.truncated ?? false, size: raw.size }
  }
  return null
}

function writeSse (res, type, payload = {}) {
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`)
}

function nowIso () {
  return new Date().toISOString()
}

function normalizeText (value) {
  return `${value ?? ''}`.trim()
}

function joinMeta (...parts) {
  return parts.map(normalizeText).filter(Boolean).join(' · ')
}

function collectScopeResourceIds (agentResults) {
  const resourceIds = new Set()

  for (const result of Object.values(agentResults ?? {})) {
    if (!result || result.success === false || result.foundNothing || result.isFilesystem || result.isArtifacts) continue
    if (result.verification?.verdict !== 'supported') continue
    const credited = result.resourceAttribution?.creditedResourceIds
    if (Array.isArray(credited) && credited.length > 0) {
      for (const value of credited) {
        const numeric = Number.parseInt(`${value ?? ''}`, 10)
        if (Number.isInteger(numeric) && numeric > 0) resourceIds.add(numeric)
      }
      continue
    }

    for (const item of result.items ?? []) {
      if (item?.is_neighbor) continue
      const numeric = Number.parseInt(`${item?.resource_id ?? item?.doc_id ?? ''}`, 10)
      if (Number.isInteger(numeric) && numeric > 0) resourceIds.add(numeric)
    }
  }

  return [...resourceIds]
}

function compactObject (value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item == null) return false
      if (Array.isArray(item)) return item.length > 0
      if (typeof item === 'string') return item.length > 0
      return true
    })
  )
}

function paragraphBlock (text) {
  const normalized = normalizeText(text)
  return normalized ? { type: 'paragraph', text: normalized } : null
}

function badgeBlock (text, tone = 'neutral') {
  const normalized = normalizeText(text)
  return normalized ? { type: 'badge', text: normalized, tone } : null
}

function quoteBlock (text, attribution = null) {
  const normalized = normalizeText(text)
  return normalized
    ? compactObject({ type: 'quote', text: normalized, attribution: normalizeText(attribution) || null })
    : null
}

function codeBlock (text, language = 'text') {
  const normalized = normalizeText(text)
  return normalized ? { type: 'code', language, text: normalized } : null
}

function listBlock (items, ordered = false) {
  const normalized = (items ?? []).map(normalizeText).filter(Boolean)
  return normalized.length ? { type: 'list', ordered, items: normalized } : null
}

function jsonBlock (value) {
  if (value == null) return null
  return { type: 'json', value }
}

function getSourceRef (value) {
  return normalizeText(value?.source_path ?? value?.source_ref ?? value?.stored_path) || null
}

function preferredScope (value) {
  return normalizeText(value?.corpus ?? value?.domain) || null
}

function formatSourceLabel (value) {
  const sourceRef = typeof value === 'string' ? normalizeText(value) : getSourceRef(value)
  if (!sourceRef) return null

  if (/^https?:\/\//i.test(sourceRef)) {
    try {
      const url = new URL(sourceRef)
      const tail = url.pathname.split('/').filter(Boolean).pop()
      return tail ? `${url.hostname}/${tail}` : url.hostname
    } catch {
      return sourceRef
    }
  }

  const normalized = sourceRef.replace(/\\/g, '/')
  if (normalized.includes('/')) {
    return normalized.split('/').filter(Boolean).pop() ?? normalized
  }
  return sourceRef
}

function countLabel (count, singular, plural) {
  const n = Number.isFinite(count) ? count : 0
  return `${n} ${n === 1 ? singular : plural}`
}

function normalizeObjectPayload (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return { ...value }
}

function sanitizeDownloadFilename (value, fallback = 'download') {
  const normalized = `${value ?? ''}`.trim()
  const safe = normalized.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
  return safe || fallback
}

function inferDownloadExtension ({ candidateName = '', responseUrl = '', contentType = '' }) {
  const currentExt = path.extname(candidateName).toLowerCase()
  if (VALID_STAGING_EXTENSIONS.has(currentExt)) return currentExt

  try {
    const responseExt = path.extname(new URL(responseUrl).pathname).toLowerCase()
    if (VALID_STAGING_EXTENSIONS.has(responseExt)) return responseExt
  } catch {}

  const normalizedType = `${contentType ?? ''}`.split(';')[0].trim().toLowerCase()
  if (normalizedType === 'text/html') return '.html'
  if (normalizedType === 'text/plain') return '.txt'
  if (normalizedType === 'text/markdown' || normalizedType === 'text/x-markdown') return '.md'
  return ''
}

function isTextLikeContentType (contentType = '') {
  const normalizedType = `${contentType ?? ''}`.split(';')[0].trim().toLowerCase()
  return normalizedType.startsWith('text/') || normalizedType === 'application/xhtml+xml' || normalizedType.endsWith('+xml')
}

function replaceFilenameExtension (filename, nextExt) {
  const currentExt = path.extname(filename)
  const basename = currentExt ? path.basename(filename, currentExt) : filename
  return sanitizeDownloadFilename(`${basename || 'download'}${nextExt}`)
}

function shouldStageHtmlAsMarkdown ({ filename = '', contentType = '' }) {
  const ext = path.extname(filename).toLowerCase()
  if (ext === '.html' || ext === '.htm') return true
  return `${contentType ?? ''}`.split(';')[0].trim().toLowerCase() === 'text/html'
}

function rewriteHtmlForStaging ({ rawHtml, filename, sourceUrl }) {
  const markdown = htmlToMarkdown(rawHtml, sourceUrl)
  return {
    buffer: Buffer.from(markdown, 'utf8'),
    filename: replaceFilenameExtension(filename, '.md'),
  }
}

function collectLocalFiles (dir, validExts = VALID_STAGING_EXTENSIONS) {
  const results = []
  const walk = (currentDir) => {
    let entries
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(fullPath)
      } else if (validExts.has(path.extname(entry.name).toLowerCase())) {
        results.push(fullPath)
      }
    }
  }
  walk(dir)
  return results
}

function describeLearnSource (value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return '(invalid source)'
  return normalizeText(value.label ?? value.title ?? value.url ?? value.filePath) || '(invalid source)'
}

function normalizeLearnSource (value, index) {
  const source = typeof value === 'string'
    ? (/^https?:\/\//i.test(value) ? { url: value } : { filePath: value })
    : value

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`Source ${index + 1} must be a string or object`) }

  const url = normalizeText(source.url)
  const filePath = normalizeText(source.filePath)
  if (!url && !filePath) throw new Error(`Source ${index + 1} must include url or filePath`)
  if (url && filePath) throw new Error(`Source ${index + 1} must include only one of url or filePath`)
  if (url) {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`Source ${index + 1} has an invalid url`)
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Source ${index + 1} only supports http/https URLs`)
    }
  }

  return {
    url: url || null,
    filePath: filePath || null,
    label: normalizeText(source.label ?? source.title ?? url ?? filePath) || null,
    metadata: normalizeObjectPayload(source.metadata),
  }
}

function expandLearnSources (sources = []) {
  const expanded = []
  const errors = []

  for (let index = 0; index < sources.length; index += 1) {
    try {
      const normalized = normalizeLearnSource(sources[index], index)
      if (normalized.filePath) {
        if (!fs.existsSync(normalized.filePath)) {
          throw new Error(`File not found: ${normalized.filePath}`)
        }

        const stat = fs.statSync(normalized.filePath)
        if (stat.isDirectory()) {
          const files = collectLocalFiles(normalized.filePath)
          if (!files.length) {
            throw new Error(`No supported files found in folder: ${normalized.filePath}`)
          }
          for (const filePath of files) {
            expanded.push({
              filePath,
              url: null,
              label: filePath,
              metadata: {
                ...normalized.metadata,
                sourceFolder: normalized.filePath,
              },
            })
          }
          continue
        }
      }

      expanded.push(normalized)
    } catch (err) {
      errors.push({
        source: describeLearnSource(sources[index]),
        error: err.message,
      })
    }
  }

  return { expanded, errors }
}

async function downloadSourceBuffer (url, maxAttempts = 2) {
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Amphion/1.0 (+local)' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'follow',
      })

      if (!response.ok) {
        if (TRANSIENT_DOWNLOAD_STATUSES.has(response.status) && attempt < maxAttempts) continue
        throw new Error(`Download failed: HTTP ${response.status}`)
      }

      const contentType = response.headers.get('content-type') ?? ''
      const textResponse = isTextLikeContentType(contentType) ? response.clone() : null

      return {
        response,
        buffer: Buffer.from(await response.arrayBuffer()),
        text: textResponse ? await textResponse.text() : null,
        attempts: attempt,
      }
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts) throw err
    }
  }

  throw lastError ?? new Error('Download failed')
}

async function stageSubmission ({
  filePath = null,
  url = null,
  targetCorpus,
  domain = null,
  submittedBy = 'default',
  metadata = {},
  learnPlanId = null,
  holdForReview = false,
}) {
  if (!filePath && !url) throw new Error('filePath or url is required')
  if (filePath && url) throw new Error('provide filePath OR url, not both')

  const stagingId = randomUUID()
  const sourceMetadata = normalizeObjectPayload(metadata)
  let filename
  let inboxPath
  let sourceType

  if (url) {
    sourceType = 'download'

    let rawName
    try {
      const parsed = new URL(url)
      rawName = path.basename(parsed.pathname) || 'download'
    } catch {
      rawName = 'download'
    }
    rawName = rawName.split('?')[0].split('#')[0] || 'download'
    filename = sanitizeDownloadFilename(rawName)

    const { response, buffer, text, attempts } = await downloadSourceBuffer(url)
    const contentType = response.headers.get('content-type') ?? ''
    const inferredExt = inferDownloadExtension({
      candidateName: filename,
      responseUrl: response.url,
      contentType,
    })
    if (!path.extname(filename) && inferredExt) filename = `${filename}${inferredExt}`

    let stagedBuffer = buffer
    if (shouldStageHtmlAsMarkdown({ filename, contentType })) {
      const originalFilename = filename
      const rewritten = rewriteHtmlForStaging({
        rawHtml: text ?? buffer.toString('utf8'),
        filename,
        sourceUrl: response.url || url,
      })
      stagedBuffer = rewritten.buffer
      filename = rewritten.filename
      sourceMetadata.originalFilename = originalFilename
      sourceMetadata.originalContentType = contentType || null
      sourceMetadata.transformedContent = 'markdown'
    }

    inboxPath = path.join(STAGING_INBOX, `${stagingId}-${filename}`)
    fs.writeFileSync(inboxPath, stagedBuffer)
    sourceMetadata.downloadAttempts = attempts
  } else {
    sourceType = 'upload'

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`)
    }

    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      throw new Error(`Directories must be expanded before staging: ${filePath}`)
    }

    filename = path.basename(filePath)
    inboxPath = path.join(STAGING_INBOX, `${stagingId}-${filename}`)
    if (shouldStageHtmlAsMarkdown({ filename })) {
      const rewritten = rewriteHtmlForStaging({
        rawHtml: fs.readFileSync(filePath, 'utf8'),
        filename,
        sourceUrl: pathToFileURL(filePath).href,
      })
      inboxPath = path.join(STAGING_INBOX, `${stagingId}-${rewritten.filename}`)
      fs.writeFileSync(inboxPath, rewritten.buffer)
      sourceMetadata.originalFilename = filename
      sourceMetadata.transformedContent = 'markdown'
      filename = rewritten.filename
    } else {
      fs.copyFileSync(filePath, inboxPath)
    }
    sourceMetadata.sourcePath = filePath
  }

  if (learnPlanId) sourceMetadata.learnPlanId = learnPlanId
  if (holdForReview) sourceMetadata.holdForReview = true

  const sidecar = {
    corpus: targetCorpus,
    domain: domain ?? targetCorpus,
    sourceUrl: url ?? null,
    sourceType,
    submittedBy,
    metadata: sourceMetadata,
    learnPlanId,
    holdForReview,
  }
  fs.writeFileSync(inboxPath + '.meta.json', JSON.stringify(sidecar, null, 2), 'utf8')

  registerStagedFile({
    id: stagingId,
    filename,
    inboxPath,
    sourceUrl: url ?? null,
    sourceType,
    corpus: targetCorpus,
    domain: domain ?? targetCorpus,
    learnPlanId,
    submittedBy,
    metadata: sourceMetadata,
  })

  return {
    stagingId,
    filename,
    corpus: targetCorpus,
    sourceType,
    sourceUrl: url ?? null,
    sourcePath: filePath ?? null,
    status: 'pending',
    holdForReview,
  }
}

function collectLearnRequestSources (body = {}) {
  const sources = Array.isArray(body.sources) ? [...body.sources] : []
  if (Array.isArray(body.urls)) {
    sources.push(...body.urls.map(url => ({ url })))
  }
  if (Array.isArray(body.filePaths)) {
    sources.push(...body.filePaths.map(filePath => ({ filePath })))
  }
  return sources
}

function buildLearnPlanSummary ({ targetCorpus, requestedCount, expandedCount, queuedCount, failedCount }) {
  const sentences = []
  if (requestedCount > 0) {
    sentences.push(`Prepared an inline learn batch for ${targetCorpus}.`)
    if (expandedCount > requestedCount) {
      sentences.push(`Expanded ${countLabel(requestedCount, 'input', 'inputs')} into ${countLabel(expandedCount, 'file', 'files')}.`)
    }
    sentences.push(`Queued ${countLabel(queuedCount, 'file', 'files')} for review.`)
  } else {
    sentences.push(`Created an inline learn plan for ${targetCorpus}.`)
    sentences.push('No sources were queued yet.')
  }
  if (failedCount > 0) {
    sentences.push(`${countLabel(failedCount, 'source failed', 'sources failed')} intake.`)
  }
  return sentences.join(' ')
}

function buildLearnFindings ({ targetCorpus, requestedSources, queued, failed }) {
  return {
    target_corpus: targetCorpus,
    requested_source_count: requestedSources.length,
    queued_source_count: queued.length,
    failed_source_count: failed.length,
    queued_sources: queued,
    failed_sources: failed,
  }
}

function buildLearnProposal ({ targetCorpus, queuedCount }) {
  return {
    target_corpus: targetCorpus,
    execution_mode: 'inline',
    approval_mode: 'batch',
    hold_for_review: true,
    next_action: queuedCount > 0 ? 'review_staged_batch' : 'add_sources',
  }
}

function ensureDirectory (dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function moveFileSafe (fromPath, toPath) {
  ensureDirectory(path.dirname(toPath))
  try {
    fs.renameSync(fromPath, toPath)
  } catch {
    fs.copyFileSync(fromPath, toPath)
    fs.unlinkSync(fromPath)
  }
}

function resolveCurrentStagedPath (row) {
  if (!row) return null
  if (row.status === 'review' && row.review_path) return row.review_path
  if (row.status === 'approved' && row.approved_path) return row.approved_path
  if (row.status === 'rejected') return path.join(STAGING_REJECTED, path.basename(row.inbox_path))
  return row.inbox_path
}

function summarizeStagedFiles (rows = []) {
  const summary = {
    total_count: rows.length,
    review_count: 0,
    approved_count: 0,
    rejected_count: 0,
    ingested_count: 0,
    pending_count: 0,
    scanning_count: 0,
  }

  for (const row of rows) {
    const key = `${row?.status ?? ''}`.toLowerCase()
    if (key === 'review') summary.review_count += 1
    else if (key === 'approved') summary.approved_count += 1
    else if (key === 'rejected') summary.rejected_count += 1
    else if (key === 'ingested') summary.ingested_count += 1
    else if (key === 'pending') summary.pending_count += 1
    else if (key === 'scanning') summary.scanning_count += 1
  }

  return summary
}

function serializeLearnPlan (plan, { includeStagedFiles = false } = {}) {
  const stagedFiles = getStagedFilesByLearnPlanId(plan.id, { limit: 500 })
  const stagedSummary = summarizeStagedFiles(stagedFiles)
  const payload = {
    ...plan,
    target_corpus: normalizeText(plan?.metadata?.targetCorpus ?? plan?.findings?.target_corpus) || null,
    staged_summary: stagedSummary,
  }

  if (includeStagedFiles) payload.staged_files = stagedFiles
  return payload
}

function parseLearnPlanStatuses (value) {
  const normalized = `${value ?? ''}`.trim()
  if (!normalized) return null
  const statuses = normalized
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)
  return statuses.length ? statuses : null
}

function makeEntry (runId, seq, mode, subject, status, summary, blocks = [], refs = [], raw = null) {
  const ts = nowIso()
  return {
    id: `${runId}:entry:${seq}`,
    seq,
    mode,
    subject,
    status,
    summary,
    ts_start: ts,
    ts_end: ts,
    blocks: blocks.filter(Boolean),
    refs: refs.filter(Boolean),
    raw,
  }
}

function summarizeTicket (ticket) {
  const domains = ticket?.domains ?? []
  if (domains.length) return `Routed to ${domains.join(', ')}`
  if (ticket?.modality) return `Routed as ${ticket.modality}`
  return normalizeText(ticket?.intent) || 'Request routed'
}

function summarizeAgentResult (event) {
  if (event.foundNothing) return `No matching results in ${event.domain}`
  if (event.isFilesystem) return `Searched filesystem in ${event.domain}`
  if (event.isArtifacts) return `Collected ${countLabel(event.chunkCount, 'artifact', 'artifacts')}`
  return `Collected ${countLabel(event.docCount, 'resource', 'resources')} and ${countLabel(event.chunkCount, 'excerpt', 'excerpts')}`
}

function filesystemBlocks (item) {
  if (!item) return []
  if (item.kind === 'fs_dir') {
    const names = (item.entries ?? []).slice(0, 12).map(entry => `${entry.type === 'dir' ? '[dir]' : '[file]'} ${entry.name}`)
    return [
      paragraphBlock(item.path ? `Path: ${item.path}` : ''),
      listBlock(names),
      badgeBlock(countLabel(item.entries?.length ?? 0, 'visible item', 'visible items'), 'info'),
    ]
  }
  if (item.kind === 'fs_find') {
    const hits = (item.results ?? []).slice(0, 12).map(result => result.file ?? result.name ?? '')
    return [
      paragraphBlock(item.query ? `Query: ${item.query}` : ''),
      listBlock(hits),
      badgeBlock(countLabel(item.results?.length ?? 0, 'match', 'matches'), 'info'),
    ]
  }
  if (item.kind === 'fs_file') {
    return [
      paragraphBlock(item.path ? `Read: ${item.path}` : ''),
      codeBlock(item.content ?? '', 'text'),
      item.truncated ? badgeBlock('truncated', 'warn') : null,
    ]
  }
  return [jsonBlock(item)]
}

function resourceRef (value, fallbackLabel = 'resource') {
  const locator = compactObject({
    section: normalizeText(value?.section_header) || null,
    char_start: value?.char_start ?? null,
    char_end: value?.char_end ?? null,
  })
  return compactObject({
    kind: 'resource',
    target_id: getSourceRef(value) ?? (normalizeText(value?.doc_id ?? value?.resource_id) || null),
    label: joinMeta(normalizeText(value?.title), normalizeText(value?.section_header), formatSourceLabel(value)) || fallbackLabel,
    locator: Object.keys(locator).length ? locator : null,
  })
}

function buildChronicleEntry (runId, seq, type, payload = {}) {
  switch (type) {
    case 'status': {
      const summary = normalizeText(payload.message) || 'Status update'
      return makeEntry(
        runId,
        seq,
        'narrate',
        { kind: 'session', label: 'Broker' },
        'done',
        summary,
        [paragraphBlock(summary)],
        [],
        payload,
      )
    }

    case 'ticket': {
      const ticket = payload.data ?? {}
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'session', label: 'Dispatcher' },
        'done',
        summarizeTicket(ticket),
        [
          paragraphBlock(ticket.intent),
          listBlock((ticket.domains ?? []).map(domain => `corpus: ${domain}`)),
          badgeBlock(ticket.modality, 'info'),
          badgeBlock(ticket.urgency, 'neutral'),
        ],
        [],
        ticket,
      )
    }

    case 'agent_step': {
      const queryArg = payload.args?.query
        ?? payload.args?.task
        ?? payload.args?.title
        ?? payload.args?.path
        ?? payload.args?.section_header
      return makeEntry(
        runId,
        seq,
        'act',
        { kind: 'tool', id: normalizeText(payload.tool), label: normalizeText(payload.tool) || 'tool' },
        'done',
        `Ran ${normalizeText(payload.tool) || 'tool'}${payload.domain ? ` in ${payload.domain}` : ''}`,
        [
          paragraphBlock(queryArg ? `Input: ${queryArg}` : ''),
          paragraphBlock(payload.reasoning),
          badgeBlock(payload.domain ? `domain: ${payload.domain}` : '', 'info'),
          badgeBlock(Number.isFinite(payload.resultCount) ? countLabel(payload.resultCount, 'result', 'results') : '', payload.resultCount === 0 ? 'warn' : 'success'),
          payload.args && !queryArg ? jsonBlock(payload.args) : null,
        ],
        [compactObject({ kind: 'tool', target_id: normalizeText(payload.tool), label: normalizeText(payload.tool) || null })],
        payload,
      )
    }

    case 'verification': {
      const summary = payload.phase === 'retry'
        ? 'Retrying evidence lookup'
        : 'Checked evidence support'
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'session', label: 'Verifier' },
        'done',
        summary,
        [
          paragraphBlock(payload.rationale),
          paragraphBlock(payload.query ? `Query: ${payload.query}` : ''),
          paragraphBlock(payload.previousQuery ? `Previous: ${payload.previousQuery}` : ''),
          paragraphBlock(payload.nextQuery ? `Next: ${payload.nextQuery}` : ''),
          badgeBlock(Number.isFinite(payload.attempt) ? `attempt ${payload.attempt}` : '', 'neutral'),
          badgeBlock(normalizeText(payload.verdict), payload.shouldRetry ? 'warn' : 'info'),
          badgeBlock(payload.shouldRetry ? 'retrying' : 'accepted', payload.shouldRetry ? 'warn' : 'success'),
        ],
        [],
        payload,
      )
    }

    case 'agent_result': {
      return makeEntry(
        runId,
        seq,
        'observe',
        {
          kind: payload.isArtifacts ? 'artifact' : payload.isFilesystem ? 'tool' : 'resource',
          id: normalizeText(payload.domain),
          label: normalizeText(payload.domain) || 'result',
        },
        payload.foundNothing ? 'error' : 'done',
        summarizeAgentResult(payload),
        [
          paragraphBlock(payload.task),
          badgeBlock(payload.domain ? `domain: ${payload.domain}` : '', 'info'),
          !payload.isFilesystem && !payload.isArtifacts ? badgeBlock(countLabel(payload.docCount, 'resource', 'resources'), 'neutral') : null,
          !payload.isFilesystem ? badgeBlock(countLabel(payload.chunkCount, payload.isArtifacts ? 'artifact' : 'excerpt', payload.isArtifacts ? 'artifacts' : 'excerpts'), payload.foundNothing ? 'warn' : 'success') : null,
          payload.isFilesystem ? paragraphBlock(payload.filesystemSummary) : null,
        ],
        [],
        payload,
      )
    }

    case 'result_item': {
      const item = payload
      const summary = item.kind === 'fs_dir'
        ? `Browsed ${normalizeText(item.path) || 'directory'}`
        : item.kind === 'fs_find'
          ? `Searched for ${normalizeText(item.query) || 'matches'}`
          : `Read ${normalizeText(item.path) || 'file'}`
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'tool', label: item.kind },
        'done',
        summary,
        filesystemBlocks(item),
        [compactObject({ kind: 'resource', target_id: normalizeText(item.path), label: normalizeText(item.path ?? item.query) || null })],
        item,
      )
    }

    case 'evidence_card': {
      const card = payload.card ?? payload
      const quoteText = normalizeText(card.highlight_phrase) || normalizeText(card.content).slice(0, 400)
      const attribution = joinMeta(normalizeText(card.title), normalizeText(card.section_header), formatSourceLabel(card))
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'resource', id: getSourceRef(card) ?? normalizeText(card.doc_id), label: normalizeText(card.title) || 'resource excerpt' },
        'done',
        attribution || 'Observed resource excerpt',
        [
          badgeBlock(preferredScope(card), 'info'),
          quoteBlock(quoteText, attribution || null),
          paragraphBlock(card.annotation),
        ],
        [resourceRef(card)],
        card,
      )
    }

    case 'artifact_card': {
      const artifact = payload.artifact ?? payload.resource ?? payload
      const summary = normalizeText(artifact.title ?? artifact.filename) || 'Observed artifact'
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'artifact', id: normalizeText(artifact.resource_id), label: summary },
        'done',
        summary,
        [
          paragraphBlock(artifact.summary ?? artifact.description),
          badgeBlock(preferredScope(artifact), 'info'),
          badgeBlock(normalizeText(artifact.resource_type ?? artifact.type), 'neutral'),
        ],
        [compactObject({ kind: 'artifact', target_id: normalizeText(artifact.resource_id), label: summary })],
        artifact,
      )
    }

    case 'error': {
      const summary = normalizeText(payload.message) || 'Pipeline error'
      return makeEntry(
        runId,
        seq,
        'observe',
        { kind: 'session', label: 'Broker' },
        'error',
        summary,
        [paragraphBlock(summary)],
        [],
        payload,
      )
    }

    default:
      return null
  }
}

function createChronicleEmitter (res, runId) {
  let entrySeq = 0

  const emit = (type, payload = {}) => {
    writeSse(res, type, payload)
  }

  const send = (type, payload = {}) => {
    emit(type, payload)
    const entry = buildChronicleEntry(runId, ++entrySeq, type, payload)
    if (entry) emit('chronicle_entry', { runId, entry })
  }

  return {
    emit,
    send,
  }
}

// ---------------------------------------------------------------------------
// POST /query — main pipeline entry point
// Streams back SSE events to the client as each pipeline stage completes.
// ---------------------------------------------------------------------------
app.post('/query', async (req, res) => {
  const { message, sessionId = randomUUID(), requestId: incomingRequestId = null, userId = 'default', workspaceId = null } = req.body
  const requestId = normalizeText(incomingRequestId) || randomUUID()
  const runId = requestId

  if (!message?.trim()) {
    return res.status(400).json({ error: 'message is required' })
  }

  const trace = new Trace(requestId, sessionId, message)

  // Set up SSE headers — the Electron app will consume these
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.flushHeaders()

  const { emit, send } = createChronicleEmitter(res, runId)
  emit('run_start', {
    runId,
    sessionId,
    userId,
    workspaceId,
    startedAt: nowIso(),
  })

  let runStatus = 'done'

  try {
    // Stage 1: Context Assembler (no LLM, fast)
    send('status', { message: 'Assembling context...' })
    const context = await assembleContext(sessionId, userId, workspaceId)
    trace.stage('context', {
      historyLength:   context.history?.length ?? 0,
      contextSummary:  context.contextSummary,
      userProfile:     { displayName: context.displayName, company: context.company, role: context.role },
      history:         context.history,
    })

    // Stage 2: Dispatcher — classifies query, returns job ticket
    send('status', { message: 'Routing your request...' })
    const jobTicket = await dispatch(message, context, trace)
    send('ticket', { data: jobTicket })

    // Log this query for the self-organizing agent (non-blocking)
    logQuery(userId, sessionId, jobTicket.intent, [jobTicket.modality ?? 'retrieve'], workspaceId)

    let fullResponse = ''
    let agentResults = null

    if (typeof jobTicket.directResponse === 'string' && jobTicket.directResponse.trim()) {
      fullResponse = jobTicket.directResponse.trim()
      send('token', { token: fullResponse })
    } else if (jobTicket.modality === 'conversation') {
      // General knowledge / conversational — skip agents, go straight to voice
      send('status', { message: 'Thinking...' })
      const tokenStream = await synthesizeStream({}, message, context, trace, jobTicket)
      for await (const event of tokenStream) {
        if (event && typeof event === 'object') {
          if (event.type === 'card') {
            send('evidence_card', { card: event.card })
          } else if (event.type === 'token') {
            fullResponse += event.token
            send('token', { token: event.token })
          }
        } else {
          fullResponse += event
          send('token', { token: event })
        }
      }
    } else {
      // Stage 3: Orchestrator — calls domain agents per job ticket
      const domainLabel = jobTicket.modality ?? 'resources'
      send('status', { message: `Consulting ${domainLabel}...` })
      agentResults = await orchestrate(jobTicket, message, context, trace, send)

      // Emit one agent_result event per domain so the renderer can show the trace
      for (const [domain, result] of Object.entries(agentResults)) {
        const primary = (result.items ?? []).filter(c => !c.is_neighbor)
        const docIds  = new Set(primary.map(c => c.doc_id).filter(Boolean))
        send('agent_result', {
          domain,
          task:         jobTicket.topic ?? jobTicket.intent ?? '',
          chunkCount:   result.isArtifacts ? result.items.length : result.isFilesystem ? 0 : primary.length,
          docCount:     result.isArtifacts ? result.items.length : result.isFilesystem ? 0 : docIds.size,
          foundNothing: result.foundNothing ?? (result.isArtifacts ? result.items.length === 0 : primary.length === 0),
          isArtifacts:  result.isArtifacts ?? false,
          isFilesystem: result.isFilesystem ?? false,
          filesystemSummary: result.isFilesystem ? result.summary : undefined,
          verificationVerdict: result.verification?.verdict,
          verificationRationale: result.verification?.rationale,
          triedQueries: result.triedQueries,
        })
      }

      // Emit structured result items for filesystem results — UI renders them directly
      // without the LLM narrating raw entry names (prevents hallucination/editorializing)
      for (const [, result] of Object.entries(agentResults)) {
        if (!result.isFilesystem) continue
        for (const item of buildFilesystemItems(result)) {
          send('result_item', item)
        }
      }

      // Stage 4: Voice Layer — stream tokens and evidence cards directly to client
      send('status', { message: 'Composing response...' })
      const tokenStream = await synthesizeStream(agentResults, message, context, trace, jobTicket)
      for await (const event of tokenStream) {
        if (event && typeof event === 'object') {
          if (event.type === 'card') {
            send('evidence_card', { card: event.card })
          } else if (event.type === 'artifact_card') {
            send('artifact_card', { artifact: event.artifact })
          } else if (event.type === 'token') {
            fullResponse += event.token
            send('token', { token: event.token })
          }
        } else {
          fullResponse += event
          send('token', { token: event })
        }
      }

      if (context.activeScope) {
        const resourceIds = collectScopeResourceIds(agentResults)
        if (resourceIds.length > 0) {
          try {
            await recordScopeResourceHits({ scope: context.activeScope, resourceIds })
          } catch (err) {
            console.warn('[broker] scope experience update failed:', err.message)
          }
        }
      }
    }

    // Save this turn to conversation history.
    // Persist structured metadata alongside the assistant turn so the dispatcher
    // can ground follow-up pronouns ("it", "that", "those") to concrete facts
    // rather than having to infer from vague prose history.
    const assistantMeta = { modality: jobTicket.modality ?? null, topic: jobTicket.topic ?? null }
    if (agentResults) {
      // Collect filesystem paths that were actually returned so "it" / "that folder" resolves
      const fsPaths = []
      for (const result of Object.values(agentResults)) {
        if (!result?.isFilesystem) continue
        const raw = result.filesystemRaw ?? {}
        if (raw.observations?.length) {
          for (const o of raw.observations) {
            // browse_path / read_file have the path in raw.path or args.path
            const p = o.raw?.path ?? o.args?.path
            if (p) fsPaths.push(p)
            // find_path results have paths in the results array (not .path)
            if (o.tool === 'find_path' && o.raw?.results?.length) {
              for (const r of o.raw.results.slice(0, 10)) {
                if (r.file) fsPaths.push(r.file)
              }
            }
          }
        } else {
          const p = raw.path ?? raw.roots?.[0]
          if (p) fsPaths.push(p)
          // find_path results — include the matched paths
          if (raw.results?.length) {
            for (const r of raw.results.slice(0, 10)) {
              if (r.file) fsPaths.push(r.file)
            }
          }
        }
      }
      if (fsPaths.length) assistantMeta.filesystemPaths = [...new Set(fsPaths)]
    }
    saveConversationTurn(sessionId, 'user', message, { jobTicket }, userId, workspaceId)
    saveConversationTurn(sessionId, 'assistant', fullResponse, assistantMeta, userId, workspaceId)

    trace.finish(fullResponse)

  } catch (err) {
    console.error('[broker] pipeline error:', err)
    trace.stage('error', { message: err.message, stack: err.stack })
    trace.finish('')
    runStatus = 'error'
    send('error', { message: err.message ?? 'Pipeline error' })
  } finally {
    emit('run_done', { runId, sessionId, traceId: trace.requestId, status: runStatus, endedAt: nowIso() })
    emit('done', { sessionId, traceId: trace.requestId })
    res.end()
    trace.save()
  }
})

// ---------------------------------------------------------------------------
// GET /traces — list recent pipeline traces
// ---------------------------------------------------------------------------
app.get('/traces', (_req, res) => {
  res.json(Trace.list())
})

// GET /traces/:id — fetch full trace JSON
app.get('/traces/:id', (req, res) => {
  const trace = Trace.read(req.params.id)
  if (!trace) return res.status(404).json({ error: 'trace not found' })
  res.json(trace)
})

// ---------------------------------------------------------------------------
// DELETE /conversation/:sessionId — wipe stored turns for one session
// ---------------------------------------------------------------------------
app.delete('/conversation/:sessionId', (req, res) => {
  const { sessionId } = req.params
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
  const deleted = clearConversation(sessionId)
  res.json({ ok: true, deleted })
})

// ---------------------------------------------------------------------------
// DELETE /conversations/all — wipe ALL turns for a user (full memory wipe)
// ---------------------------------------------------------------------------
app.delete('/conversations/all', (req, res) => {
  const userId = req.query.userId || 'default'
  const deleted = clearAllConversations(userId)
  res.json({ ok: true, deleted })
})

// ---------------------------------------------------------------------------
// GET /artifacts/:id/:filename — compatibility file serving route.
// Resource-backed: serves either a managed copy under data/artifacts/ or the
// original local path for trusted in-place resources.
// ---------------------------------------------------------------------------
app.get('/artifacts/:id/:filename', async (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid id' })

  let row
  try {
    row = await db_getArtifactById(id)
    if (!row) return res.status(404).json({ error: 'Artifact not found' })
  } catch (err) {
    return res.status(500).json({ error: 'DB error' })
  }

  if (!row.stored_path) {
    return res.status(404).json({ error: 'Artifact file is not locally available' })
  }

  const resolved = path.resolve(row.stored_path)
  const isManagedPath = resolved.startsWith(ARTIFACTS_ROOT + path.sep) || resolved === ARTIFACTS_ROOT
  const isTrustedLocalPath = row.source_kind === 'path'

  if (!isManagedPath && !isTrustedLocalPath) {
    return res.status(403).json({ error: 'Forbidden' })
  }
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'Artifact not found' })
  }

  res.sendFile(resolved, err => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Artifact not found' })
  })
})

// ---------------------------------------------------------------------------
// POST /learn — create or update one inline learn plan and stage sources
// through the existing review-held quarantine pipeline.
//
// Body: {
//   request?, learnPlanId?, title?, userId?, requestedBy?, corpus?, domain?,
//   sources?: [{ url? | filePath?, label?, metadata? }],
//   urls?: string[], filePaths?: string[], metadata?
// }
// ---------------------------------------------------------------------------
app.post('/learn', async (req, res) => {
  const {
    request = null,
    title = null,
    userId = req.body?.user_id ?? 'default',
    requestedBy = req.body?.requested_by ?? 'default',
    corpus = null,
    domain = null,
    metadata = {},
  } = req.body ?? {}
  const learnPlanId = normalizeText(req.body?.learnPlanId ?? req.body?.learn_plan_id) || null
  const targetCorpus = `${corpus ?? domain ?? 'research'}`.trim() || 'research'
  const requestedSources = collectLearnRequestSources(req.body ?? {})

  if (!learnPlanId && !normalizeText(request)) {
    return res.status(400).json({ error: 'request is required when learnPlanId is not provided' })
  }

  let plan = null
  const requestedMetadata = normalizeObjectPayload(metadata)
  const existingPlan = learnPlanId ? getLearnPlanById(learnPlanId) : null
  if (learnPlanId && !existingPlan) {
    return res.status(404).json({ error: `Unknown learn plan: ${learnPlanId}` })
  }
  if (existingPlan && ['approved', 'rejected', 'completed'].includes(existingPlan.status)) {
    return res.status(400).json({ error: `learn plan ${learnPlanId} is closed (status=${existingPlan.status})` })
  }

  try {
    const planId = existingPlan?.id ?? randomUUID()
    if (!existingPlan) {
      plan = createLearnPlan({
        id: planId,
        request: normalizeText(request),
        title: normalizeText(title) || null,
        userId,
        requestedBy,
        status: 'draft',
        metadata: {
          ...requestedMetadata,
          targetCorpus,
          executionMode: 'inline',
          approvalMode: 'batch',
          sourcePolicy: 'direct-user-provided',
        },
      })
    } else {
      plan = existingPlan
    }

    const { expanded, errors: expansionErrors } = expandLearnSources(requestedSources)
    const queued = []
    const failed = [...expansionErrors]

    for (let index = 0; index < expanded.length; index += 1) {
      const source = expanded[index]
      try {
        const staged = await stageSubmission({
          filePath: source.filePath,
          url: source.url,
          targetCorpus,
          domain: domain ?? targetCorpus,
          submittedBy: requestedBy,
          learnPlanId: plan.id,
          holdForReview: true,
          metadata: {
            ...requestedMetadata,
            ...normalizeObjectPayload(source.metadata),
            sourceLabel: source.label ?? null,
            sourceIndex: index,
          },
        })
        queued.push(staged)
      } catch (err) {
        failed.push({
          source: source.label ?? source.url ?? source.filePath ?? `(source ${index + 1})`,
          error: err.message,
        })
      }
    }

    const summary = buildLearnPlanSummary({
      targetCorpus,
      requestedCount: requestedSources.length,
      expandedCount: expanded.length,
      queuedCount: queued.length,
      failedCount: failed.length,
    })
    const findings = buildLearnFindings({ targetCorpus, requestedSources, queued, failed })
    const proposal = buildLearnProposal({ targetCorpus, queuedCount: queued.length })
    const nextStatus = queued.length > 0 ? 'pending' : 'draft'

    plan = updateLearnPlan(plan.id, {
      title: normalizeText(title) || plan.title,
      request: normalizeText(request) || plan.request,
      status: nextStatus,
      summary,
      findings,
      proposal,
      metadata: {
        ...(plan.metadata ?? {}),
        ...requestedMetadata,
        targetCorpus,
        executionMode: 'inline',
        approvalMode: 'batch',
        sourcePolicy: 'direct-user-provided',
        requestedSourceCount: requestedSources.length,
        expandedSourceCount: expanded.length,
        queuedSourceCount: queued.length,
        failedSourceCount: failed.length,
      },
    })

    return res.json({
      ok: true,
      plan,
      batch: {
        requested_source_count: requestedSources.length,
        expanded_source_count: expanded.length,
        queued_count: queued.length,
        failed_count: failed.length,
        queued,
        failed,
      },
      message: queued.length > 0
        ? 'Learn plan updated and sources queued for review.'
        : 'Learn plan updated, but no sources were queued.',
    })
  } catch (err) {
    console.error('[broker] /learn error:', err.message)
    if (plan?.id) {
      try {
        updateLearnPlan(plan.id, {
          summary: `Learn batch failed before staging completed: ${err.message}`,
          findings: {
            target_corpus: targetCorpus,
            requested_source_count: requestedSources.length,
            queued_source_count: 0,
            failed_source_count: requestedSources.length,
            failed_sources: [{ source: normalizeText(request) || plan.request, error: err.message }],
          },
        })
      } catch {}
    }
    return res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /learn/plans — list learn plans with staged-file counts for the desktop.
// Query: { status?: 'pending,approved', userId?, limit? }
// ---------------------------------------------------------------------------
app.get('/learn/plans', (req, res) => {
  try {
    const status = parseLearnPlanStatuses(req.query?.status)
    const userId = normalizeText(req.query?.userId) || null
    const rawLimit = Number.parseInt(`${req.query?.limit ?? '20'}`, 10)
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 20
    const plans = getLearnPlans({ status, userId, limit })

    return res.json({
      ok: true,
      count: plans.length,
      plans: plans.map(plan => serializeLearnPlan(plan)),
    })
  } catch (err) {
    console.error('[broker] /learn/plans error:', err.message)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /learn/plans/:id — read one learn plan plus its staged files.
// ---------------------------------------------------------------------------
app.get('/learn/plans/:id', (req, res) => {
  const learnPlanId = normalizeText(req.params?.id)
  if (!learnPlanId) return res.status(400).json({ ok: false, error: 'learn plan id is required' })

  try {
    const plan = getLearnPlanById(learnPlanId)
    if (!plan) return res.status(404).json({ ok: false, error: `Unknown learn plan: ${learnPlanId}` })
    return res.json({ ok: true, plan: serializeLearnPlan(plan, { includeStagedFiles: true }) })
  } catch (err) {
    console.error('[broker] /learn/plans/:id error:', err.message)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// POST /learn/plans/:id/decide — approve or reject a review-held learn batch.
// Body: { decision: 'approve' | 'reject', decisionNotes? }
// ---------------------------------------------------------------------------
app.post('/learn/plans/:id/decide', (req, res) => {
  const learnPlanId = normalizeText(req.params?.id)
  const decision = normalizeText(req.body?.decision).toLowerCase()
  const decisionNotes = normalizeText(req.body?.decisionNotes ?? req.body?.decision_notes) || null

  if (!learnPlanId) return res.status(400).json({ ok: false, error: 'learn plan id is required' })
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ ok: false, error: 'decision must be "approve" or "reject"' })
  }

  try {
    const existing = getLearnPlanById(learnPlanId)
    if (!existing) return res.status(404).json({ ok: false, error: `Unknown learn plan: ${learnPlanId}` })

    const reviewFiles = getStagedFilesByLearnPlanId(learnPlanId, { status: 'review', limit: 1000 })
    const moved = []
    const now = new Date().toISOString()

    for (const row of reviewFiles) {
      const currentPath = resolveCurrentStagedPath(row)
      if (!currentPath || !fs.existsSync(currentPath)) continue

      const targetDir = decision === 'approve' ? STAGING_APPROVED : STAGING_REJECTED
      const targetPath = path.join(targetDir, path.basename(currentPath))
      moveFileSafe(currentPath, targetPath)

      if (decision === 'approve') {
        updateStagedStatus(row.id, 'approved', {
          scanResult: 'pass',
          scanNotes: decisionNotes ?? 'approved via learn plan decision',
          reviewPath: null,
          approvedPath: targetPath,
          approvedAt: now,
        })
      } else {
        updateStagedStatus(row.id, 'rejected', {
          scanResult: 'fail',
          scanNotes: decisionNotes ?? 'rejected via learn plan decision',
          reviewPath: null,
          approvedPath: null,
        })
      }

      moved.push({
        staging_id: row.id,
        filename: row.filename,
        status: decision === 'approve' ? 'approved' : 'rejected',
        target_path: targetPath,
      })
    }

    const plan = updateLearnPlan(learnPlanId, {
      status: decision === 'approve' ? 'approved' : 'rejected',
      decisionNotes,
      decidedAt: now,
    })

    return res.json({
      ok: true,
      plan: serializeLearnPlan(plan, { includeStagedFiles: true }),
      moved_count: moved.length,
      moved_files: moved,
      message: decision === 'approve'
        ? 'Learn plan approved and review-held files released to approved/.'
        : 'Learn plan rejected and review-held files moved to rejected/.',
    })
  } catch (err) {
    console.error('[broker] /learn/plans/:id/decide error:', err.message)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// POST /stage — quarantine intake endpoint
//
// All externally-sourced content (agent downloads, user uploads, web fetches)
// enters through here. Files land in data/staging/inbox/ and are NOT ingested
// directly. stage-watch.js picks them up, scans them, and promotes approved
// files to data/staging/approved/ where watch-ingest.js picks them up.
//
// Network constraint: fetch(url) ONLY happens here — never inside _ingest-lib
// or agent code. This is the single controlled egress point for downloads.
//
// Body: { filePath?, url?, corpus?, domain?, submittedBy?, metadata? }
//   filePath — local file to copy into inbox (must already be on disk)
//   url      — remote URL to download into inbox
//   corpus   — target corpus key (default: 'research')
//   domain   — legacy alias for corpus
//   submittedBy — user identifier (default: 'default')
//   metadata — arbitrary JSON stored on the staged_files row
// ---------------------------------------------------------------------------
app.post('/stage', async (req, res) => {
  const { filePath, url, corpus = null, domain = null, submittedBy = 'default', metadata = {} } = req.body
  const targetCorpus = `${corpus ?? domain ?? 'research'}`.trim() || 'research'

  if (!filePath && !url) {
    return res.status(400).json({ error: 'filePath or url is required' })
  }
  if (filePath && url) {
    return res.status(400).json({ error: 'provide filePath OR url, not both' })
  }

  try {
    const staged = await stageSubmission({
      filePath,
      url,
      targetCorpus,
      domain,
      submittedBy,
      metadata,
    })

    console.log(`[broker] /stage: queued ${staged.filename} (id=${staged.stagingId}, type=${staged.sourceType}, corpus=${targetCorpus})`)

    return res.json({
      ok: true,
      ...staged,
      message: 'File queued for scan. stage-watch.js will process it momentarily.',
    })

  } catch (err) {
    console.error('[broker] /stage error:', err.message)
    return res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// POST /ingest — ingest a single file into a corpus on demand.
// Accepts corpus as canonical input; domain remains a compatibility alias.
// ---------------------------------------------------------------------------
app.post('/ingest', async (req, res) => {
  const { filePath, corpus = null, domain = null, force = false, noSummary = false, noCopy = false } = req.body
  const targetCorpus = `${corpus ?? domain ?? ''}`.trim()

  if (!filePath || !targetCorpus) {
    return res.status(400).json({ error: 'filePath and corpus are required' })
  }
  try {
    const result = await ingestFile(filePath, targetCorpus, { force, noSummary, noCopy, corpus: targetCorpus })
    res.json({ ok: true, corpus: targetCorpus, ...result })
  } catch (err) {
    console.error('[broker] /ingest error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok:          true,
    system:      process.env.SYSTEM_NAME  ?? 'amphion',
    displayName: process.env.DISPLAY_NAME ?? 'Atlas',
  })
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function start () {
  await initDb()
  app.listen(PORT, HOST, () => {
    console.log(`[broker] listening on http://${HOST}:${PORT}`)
    console.log(`[broker] SYSTEM_NAME=${process.env.SYSTEM_NAME ?? 'amphion'}  DISPLAY_NAME=${process.env.DISPLAY_NAME ?? 'Atlas'}`)
  })
}

start().catch(err => {
  console.error('[broker] failed to start:', err)
  process.exit(1)
})
