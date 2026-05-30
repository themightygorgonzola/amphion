/**
 * scripts/_ingest-lib.mjs — Shared ingest logic
 *
 * Extracted from ingest.js so that both ingest.js and watch-ingest.js
 * can use the same pipeline without duplication.
 *
 * Exports:
 *   embed(text)                          → number[]
 *   generateSummary(title, content)      → string
 *   sha256(text)                         → string
 *   chunkDocument(text, { title })       → { chunks, router }
 *   chunkText(text, { title })           → { content, sectionHeader, sectionPath }[]
 *   addCharOffsets(text, chunks)         → chunks with charStart/charEnd
 *   inferDocType(filePath)               → string
 *   ingestFile(filePath, corpus, opts)   → { chunks, skipped, reason? }
 *   collectFiles(dirPath, defaultCorpus) → { filePath, domain }[]
 *   closePool()                          → Promise<void>
 */

import fs     from 'fs'
import path   from 'path'
import crypto from 'crypto'
import pg     from 'pg'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { CHUNKING_VERSION, chunkDocument, chunkText } from './_chunking.mjs'
import { attachResourceToScope, upsertScope } from '../apps/broker/src/organization-store.js'

const _require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Artifacts managed store
// ---------------------------------------------------------------------------
const AMPHION_ROOT   = path.resolve(__dirname, '..')
const ARTIFACTS_ROOT = path.resolve(AMPHION_ROOT, 'data', 'artifacts')
fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true })

// ---------------------------------------------------------------------------
// Config (read from process.env — caller must have loaded .env before import)
// ---------------------------------------------------------------------------
export const OLLAMA_HOST   = process.env.OLLAMA_HOST         ?? 'http://localhost:11434'
export const EMBED_MODEL   = process.env.OLLAMA_MODEL_EMBED   ?? 'nomic-embed-text'
export const SUMMARY_MODEL = process.env.OLLAMA_MODEL_SUMMARY ?? process.env.OLLAMA_MODEL ?? 'llama3.1:8b'
const CHAR_OFFSET_BACKTRACK = 240

export const VALID_EXTS    = new Set(['.md', '.txt', '.html', '.htm'])
export const KNOWN_DOMAINS = new Set(['research', 'finance', 'legal', 'comms', 'proposals'])

export { CHUNKING_VERSION, chunkDocument, chunkText }

const DOC_TYPE_MAP = {
  spec:     /spec|protocol|reference|api/i,
  guide:    /guide|tutorial|how.?to|overview|intro|getting.?started/i,
  report:   /report|analysis|summary|review/i,
  patterns: /pattern|recipe|best.?practice/i,
  note:     /note|log|diary|journal/i,
}

const GENERIC_HTML_REMOVAL_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'form',
  'button',
  'nav',
  'header',
  'footer',
  'aside',
  '[aria-hidden="true"]',
  '.visually-hidden',
  '.sr-only',
  '.hidden',
]

const WIKIPEDIA_HTML_REMOVAL_SELECTORS = [
  'table.infobox',
  'table.sidebar',
  '.infobox',
  '.sidebar',
  '.hatnote',
  '.shortdescription',
  '.mw-editsection',
  '.mw-references-wrap',
  '.reflist',
  '.reference',
  'sup.reference',
  '.navbox',
  '.vertical-navbox',
  '.metadata',
  '.authority-control',
  '.toc',
  '.thumb',
  '.gallery',
  '.sistersitebox',
  '.portal',
  '.catlinks',
  '.noprint',
]

const HTML_BACKMATTER_HEADINGS = new Set([
  'references',
  'notes',
  'bibliography',
  'further reading',
  'external links',
  'works cited',
])

const HTML_BOILERPLATE_HINTS = /(cookie|consent|newsletter|subscribe|sign-?in|sign-?up|advert|promo|banner|breadcrumb|pagination|share|social|related|recommended|outbrain|taboola)/i

export function inferDocType (filePath) {
  const name = path.basename(filePath, path.extname(filePath))
  for (const [type, re] of Object.entries(DOC_TYPE_MAP)) {
    if (re.test(name) || re.test(filePath)) return type
  }
  return 'document'
}

// ---------------------------------------------------------------------------
// Postgres (lazy singleton — shared across all ingest calls in one process)
// ---------------------------------------------------------------------------
let _pool = null
export function getPool () {
  if (!_pool) {
    _pool = new pg.Pool({
      host:     process.env.PGHOST     ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER     ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max:      3,
    })
    _pool.on('error', err => process.stderr.write(`[ingest-lib] pg error: ${err.message}\n`))
  }
  return _pool
}

export async function closePool () {
  if (_pool) { await _pool.end(); _pool = null }
}

// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------
export async function embed (text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!res.ok) throw new Error(`[embed] ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const vec = data?.embeddings?.[0] ?? data?.embedding
  if (!vec) throw new Error('[embed] no embeddings in response')
  return vec
}

export async function generateSummary (title, content) {
  const prompt = `You are a document summarizer. Write a concise 3-5 sentence summary of the following document. Focus on what the document covers, its key concepts, and its practical purpose. Do not add commentary or opinions — just describe the content.\n\nTitle: ${title}\n\nContent (first 4000 chars):\n${content.slice(0, 4000)}\n\nSummary:`
  const res = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: SUMMARY_MODEL, prompt, stream: false, options: { temperature: 0.1 } }),
  })
  if (!res.ok) throw new Error(`[summary] ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return (data.response ?? '').trim()
}

// ---------------------------------------------------------------------------
// Character-offset annotation
// ---------------------------------------------------------------------------
export function addCharOffsets (text, chunks) {
  let cursor = 0
  for (const chunk of chunks) {
    const probe = chunk.content.slice(0, 60).trim()
    if (!probe) { chunk.charStart = null; chunk.charEnd = null; continue }
    const escaped = probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
    const re = new RegExp(escaped)
    const searchFrom = Math.max(0, cursor - CHAR_OFFSET_BACKTRACK - 50)
    const m = text.slice(searchFrom).search(re)
    if (m >= 0) {
      chunk.charStart = searchFrom + m
      chunk.charEnd   = Math.min(chunk.charStart + chunk.content.length, text.length)
      cursor = chunk.charStart + Math.max(1, chunk.content.length - CHAR_OFFSET_BACKTRACK)
    } else {
      chunk.charStart = null
      chunk.charEnd   = null
    }
  }
  return chunks
}

// ---------------------------------------------------------------------------
// HTML → Markdown conversion (for .html / .htm files)
// Uses @mozilla/readability for reader-mode content extraction (strips nav,
// ads, boilerplate) then turndown for HTML-to-Markdown conversion.
// ---------------------------------------------------------------------------

function removeNodesBySelector (root, selectors = []) {
  for (const selector of selectors) {
    for (const node of root.querySelectorAll(selector)) {
      node.remove()
    }
  }
}

function stripBoilerplateNodes (root, sourceUrl = 'http://localhost/') {
  removeNodesBySelector(root, GENERIC_HTML_REMOVAL_SELECTORS)

  for (const node of root.querySelectorAll('[class], [id]')) {
    const className = typeof node.className === 'string' ? node.className : ''
    const id = typeof node.id === 'string' ? node.id : ''
    const hints = `${className} ${id}`.trim()
    if (hints && HTML_BOILERPLATE_HINTS.test(hints)) {
      node.remove()
    }
  }

  try {
    const host = new URL(sourceUrl).hostname.toLowerCase()
    if (host.includes('wikipedia.org')) {
      removeNodesBySelector(root, WIKIPEDIA_HTML_REMOVAL_SELECTORS)
    }
  } catch {}
}

function stripBackmatterSections (root) {
  for (const heading of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const headingText = `${heading.textContent ?? ''}`
      .replace(/\[edit\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()

    if (!HTML_BACKMATTER_HEADINGS.has(headingText)) continue

    let current = heading
    while (current) {
      const next = current.nextSibling
      current.remove()
      current = next
    }
    break
  }
}

function isImageOnlyLine (line) {
  const trimmed = line.trim()
  if (trimmed.startsWith('![') || trimmed.startsWith('[![')) return true

  const stripped = line
    .replace(/\[!\[[^\]]*\]\([^\)]+\)\]\([^\)]+\)/g, '')
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    .replace(/[\s|]+/g, '')
  return stripped.length === 0
}

function isShortStandaloneLinkLine (line) {
  const match = line.match(/^\s*\[([^\]]+)\]\([^\)]+\)\s*$/)
  if (!match) return false
  const label = match[1].trim()
  return label.length > 0 && label.length <= 40
}

function isRuleLine (line) {
  return /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*-{3,}\s*$/.test(line)
}

function cleanupMarkdown (markdown) {
  let cleaned = `${markdown ?? ''}`.replace(/\r\n/g, '\n')
  cleaned = cleaned
    .replace(/\[\s*\]\(#[^)]+\)/g, '')
    .replace(/\[(?:\\.|[^\]])*\]\(#(?:cite_note|cite_ref)[^)]+\)/gi, '')
    .replace(/[ \t]+\n/g, '\n')

  const lines = cleaned.split('\n')
  const filtered = []
  let previousWasDroppedImage = false

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (isImageOnlyLine(line)) {
      previousWasDroppedImage = true
      continue
    }
    if (isRuleLine(line)) continue
    if (previousWasDroppedImage && isShortStandaloneLinkLine(line)) {
      previousWasDroppedImage = false
      continue
    }
    if (line) previousWasDroppedImage = false
    filtered.push(rawLine)
  }

  return filtered.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeArticleTitle (value) {
  return `${value ?? ''}`
    .replace(/\s*[|\-]\s*Wikipedia$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Convert raw HTML to clean Markdown.
 * Falls back to full turndown conversion if readability extraction fails.
 * @param {string} rawHtml
 * @param {string} [sourceUrl]  — used by Readability for relative URL resolution
 * @returns {string}  clean Markdown
 */
export function htmlToMarkdown (rawHtml, sourceUrl = 'http://localhost/') {
  const { JSDOM }       = _require('jsdom')
  const { Readability } = _require('@mozilla/readability')
  const TurndownService = _require('turndown')

  const dom = new JSDOM(rawHtml, { url: sourceUrl })
  const doc = dom.window.document
  stripBoilerplateNodes(doc, sourceUrl)

  let contentHtml
  let articleTitle = ''
  try {
    const reader  = new Readability(doc)
    const article = reader.parse()
    articleTitle  = normalizeArticleTitle(article?.title ?? '')
    contentHtml   = article?.content ?? doc.body?.innerHTML ?? rawHtml
  } catch {
    contentHtml = doc.body?.innerHTML ?? rawHtml
  }

  if (!articleTitle) {
    articleTitle = normalizeArticleTitle(doc.querySelector('title')?.textContent ?? '')
  }

  const td = new TurndownService({
    headingStyle:     'atx',
    bulletListMarker: '-',
    codeBlockStyle:   'fenced',
  })

  const contentDom = new JSDOM(`<body>${contentHtml}</body>`, { url: sourceUrl })
  stripBoilerplateNodes(contentDom.window.document, sourceUrl)
  stripBackmatterSections(contentDom.window.document.body)

  const markdown = cleanupMarkdown(td.turndown(contentDom.window.document.body.innerHTML))
  if (!articleTitle) return markdown

  const normalizedHeading = articleTitle.toLowerCase()
  if (markdown.toLowerCase().startsWith(`# ${normalizedHeading}\n`) || markdown.toLowerCase() === `# ${normalizedHeading}`) {
    return markdown
  }

  return `# ${articleTitle}\n\n${markdown}`.trim()
}

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------
export function sha256 (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------
export async function getExistingResource (sourceRef, corpusSlug = null) {
  if (corpusSlug?.trim()) {
    const { rows } = await getPool().query(`
      SELECT r.id, r.content_hash
      FROM resources r
      JOIN corpora c ON c.id = r.corpus_id
      WHERE r.source_ref = $1
        AND (c.slug = $2 OR c.domain = $2)
      ORDER BY r.updated_at DESC
      LIMIT 1
    `, [sourceRef, corpusSlug])
    return rows[0] ?? null
  }

  const { rows } = await getPool().query(`
    SELECT id, content_hash
    FROM resources
    WHERE source_ref = $1
    ORDER BY updated_at DESC
    LIMIT 1
  `, [sourceRef])
  return rows[0] ?? null
}

export async function ensureCorpus ({ slug, displayName, resourceType = 'documents', accessMode = 'managed', schemaHint = {} }) {
  const key = slug || 'general'
  const { rows } = await getPool().query(`
    INSERT INTO corpora (domain, slug, display_name, agent_type, resource_type, dispatcher_description, scope_notes, not_in_corpus, access_mode, schema_hint, updated_at)
    VALUES ($1, $1, $2, 'documents', $3, $4, $5, '', $6, $7::jsonb, NOW())
    ON CONFLICT (domain) DO UPDATE SET
      slug = COALESCE(corpora.slug, EXCLUDED.slug),
      display_name = COALESCE(corpora.display_name, EXCLUDED.display_name),
      resource_type = COALESCE(corpora.resource_type, EXCLUDED.resource_type),
      access_mode = COALESCE(corpora.access_mode, EXCLUDED.access_mode),
      schema_hint = COALESCE(corpora.schema_hint, '{}'::jsonb) || EXCLUDED.schema_hint,
      updated_at = NOW()
    RETURNING id
  `, [
    key,
    displayName ?? key,
    resourceType,
    `Resources in corpus ${key}.`,
    `Managed resources for ${key}.`,
    accessMode,
    JSON.stringify(schemaHint ?? {}),
  ])
  return rows[0].id
}

export async function upsertResource ({ corpusSlug, type, title, sourceRef, sourceKind = 'path', contentHash, summary, summaryEmbedding, metadata, sizeBytes, mimeType, storedPath }) {
  const corpusId = await ensureCorpus({
    slug: corpusSlug,
    displayName: corpusSlug,
    resourceType: type === 'file' ? 'files' : 'documents',
  })
  const vecStr = summaryEmbedding ? `[${summaryEmbedding.join(',')}]` : null
  const { rows } = await getPool().query(`
    INSERT INTO resources
      (corpus_id, type, title, source_ref, source_kind, content_hash, summary, summary_embedding, metadata, size_bytes, mime_type, stored_path, embed_model, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (corpus_id, source_ref) DO UPDATE SET
      type = EXCLUDED.type,
      title = EXCLUDED.title,
      source_kind = EXCLUDED.source_kind,
      content_hash = EXCLUDED.content_hash,
      summary = EXCLUDED.summary,
      summary_embedding = EXCLUDED.summary_embedding,
      metadata = EXCLUDED.metadata,
      size_bytes = EXCLUDED.size_bytes,
      mime_type = EXCLUDED.mime_type,
      stored_path = EXCLUDED.stored_path,
      embed_model = EXCLUDED.embed_model,
      updated_at = NOW()
    RETURNING id
  `, [
    corpusId,
    type ?? 'document',
    title,
    sourceRef,
    sourceKind,
    contentHash ?? null,
    summary ?? null,
    vecStr,
    JSON.stringify(metadata ?? {}),
    sizeBytes ?? null,
    mimeType ?? null,
    storedPath ?? null,
    EMBED_MODEL,
  ])
  return rows[0].id
}

export async function replaceChunks (resourceId, chunks, documentId = null) {
  if (!resourceId && !documentId) {
    throw new Error('replaceChunks requires a resourceId or documentId')
  }

  if (resourceId) {
    await getPool().query('DELETE FROM chunks WHERE resource_id = $1', [resourceId])
  } else {
    await getPool().query('DELETE FROM chunks WHERE document_id = $1', [documentId])
  }

  for (const { chunkIndex, sectionHeader, sectionPath, content, embedding, charStart, charEnd } of chunks) {
    const vecStr = `[${embedding.join(',')}]`
    await getPool().query(`
      INSERT INTO chunks (document_id, resource_id, chunk_index, section_header, section_path, content, embedding, embed_model, char_start, char_end)
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10)
    `, [
      documentId ?? null,
      resourceId ?? null,
      chunkIndex,
      sectionHeader ?? null,
      Array.isArray(sectionPath) ? sectionPath : (sectionHeader ? [sectionHeader.replace(/^#{1,6}\s+/, '')] : []),
      content,
      vecStr,
      EMBED_MODEL,
      charStart ?? null,
      charEnd ?? null,
    ])
  }
}

// ---------------------------------------------------------------------------
// Artifact helpers
// ---------------------------------------------------------------------------
export function artifactStoredPath (contentHash, filename) {
  const dirKey = contentHash.slice(0, 8)
  return path.join(ARTIFACTS_ROOT, dirKey, filename)
}

export function ensureArtifactFile (srcPath, storedPath) {
  if (fs.existsSync(storedPath)) return storedPath
  fs.mkdirSync(path.dirname(storedPath), { recursive: true })
  fs.copyFileSync(srcPath, storedPath)
  return storedPath
}

export async function upsertArtifact ({ filename, mimeType, storedPath, domain, sizeBytes, corpus, description }) {
  const { rows } = await getPool().query(`
    INSERT INTO artifacts (filename, mime_type, stored_path, domain, size_bytes, corpus, description, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (stored_path) DO UPDATE SET
      domain      = EXCLUDED.domain,
      size_bytes  = EXCLUDED.size_bytes,
      corpus      = COALESCE(EXCLUDED.corpus, artifacts.corpus),
      description = COALESCE(EXCLUDED.description, artifacts.description),
      updated_at  = NOW()
    RETURNING id
  `, [filename, mimeType, storedPath, domain, sizeBytes ?? null, corpus ?? null, description ?? null])
  return rows[0].id
}

// ---------------------------------------------------------------------------
// Ingest a single file
// ---------------------------------------------------------------------------
/**
 * @param {string} filePath
 * @param {string} domain
 * @param {{ force?: boolean, noSummary?: boolean, noCopy?: boolean, corpus?: string, scopeId?: number|null, scopeSlug?: string|null, scopeDisplayName?: string|null, scopeType?: string, scopeMetadata?: object, ownerUserId?: string }} [opts]
 * @returns {Promise<{ chunks: number, skipped: boolean, reason?: string }>}
 */
export async function ingestFile (filePath, domain, {
  force = false,
  noSummary = false,
  noCopy = false,
  corpus = null,
  scopeId = null,
  scopeSlug = null,
  scopeDisplayName = null,
  scopeType = 'scope',
  scopeMetadata = {},
  ownerUserId = 'default',
} = {}) {
  const ext = path.extname(filePath).toLowerCase()
  if (!VALID_EXTS.has(ext)) {
    return { chunks: 0, skipped: false, reason: 'unsupported' }
  }

  const raw     = fs.readFileSync(filePath, 'utf8')
  const hash    = sha256(raw)
  const absPath = path.resolve(filePath)
  const corpusSlug = corpus ?? domain

  if (!force) {
    const existing = await getExistingResource(absPath, corpusSlug)
    if (existing?.content_hash === hash) {
      console.log(`[ingest] skip ${path.basename(filePath)} (unchanged)`)
      return { chunks: 0, skipped: true, reason: 'unchanged' }
    }
  }

  // For HTML files: extract reader-mode content and convert to Markdown
  const isHtml = ext === '.html' || ext === '.htm'
  const text   = isHtml ? htmlToMarkdown(raw) : raw

  const headingMatch = text.match(/^#{1,6}\s+(.+)/m)
  const filename  = path.basename(filePath)
  const title     = headingMatch?.[1]?.trim() ?? path.basename(filePath, ext)
  const docType   = inferDocType(filePath)
  const chunkPlan = chunkDocument(text, { title })
  const chunks    = addCharOffsets(text, chunkPlan.chunks)
  const sizeBytes = fs.statSync(filePath).size
  const mimeType  = isHtml ? 'text/html' : (ext === '.md' ? 'text/markdown' : 'text/plain')
  const metadata  = {
    file: filename,
    ingestedAt: new Date().toISOString(),
    chunking: chunkPlan.router,
    ...(isHtml ? { htmlConverted: true } : {}),
  }

  console.log(`[ingest] ${filename} → corpus=${corpusSlug} type=${docType} shape=${chunkPlan.router.shape} ${chunks.length} chunk(s)`)

  const embeddedChunks = []
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} [${chunks[i].sectionHeader ?? 'no heading'}] embedding...`)
    const embedding = await embed(chunks[i].embeddingText ?? chunks[i].content)
    embeddedChunks.push({
      chunkIndex: i,
      sectionHeader: chunks[i].sectionHeader,
      sectionPath: chunks[i].sectionPath ?? [],
      content: chunks[i].content,
      embedding, charStart: chunks[i].charStart ?? null, charEnd: chunks[i].charEnd ?? null,
    })
    process.stdout.write(' ok\n')
  }

  let summary = null
  let summaryEmbedding = null
  if (noSummary) {
    summary = title
    summaryEmbedding = await embed(title)
  } else {
    process.stdout.write(`  summary (${SUMMARY_MODEL})...`)
    try {
      summary = await generateSummary(title, text)
      summaryEmbedding = await embed(summary)
      process.stdout.write(' ok\n')
    } catch (err) {
      process.stdout.write(` failed (${err.message})\n`)
      summary = title
      try { summaryEmbedding = await embed(title) } catch {}
    }
  }

  let artifactId = null
  let managedStoredPath = null
  if (!noCopy) {
    try {
      managedStoredPath = artifactStoredPath(hash, filename)
      ensureArtifactFile(absPath, managedStoredPath)
      artifactId = await upsertArtifact({ filename, mimeType, storedPath: managedStoredPath, domain, sizeBytes, corpus, description: summary ?? title })
      console.log(`  -> artifact_id=${artifactId} stored_path=${path.relative(process.cwd(), managedStoredPath)}`)
    } catch (err) {
      console.warn(`  [artifact] copy failed: ${err.message} — continuing without managed copy`)
    }
  }

  const resourceId = await upsertResource({
    corpusSlug,
    type: docType,
    title,
    sourceRef: absPath,
    sourceKind: 'path',
    contentHash: hash,
    summary,
    summaryEmbedding,
    metadata: {
      ...metadata,
      ...(artifactId ? { artifact_id: artifactId } : {}),
      corpus: corpusSlug,
      chunking_version: CHUNKING_VERSION,
    },
    sizeBytes,
    mimeType,
    storedPath: managedStoredPath,
  })
  await replaceChunks(resourceId, embeddedChunks)

  let linkedScopeId = scopeId
  if (`${scopeSlug ?? ''}`.trim()) {
    const scope = await upsertScope({
      slug: scopeSlug,
      displayName: scopeDisplayName ?? scopeSlug,
      ownerUserId,
      scopeType,
      metadata: scopeMetadata,
    })
    linkedScopeId = scope.id
  }
  if (linkedScopeId != null) {
    await attachResourceToScope({
      resourceId,
      scopeId: linkedScopeId,
      isPrimary: true,
      metadata: {
        ingested_via: 'ingestFile',
        corpus: corpusSlug,
      },
    })
  }

  console.log(`  -> resource_id=${resourceId} stored${linkedScopeId != null ? ` scope_id=${linkedScopeId}` : ''}`)
  return { chunks: embeddedChunks.length, skipped: false, scopeId: linkedScopeId ?? null }
}

// ---------------------------------------------------------------------------
// Collect files from a directory tree
// ---------------------------------------------------------------------------
export function collectFiles (dirPath, defaultDomain) {
  const results = []
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      const subDomain = KNOWN_DOMAINS.has(entry.name) ? entry.name : defaultDomain
      results.push(...collectFiles(full, subDomain))
    } else if (entry.isFile()) {
      if (VALID_EXTS.has(path.extname(entry.name).toLowerCase())) {
        results.push({ filePath: full, domain: defaultDomain })
      }
    }
  }
  return results
}
