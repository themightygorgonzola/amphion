/**
 * agents/knowledge/index.js — Universal Resource Agent
 *
 * Resource is Amphion's first-class knowledge unit. Corpora are typed
 * collections of resources. Chunks are only an indexing implementation detail.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { BaseAgent } from '../_base/index.js'
import { searchResourceSummaries } from '../_shared/resource-retrieval.js'
import { applyScopeExperienceBoosts, getScopeExperienceBoosts } from '../../apps/broker/src/scope-experience.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AMPHION_ROOT = path.resolve(__dirname, '../..')
const SQLITE_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.resolve(AMPHION_ROOT, 'data', 'memory.db')

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434'
const EMBED_MODEL = process.env.OLLAMA_MODEL_EMBED ?? 'nomic-embed-text'
const { Pool } = pg

let _pool = null
function getPool () {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PGHOST ?? 'localhost',
      port:     parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'amphion',
      user:     process.env.PGUSER ?? 'amphion',
      password: process.env.PGPASSWORD ?? 'changeme',
      max:      5,
    })
    _pool.on('error', err => process.stderr.write(`[knowledge] pg error: ${err.message}\n`))
  }
  return _pool
}

let _sqlite = null
function getSqlite () {
  if (!_sqlite) _sqlite = new DatabaseSync(SQLITE_PATH)
  return _sqlite
}

async function embed (text) {
  const res = await fetch(`${OLLAMA_HOST}/api/embed`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model: EMBED_MODEL, input: text }),
  })
  if (!res.ok) throw new Error(`[embed] ${res.status}`)
  const data = await res.json()
  const vec = data?.embeddings?.[0] ?? data?.embedding
  if (!vec) throw new Error('[embed] no vector returned')
  return vec
}

function rrfMerge (semanticRows, keywordRows, keyField = 'chunk_id', k = 60) {
  const scores = new Map()
  const add = rows => rows.forEach((row, i) => {
    const key = String(row[keyField] ?? row.id ?? `${row.resource_id}:${row.chunk_index}`)
    if (!scores.has(key)) scores.set(key, { row, rrf: 0 })
    scores.get(key).rrf += 1 / (k + i + 1)
  })
  add(semanticRows)
  add(keywordRows)
  return [...scores.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .map(({ row, rrf }) => ({ ...row, rrf_score: rrf }))
}

function expandTopic (topic) {
  const text = `${topic ?? ''}`.trim()
  if (/\b(dui|dwi)\b/i.test(text)) {
    return `${text} driving under the influence physical control RCW 46.61.502 RCW 46.61.504 RCW 46.61.5055 penalties imprisonment fine sentence`
  }
  const equivalentPhrases = queryEquivalentPhrases(text)
  if (equivalentPhrases.length > 0) return `${text} ${equivalentPhrases.join(' ')}`
  return text
}

function rerankRows (topic, rows, options = {}) {
  const topicalTerms = topicKeywordVariants(topic)
  const topicalPhrases = topicPhraseVariants(topic)
  const exactSections = extractExactSections(topic).map(section => section.toLowerCase())
  const normalizedTopic = `${topic ?? ''}`.toLowerCase()
  const isDui = /\b(dui|dwi|driving under the influence)\b/i.test(topic)
  const isDefinition = !options.allowConversationPriority && isDefinitionQuery(topic)
  if (!isDui && !isDefinition && topicalTerms.length === 0 && topicalPhrases.length === 0 && exactSections.length === 0) return rows

  const subjectTerms = isDefinition ? definitionSubjectTerms(topic) : []

  return rows
    .map(row => {
      const haystack = `${row.section_path?.join(' ') ?? ''} ${row.section_header ?? ''} ${row.title ?? ''} ${row.content ?? ''}`.toLowerCase()
      const content = `${row.content ?? ''}`.toLowerCase()
      const title = `${row.title ?? ''}`.toLowerCase()
      const section = `${row.section_header ?? ''} ${row.section_path?.join(' ') ?? ''}`.toLowerCase()
      const sourceRef = `${row.source_ref ?? row.stored_path ?? ''}`.toLowerCase()
      const baseScore = Number(Number(row.rrf_score ?? 0).toFixed(4))
      const scoreBreakdown = [{ signal: 'base_rrf', value: baseScore }]
      let boost = 0
      const addBoost = (signal, value, details = null) => {
        if (!value) return
        const roundedValue = Number(value.toFixed(4))
        boost += roundedValue
        scoreBreakdown.push(details ? { signal, value: roundedValue, ...details } : { signal, value: roundedValue })
      }
      const termHits = topicalTerms.filter(term => hasBoundedTextMatch(haystack, term))
      const titleHitCount = topicalTerms.filter(term => hasBoundedTextMatch(title, term)).length
      const sectionHitCount = topicalTerms.filter(term => hasBoundedTextMatch(section, term)).length
      const phraseHits = topicalPhrases.filter(phrase => hasBoundedTextMatch(haystack, phrase))
      const titlePhraseHitCount = topicalPhrases.filter(phrase => hasBoundedTextMatch(title, phrase)).length
      const sectionPhraseHitCount = topicalPhrases.filter(phrase => hasBoundedTextMatch(section, phrase)).length
      const exactSectionHits = exactSections.filter(sectionId => title.includes(sectionId) || section.includes(sectionId) || content.includes(sectionId))
      const termCoverage = topicalTerms.length > 0 ? termHits.length / topicalTerms.length : 0

      if (termHits.length > 0) addBoost('term_hits', Math.min(0.28, termHits.length * 0.05), { count: termHits.length })
      if (titleHitCount > 0) addBoost('title_term_hits', Math.min(0.18, titleHitCount * 0.08), { count: titleHitCount })
      if (sectionHitCount > 0) addBoost('section_term_hits', Math.min(0.12, sectionHitCount * 0.06), { count: sectionHitCount })
      if (phraseHits.length > 0) addBoost('phrase_hits', Math.min(0.2, phraseHits.length * 0.07), { matches: phraseHits.slice(0, 2) })
      if (titlePhraseHitCount > 0) addBoost('title_phrase_hits', Math.min(0.16, titlePhraseHitCount * 0.09), { count: titlePhraseHitCount })
      if (sectionPhraseHitCount > 0) addBoost('section_phrase_hits', Math.min(0.14, sectionPhraseHitCount * 0.08), { count: sectionPhraseHitCount })
      if (exactSectionHits.length > 0) addBoost('exact_section_hits', Math.min(0.18, exactSectionHits.length * 0.09), { matches: exactSectionHits.slice(0, 2) })
      if (termCoverage >= 0.6) addBoost('topic_coverage', Math.min(0.1, termCoverage * 0.08), { coverage: Number(termCoverage.toFixed(2)) })
      if (/(\bstats?\b|\bstatistics\b|\bdata\b)/.test(normalizedTopic) && /\b\d{2,}\b/.test(content)) addBoost('numeric_support', 0.08)
      if (/\bhistory\b/.test(normalizedTopic) && /\b(history|historical|century|era|war|treaty|act)\b/.test(haystack)) addBoost('historical_support', 0.05)
      if (/^source:\s/.test(content.trim()) && termHits.length === 0 && phraseHits.length === 0) addBoost('source_only_penalty', -0.2)
      if (content.trim().length < 120 && termHits.length < 2 && phraseHits.length === 0) addBoost('short_content_penalty', -0.08)

      if (isDui && haystack.includes('46.61.5055')) addBoost('dui_reference_5055', 0.12)
      if (isDui && haystack.includes('46.61.502')) addBoost('dui_reference_502', 0.08)
      if (isDui && haystack.includes('46.61.504')) addBoost('dui_reference_504', 0.06)
      if (isDui && /penalt|imprison|jail|fine|sentence/.test(haystack)) addBoost('penalty_terms', 0.03)
      if (isDefinition) {
        if (isConversationCorpus(row)) addBoost('conversation_definition_penalty', -0.25)
        if (/\breadme\b|\boverview\b|\babout\b|\bintroduction\b/.test(`${row.title ?? ''} ${sourceRef}`.toLowerCase())) addBoost('overview_definition_support', 0.12)
        if (hasClearDefinitionSupport(haystack, subjectTerms)) addBoost('clear_definition_support', 0.14)
        if (looksLikePathOnlyMatch(sourceRef, haystack, subjectTerms)) addBoost('path_only_definition_penalty', -0.14)
      }
      return {
        ...row,
        rrf_score: Number(((row.rrf_score ?? 0) + boost).toFixed(6)),
        score_breakdown: scoreBreakdown,
      }
    })
    .sort((a, b) => (b.rrf_score ?? 0) - (a.rrf_score ?? 0))
}

function topicKeywordVariants (topic) {
  const aliases = {
    stats: ['stats', 'statistics', 'statistical'],
    history: ['history', 'historical'],
    reservation: ['reservation', 'reservations'],
    reservations: ['reservation', 'reservations'],
    tribe: ['tribe', 'tribes', 'tribal'],
    tribes: ['tribe', 'tribes', 'tribal'],
  }

  const terms = keywords(topic)
    .filter(term => !['some', 'little'].includes(term))
    .flatMap(term => aliases[term] ?? [term])

  return [...new Set(terms)]
}

function topicPhraseVariants (topic) {
  const words = `${topic ?? ''}`
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map(word => word.trim())
    .filter(Boolean)

  const phrases = []

  for (let start = 0; start < words.length; start += 1) {
    for (let size = 2; size <= 4 && (start + size) <= words.length; size += 1) {
      const slice = words.slice(start, start + size)
      if (STOP_WORDS.has(slice[0]) || STOP_WORDS.has(slice.at(-1))) continue
      const contentTerms = slice.filter(word => word.length >= 3 && !STOP_WORDS.has(word) && !LOW_SIGNAL_QUERY_TERMS.has(word))
      if (contentTerms.length < 2) continue
      phrases.push(slice.join(' '))
    }
  }

  phrases.push(...queryEquivalentPhrases(topic))

  return [...new Set(phrases)].slice(0, 8)
}

function hasBoundedTextMatch (text, needle) {
  const source = `${text ?? ''}`.toLowerCase()
  const target = `${needle ?? ''}`.toLowerCase().trim()
  if (!source || !target) return false

  const escaped = target
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')

  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(source)
}

function queryEquivalentPhrases (topic) {
  const text = `${topic ?? ''}`.toLowerCase()
  const equivalents = []

  if (hasBoundedTextMatch(text, 'revolutionary war')) equivalents.push('american revolution')
  if (hasBoundedTextMatch(text, 'iraq invasion') || hasBoundedTextMatch(text, 'invasion of iraq')) equivalents.push('iraq war')

  return equivalents
}

function isDefinitionQuery (topic) {
  return /\b(what is|who is|define|definition of|what does .+ mean|what does .+ refer to)\b/i.test(`${topic ?? ''}`)
}

function definitionSubjectTerms (topic) {
  const text = `${topic ?? ''}`.toLowerCase()
  const subject = text.match(/\b(?:what is|who is|define|definition of|what does)\s+(.+?)(?:\?|$)/i)?.[1] ?? text
  return subject
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !STOP_WORDS.has(term))
    .slice(0, 6)
}

function isConversationCorpus (row) {
  return /conversation/i.test(`${row.corpus ?? ''}`)
}

function hasClearDefinitionSupport (haystack, subjectTerms) {
  const mentionsSubject = subjectTerms.length === 0 || subjectTerms.some(term => haystack.includes(term))
  if (!mentionsSubject) return false
  return /\b(is|are|refers to|serves as|acts as|means)\b/.test(haystack.slice(0, 260))
}

function looksLikePathOnlyMatch (sourceRef, haystack, subjectTerms) {
  if (!sourceRef) return false
  if (/\breadme\b|\boverview\b|\babout\b|\bintroduction\b/.test(sourceRef)) return false
  if (!/^[a-z]:\\|\//.test(sourceRef) && !sourceRef.includes('amphion')) return false
  const mentionsSubject = subjectTerms.length === 0 || subjectTerms.some(term => haystack.includes(term))
  return !mentionsSubject
}

function searchRoots () {
  const raw = process.env.SEARCH_ROOTS ?? 'C:\\MySoftwareFolder,C:\\Users\\dawso\\Documents,C:\\Users\\dawso\\Desktop'
  return raw.split(',').map(r => r.trim()).filter(Boolean).map(r => path.resolve(r)).filter(r => fs.existsSync(r))
}

function isPathLike (value) {
  const text = `${value ?? ''}`
  return /^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('fs:')
}

function fsId (filePath) {
  return `fs:${path.resolve(filePath)}`
}

function fromFsId (resourceId) {
  const value = `${resourceId ?? ''}`
  return value.startsWith('fs:') ? path.resolve(value.slice(3)) : null
}

function isFilesystemQuery (query, type) {
  return isPathLike(query) || /\b(file|folder|directory|script|scripts|repo|workspace|path)\b/i.test(query) || /\b(file|folder|directory)\b/i.test(type ?? '')
}

function isLikelyTextFile (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.txt', '.sql', '.ps1', '.sh', '.yml', '.yaml', '.html', '.css'].includes(ext)
}

const STOP_WORDS = new Set([
  'what','when','where','which','who','how','did','was','were','the','a','an',
  'and','or','in','on','of','to','for','from','with','without','by','at','as',
  'we','i','you','he','she','they','our','my','your','his','her','their','about',
  'regarding','related','tell','said','talked','spoke','discussed','mentioned',
  'think','remember','recall','find','get','search','look','show','conversation',
  'conversations','something','anything','topic','topics','information','info',
  'context','history','past','previous','had','has','have','been','this','that',
  'hey','can','could','would','please','just','right','ok','okay',
])

const LOW_SIGNAL_QUERY_TERMS = new Set(['some', 'little', 'bit', 'more', 'less', 'hey', 'can', 'could', 'would', 'please', 'just', 'right', 'ok', 'okay'])

function keywords (topic) {
  return `${topic ?? ''}`
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w) && !LOW_SIGNAL_QUERY_TERMS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i)
    .slice(0, 8)
}

function keywordPatterns (topic) {
  return keywords(topic)
    .slice(0, 6)
    .map(term => `%${term}%`)
}

function keywordTsQuery (topic) {
  const terms = keywords(topic)
    .slice(0, 6)
    .map(term => term.replace(/[^a-z0-9]/gi, ''))
    .filter(Boolean)

  if (terms.length === 0) return null
  return terms.map(term => `${term}:*`).join(' | ')
}

function wantsConversationRecall (topic, corpus) {
  return corpus === 'conversations' || /\b(remember|recall|talked|discussed|conversation|last time|previously|earlier|what did (we|i|you))\b/i.test(topic)
}

function conversationDateRange (topic) {
  const text = `${topic ?? ''}`.toLowerCase()
  const now = new Date()
  const start = new Date(now)
  if (/\b(this week|last week|past week|week)\b/.test(text)) start.setDate(now.getDate() - 7)
  else if (/\b(today)\b/.test(text)) start.setHours(0, 0, 0, 0)
  else if (/\b(yesterday)\b/.test(text)) { start.setDate(now.getDate() - 1); start.setHours(0, 0, 0, 0); now.setHours(0, 0, 0, 0) }
  else if (/\b(this month|last month|past month|month)\b/.test(text)) start.setMonth(now.getMonth() - 1)
  else if (/\brecent\b/.test(text)) start.setDate(now.getDate() - 3)
  else return null
  return { from: start.toISOString(), to: now.toISOString() }
}

function extractExactSections (topic) {
  const text = `${topic ?? ''}`
  const matches = [...text.matchAll(/(?:\bRCW\s+)?(\d+[A-Z]?\.\d+\.\d+[A-Z]?)\b/gi)]
    .map(match => match[1])
  return [...new Set(matches)]
}

function normalizeActiveScope (scope, context = {}) {
  const normalized = `${scope ?? context?.activeScope ?? context?.workspaceId ?? ''}`.trim()
  return normalized || null
}

function buildKnowledgeFilters ({ corpus = null, scope = null } = {}, startIndex = 1, aliases = { corpus: 'co', resource: 'r' }) {
  const clauses = []
  const values = []
  let idx = startIndex

  if (`${corpus ?? ''}`.trim()) {
    clauses.push(`(${aliases.corpus}.slug = $${idx} OR ${aliases.corpus}.domain = $${idx})`)
    values.push(corpus)
    idx += 1
  }

  const normalizedScope = normalizeActiveScope(scope)
  if (normalizedScope) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM resource_workspaces rw
      JOIN workspaces ws ON ws.id = rw.workspace_id
      WHERE rw.resource_id = ${aliases.resource}.id
        AND (ws.slug = $${idx} OR ws.id::text = $${idx})
    )`)
    values.push(normalizedScope)
    idx += 1
  }

  return { clauses, values, nextIndex: idx }
}

function mergeUniqueRows (preferredRows, fallbackRows, keyFn) {
  const seen = new Set()
  const merged = []

  const add = rows => {
    for (const row of rows) {
      const key = keyFn(row)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(row)
    }
  }

  add(preferredRows)
  add(fallbackRows)
  return merged
}

async function exactSectionRows (pool, topic, corpus, k, scope = null) {
  let sections = extractExactSections(topic)
  if (sections.length === 0 && /\b(dui|dwi|driving under the influence)\b/i.test(topic)) {
    sections = ['46.61.5055', '46.61.502', '46.61.504']
  }
  if (sections.length === 0) return []

  const values = sections.map((_, i) => `($${i + 1}::text, ${i + 1})`).join(', ')
  const filters = buildKnowledgeFilters({ corpus, scope }, sections.length + 1)
  const filterClause = filters.clauses.length ? ` AND ${filters.clauses.join(' AND ')}` : ''
  const params = [...sections, ...filters.values, k * 2]
  const limitParam = params.length

  const { rows } = await pool.query(`
    WITH wanted(section, rank) AS (VALUES ${values})
    SELECT ch.id AS chunk_id, ch.resource_id, ch.chunk_index,
           COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
           ch.section_header, ch.content, ch.start_line, ch.end_line, ch.char_start, ch.char_end,
           r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type,
           co.slug AS corpus, co.display_name AS corpus_name,
           (1.0 / wanted.rank)::float AS score
    FROM wanted
    JOIN chunks ch ON (
      ch.section_path @> ARRAY[wanted.section]::text[]
      OR ch.section_header ILIKE '%' || wanted.section || '%'
      OR ch.content ILIKE 'RCW ' || wanted.section || '%'
    )
    JOIN resources r ON r.id = ch.resource_id
    LEFT JOIN corpora co ON co.id = r.corpus_id
    WHERE true${filterClause}
    ORDER BY wanted.rank, ch.chunk_index
    LIMIT $${limitParam}
  `, params)
  return rows
}

async function summaryExcerptRows (pool, topic, corpus, k, scope = null) {
  const resources = await searchResourceSummaries({ query: topic, corpus, scope, k })
  if (resources.length === 0) return []

  const resourceIds = resources
    .map(resource => parseInt(resource.resource_id, 10))
    .filter(id => Number.isInteger(id) && id > 0)

  if (resourceIds.length === 0) return []

  const { rows } = await pool.query(`
    SELECT DISTINCT ON (r.id)
           ch.id AS chunk_id, ch.resource_id, ch.chunk_index,
           COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
           ch.section_header, ch.content, ch.start_line, ch.end_line, ch.char_start, ch.char_end,
           r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type,
           co.slug AS corpus, co.display_name AS corpus_name
    FROM resources r
    LEFT JOIN chunks ch ON ch.resource_id = r.id
    LEFT JOIN corpora co ON co.id = r.corpus_id
    WHERE r.id = ANY($1)
    ORDER BY r.id, ch.chunk_index ASC NULLS LAST
  `, [resourceIds])

  const chunkByResourceId = new Map(rows.map(row => [String(row.resource_id), row]))

  return resources.map(resource => {
    const chunkRow = chunkByResourceId.get(String(resource.resource_id))
    if (chunkRow) return chunkRow

    return {
      chunk_id:      `summary:${resource.resource_id}`,
      resource_id:   resource.resource_id,
      chunk_index:   0,
      section_path:  [],
      section_header: null,
      content:       resource.summary ?? resource.title ?? '',
      start_line:    null,
      end_line:      null,
      char_start:    null,
      char_end:      null,
      title:         resource.title,
      resource_type: resource.resource_type,
      source_ref:    resource.source_ref,
      stored_path:   resource.stored_path,
      mime_type:     resource.mime_type,
      corpus:        resource.corpus,
      corpus_name:   resource.corpus_name,
    }
  })
}

async function exactSectionResources (pool, topic, corpus, k, scope = null) {
  const sections = extractExactSections(topic)
  if (sections.length === 0) return []

  const values = sections.map((_, i) => `($${i + 1}::text, ${i + 1})`).join(', ')
  const filters = buildKnowledgeFilters({ corpus, scope }, sections.length + 1)
  const filterClause = filters.clauses.length ? ` AND ${filters.clauses.join(' AND ')}` : ''
  const params = [...sections, ...filters.values, k]
  const limitParam = params.length

  const { rows } = await pool.query(`
    WITH wanted(section, rank) AS (VALUES ${values})
    SELECT DISTINCT ON (r.id)
           r.id,
           r.title,
           r.type,
           r.source_ref,
           r.source_kind,
           r.summary,
           r.mime_type,
           r.size_bytes,
           r.stored_path,
           r.metadata,
           co.slug AS corpus,
           co.display_name AS corpus_name,
           r.updated_at,
           wanted.rank,
           ch.chunk_index
    FROM wanted
    JOIN chunks ch ON (
      ch.section_path @> ARRAY[wanted.section]::text[]
      OR ch.section_header ILIKE '%' || wanted.section || '%'
      OR ch.content ILIKE 'RCW ' || wanted.section || '%'
    )
    JOIN resources r ON r.id = ch.resource_id
    LEFT JOIN corpora co ON co.id = r.corpus_id
    WHERE true${filterClause}
    ORDER BY r.id, wanted.rank, ch.chunk_index
    LIMIT $${limitParam}
  `, params)

  return rows.map(r => ({
    resource_id: String(r.id),
    title:       r.title,
    type:        r.type,
    corpus:      r.corpus,
    source_ref:  r.source_ref,
    source_kind: r.source_kind,
    summary:     r.summary,
    mime_type:   r.mime_type,
    size_bytes:  r.size_bytes,
    stored_path: r.stored_path,
    external:    false,
    updated_at:  r.updated_at,
  }))
}

function conversationRowToResult (row) {
  return {
    chunk_id:      `conversation:${row.id}`,
    resource_id:   `conversation:${row.id}`,
    chunk_index:   0,
    title:         `Conversation ${row.session_id}`,
    corpus:        'conversations',
    resource_type: 'conversation',
    source_ref:    row.session_id,
    section_path:  [row.created_at, row.role],
    content:       `${row.role} (${row.created_at}): ${row.content}`,
    rrf_score:     0.02,
    is_neighbor:   false,
  }
}

class KnowledgeAgent extends BaseAgent {
  get name () { return 'knowledge' }
  get description () { return 'Universal resource retrieval over corpora, conversations, and reachable external resources' }

  get tools () {
    return [
      {
        name: 'recall',
        description: 'Find relevant resource excerpts for a topic across all corpora. Use when you need to inform yourself about a subject.',
        inputSchema: {
          type: 'object',
          properties: {
            topic:  { type: 'string', description: 'What topic or question needs evidence' },
            corpus: { type: 'string', description: 'Optional corpus key, e.g. legal, research, conversations' },
            k:      { type: 'integer', description: 'Number of excerpts to return (default 8, max 20)' },
          },
          required: ['topic'],
        },
      },
      {
        name: 'find',
        description: 'Locate resources by name, title, filename, path, or subject label. Returns resource_id values you can pass to load.',
        inputSchema: {
          type: 'object',
          properties: {
            name:   { type: 'string', description: 'Name, title, filename, path, or partial label to locate' },
            type:   { type: 'string', description: 'Optional resource type filter: file, directory, document, conversation' },
            corpus: { type: 'string', description: 'Optional corpus key' },
            k:      { type: 'integer', description: 'Max resources to return (default 12, max 50)' },
          },
          required: ['name'],
        },
      },
      {
        name: 'load',
        description: 'Load a resource by resource_id. Works for database resources and external fs: paths returned by find.',
        inputSchema: {
          type: 'object',
          properties: {
            resource_id: { type: 'string', description: 'Resource ID from recall/find, including fs:C:\\path external IDs' },
            max_chars:   { type: 'integer', description: 'Max characters for file-like resources (default 12000)' },
          },
          required: ['resource_id'],
        },
      },
      {
        name: 'reflect',
        description: 'Ask whether the gathered information is sufficient. The broker answers this from the current observations.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
  }

  async callTool (toolName, args, context = {}) {
    switch (toolName) {
      case 'recall':  return this._recall(args, context)
      case 'find':    return this._find(args, context)
      case 'load':    return this._load(args)
      case 'reflect': return this._reflect(args)
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  async _collectRecallRows ({ query, expandedQuery, corpus, k, scope = null, wantsConversations = false }) {
    const pool = getPool()
    const vector = await embed(expandedQuery)
    const vec = `[${vector.join(',')}]`
    const filters = buildKnowledgeFilters({ corpus, scope }, 2)
    const filterClause = filters.clauses.length ? ` AND ${filters.clauses.join(' AND ')}` : ''

    const semParams = [vec, ...filters.values, k * 3]
    const semLimitParam = semParams.length
    const { rows: semRows } = await pool.query(`
      SELECT ch.id AS chunk_id, ch.resource_id, ch.chunk_index,
             COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
             ch.section_header, ch.content, ch.start_line, ch.end_line, ch.char_start, ch.char_end,
             r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type,
             co.slug AS corpus, co.display_name AS corpus_name,
             1 - (ch.embedding <=> $1::vector) AS score
      FROM chunks ch
      JOIN resources r ON r.id = ch.resource_id
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE ch.embedding IS NOT NULL${filterClause}
      ORDER BY ch.embedding <=> $1::vector
      LIMIT $${semLimitParam}
    `, semParams)

    const exactRows = await exactSectionRows(pool, query, corpus, k, scope)
    const summaryRows = await summaryExcerptRows(pool, query, corpus, k, scope)

    const tsQuery = keywordTsQuery(expandedQuery)
    const likePatterns = keywordPatterns(expandedQuery)
    let kwRows = []

    if (tsQuery || likePatterns.length > 0) {
      const kwParams = []
      let nextParam = 1
      const lexicalPredicates = []
      const scoreTerms = []

      if (tsQuery) {
        kwParams.push(tsQuery)
        lexicalPredicates.push(`ch.content_tsv @@ to_tsquery('english', $${nextParam})`)
        scoreTerms.push(`COALESCE(ts_rank(ch.content_tsv, to_tsquery('english', $${nextParam})), 0)`)
        nextParam += 1
      }

      if (likePatterns.length > 0) {
        kwParams.push(likePatterns)
        lexicalPredicates.push(`COALESCE(r.title, '') ILIKE ANY($${nextParam}::text[])`)
        lexicalPredicates.push(`COALESCE(ch.section_header, '') ILIKE ANY($${nextParam}::text[])`)
        lexicalPredicates.push(`COALESCE(ch.content, '') ILIKE ANY($${nextParam}::text[])`)
        lexicalPredicates.push(`COALESCE(r.source_ref, '') ILIKE ANY($${nextParam}::text[])`)
        scoreTerms.push(`CASE WHEN COALESCE(r.title, '') ILIKE ANY($${nextParam}::text[]) THEN 0.35 ELSE 0 END`)
        scoreTerms.push(`CASE WHEN COALESCE(ch.section_header, '') ILIKE ANY($${nextParam}::text[]) THEN 0.2 ELSE 0 END`)
        scoreTerms.push(`CASE WHEN COALESCE(ch.content, '') ILIKE ANY($${nextParam}::text[]) THEN 0.05 ELSE 0 END`)
        nextParam += 1
      }

      // Build a fresh filter with the correct startIndex for the kw query — after tsQuery and
      // likePatterns have been pushed, nextParam reflects their actual positions so corpus/scope
      // clauses reference the right $N instead of the likePatterns array at $2.
      const kwFilters = buildKnowledgeFilters({ corpus, scope }, nextParam)
      const kwFilterClause = kwFilters.clauses.length ? ` AND ${kwFilters.clauses.join(' AND ')}` : ''
      const kwLimitParam = nextParam + kwFilters.values.length
      kwParams.push(...kwFilters.values, k * 3)

      const { rows } = await pool.query(`
        SELECT ch.id AS chunk_id, ch.resource_id, ch.chunk_index,
               COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
               ch.section_header, ch.content, ch.start_line, ch.end_line, ch.char_start, ch.char_end,
               r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type,
               co.slug AS corpus, co.display_name AS corpus_name,
               ${scoreTerms.join(' + ')} AS score
        FROM chunks ch
        JOIN resources r ON r.id = ch.resource_id
        LEFT JOIN corpora co ON co.id = r.corpus_id
        WHERE (${lexicalPredicates.join(' OR ')})${kwFilterClause}
        ORDER BY score DESC
        LIMIT $${kwLimitParam}
      `, kwParams)
      kwRows = rows
    }

    let merged = rrfMerge([...exactRows, ...summaryRows, ...semRows], kwRows)
    if (scope) {
      const boosts = await getScopeExperienceBoosts({
        scope,
        resourceIds: merged.map(row => row.resource_id),
      })
      merged = applyScopeExperienceBoosts(merged, boosts)
    }

    merged = rerankRows(query, merged, {
      allowConversationPriority: wantsConversations,
    }).slice(0, k)

    if (merged.length > 0) {
      const neighborKeys = new Set(merged.map(r => `${r.resource_id}:${r.chunk_index}`))
      const neighborIds = []
      for (const row of merged) {
        for (const offset of [-1, 1]) {
          const idx = row.chunk_index + offset
          const key = `${row.resource_id}:${idx}`
          if (idx >= 0 && !neighborKeys.has(key)) {
            neighborIds.push({ resourceId: row.resource_id, chunkIndex: idx })
            neighborKeys.add(key)
          }
        }
      }
      if (neighborIds.length > 0) {
        const placeholders = neighborIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
        const params = neighborIds.flatMap(n => [n.resourceId, n.chunkIndex])
        const { rows } = await pool.query(`
          SELECT ch.id AS chunk_id, ch.resource_id, ch.chunk_index,
                 COALESCE(ch.section_path, CASE WHEN ch.section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[ch.section_header] END) AS section_path,
                 ch.section_header, ch.content, ch.start_line, ch.end_line, ch.char_start, ch.char_end,
                 r.title, r.type AS resource_type, r.source_ref, r.stored_path, r.mime_type,
                 co.slug AS corpus, co.display_name AS corpus_name,
                 0::float AS score
          FROM chunks ch
          JOIN resources r ON r.id = ch.resource_id
          LEFT JOIN corpora co ON co.id = r.corpus_id
          WHERE (ch.resource_id, ch.chunk_index) IN (${placeholders})
          ORDER BY ch.resource_id, ch.chunk_index
        `, params)
        merged = [...merged, ...rows.map(r => ({ ...r, rrf_score: 0, is_neighbor: true }))]
      }
    }

    return merged
  }

  async _recall ({ topic, corpus, k = 8, scope = null }, context = {}) {
    const query = `${topic ?? ''}`.trim()
    const expandedQuery = expandTopic(query)
    const activeScope = normalizeActiveScope(scope, context)
    k = Math.min(Math.max(1, k ?? 8), 20)
    this.log(`recall: "${query.slice(0, 80)}" corpus=${corpus ?? 'all'} scope=${activeScope ?? 'all'} k=${k}`)
    const wantsConversations = wantsConversationRecall(query, corpus)

    let merged = await this._collectRecallRows({ query, expandedQuery, corpus, k, scope: activeScope, wantsConversations })
    const scopedPrimaryCount = activeScope ? merged.filter(row => !row.is_neighbor).length : k
    if (activeScope && scopedPrimaryCount === 0) {
      const fallbackRows = await this._collectRecallRows({ query, expandedQuery, corpus, k, scope: null, wantsConversations })
      merged = mergeUniqueRows(merged, fallbackRows, row => `${row.chunk_id ?? `${row.resource_id}:${row.chunk_index}`}`)
    }

    const conversationResults = wantsConversations
      ? this._recallConversations(query, Math.max(20, k), activeScope)
      : []

    const orderedRows = wantsConversations && conversationResults.length > 0
      ? [...conversationResults, ...merged]
      : [...merged, ...conversationResults]

    const resultLimit = wantsConversations ? Math.max(k, conversationResults.length) : k
    const primaryRows = orderedRows.filter(row => !row.is_neighbor)
    const neighborRows = orderedRows.filter(row => row.is_neighbor)
    const selectedRows = [...primaryRows.slice(0, resultLimit), ...neighborRows.slice(0, Math.min(k, neighborRows.length))]
    const results = selectedRows.map(row => ({
      chunk_id:       row.chunk_id,
      resource_id:    row.resource_id,
      doc_id:         row.resource_id,
      chunk_index:    row.chunk_index ?? 0,
      title:          row.title,
      domain:         row.corpus,
      corpus:         row.corpus,
      resource_type:  row.resource_type,
      source_ref:     row.source_ref,
      source_path:    row.source_ref,
      section_path:   row.section_path ?? [],
      section_header: row.section_header ?? (row.section_path?.join(' > ') || null),
      rrf_score:      parseFloat(row.rrf_score?.toFixed?.(4) ?? row.rrf_score ?? 0),
      score_breakdown: row.score_breakdown ?? null,
      scope_experience_boost: parseFloat(row.scope_experience_boost?.toFixed?.(4) ?? row.scope_experience_boost ?? 0),
      is_neighbor:    row.is_neighbor ?? false,
      content:        row.content,
      start_line:     row.start_line ?? null,
      end_line:       row.end_line ?? null,
      char_start:     row.char_start ?? null,
      char_end:       row.char_end ?? null,
    }))

    return JSON.stringify({ result_type: 'recall_results', topic: query, corpus: corpus ?? null, results })
  }

  _recallConversations (topic, limit, scope = null) {
    if (!fs.existsSync(SQLITE_PATH)) return []
    const normalizedScope = normalizeActiveScope(scope)
    const range = conversationDateRange(topic)
    if (range) {
      const scopeClause = normalizedScope ? ' AND workspace_id = ?' : ''
      const rows = getSqlite().prepare(`
        SELECT id, role, content, created_at, session_id
        FROM conversations
        WHERE created_at >= ? AND created_at <= ?${scopeClause}
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(...(normalizedScope ? [range.from, range.to, normalizedScope, limit] : [range.from, range.to, limit]))
      if (rows.length > 0) return rows.map(conversationRowToResult)
    }

    const kws = keywords(topic)
    if (kws.length === 0) return []
    const conditions = kws.map(() => 'content LIKE ?').join(' OR ')
    const params = kws.map(k => `%${k}%`)
    const scopedRows = getSqlite().prepare(`
      SELECT id, role, content, created_at, session_id
      FROM conversations
      WHERE ${normalizedScope ? 'workspace_id = ? AND ' : ''}${conditions}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...(normalizedScope ? [normalizedScope, ...params, limit] : [...params, limit]))
    if (scopedRows.length > 0 || !normalizedScope) return scopedRows.map(conversationRowToResult)

    const rows = getSqlite().prepare(`
      SELECT id, role, content, created_at, session_id
      FROM conversations
      WHERE ${conditions}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...params, limit)
    return rows.map(conversationRowToResult)
  }

  async _find ({ name, type, corpus, k = 12, scope = null }, context = {}) {
    const query = `${name ?? ''}`.trim()
    const effectiveType = type ?? (/\b(folder|directory|scripts)\b/i.test(query) ? 'directory' : null)
    const activeScope = normalizeActiveScope(scope, context)
    k = Math.min(Math.max(1, k ?? 12), 50)
    this.log(`find: "${query}" type=${effectiveType ?? 'any'} corpus=${corpus ?? 'all'} scope=${activeScope ?? 'all'}`)

    const externalFirst = isFilesystemQuery(query, effectiveType)
    const external = this._findExternalResources(query, effectiveType, externalFirst ? k : Math.ceil(k / 2))
    const neededResources = externalFirst ? Math.max(1, k - external.length) : k
    let resources = await this._findResources(query, effectiveType, corpus, neededResources, activeScope)
    if (activeScope && resources.length === 0) {
      const fallbackResources = await this._findResources(query, effectiveType, corpus, neededResources, null)
      resources = mergeUniqueRows(resources, fallbackResources, row => `${row.resource_id}`)
    }
    const ordered = externalFirst ? [...external, ...resources] : [...resources, ...external]

    return JSON.stringify({
      result_type: 'resource_list',
      query,
      count: ordered.length,
      resources: ordered.slice(0, k),
    })
  }

  async _findResources (query, type, corpus, k, scope = null) {
    const pool = getPool()
    const exactMatches = (!type || type === 'document' || type === 'note' || type === 'report' || type === 'spec')
      ? await exactSectionResources(pool, query, corpus, k, scope)
      : []

    const params = [`%${query}%`, query]
    const filters = [`(
      r.title ILIKE $1 OR r.source_ref ILIKE $1 OR coalesce(r.summary, '') ILIKE $1 OR
      to_tsvector('english', coalesce(r.title, '') || ' ' || coalesce(r.summary, '') || ' ' || coalesce(r.source_ref, '')) @@ plainto_tsquery('english', $2)
    )`]
    let next = 3
    if (type) { filters.push(`r.type = $${next++}`); params.push(type) }
    const knowledgeFilters = buildKnowledgeFilters({ corpus, scope }, next)
    filters.push(...knowledgeFilters.clauses)
    params.push(...knowledgeFilters.values)
    params.push(k)
    const limitParam = params.length

    const { rows } = await pool.query(`
      SELECT r.id, r.title, r.type, r.source_ref, r.source_kind, r.summary,
             r.mime_type, r.size_bytes, r.stored_path, r.metadata,
             co.slug AS corpus, co.display_name AS corpus_name,
             r.updated_at
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE ${filters.join(' AND ')}
      ORDER BY r.updated_at DESC
      LIMIT $${limitParam}
    `, params)

    const merged = [...exactMatches, ...rows.map(r => ({
      resource_id: String(r.id),
      title:       r.title,
      type:        r.type,
      corpus:      r.corpus,
      source_ref:  r.source_ref,
      source_kind: r.source_kind,
      summary:     r.summary,
      mime_type:   r.mime_type,
      size_bytes:  r.size_bytes,
      stored_path: r.stored_path,
      external:    false,
      updated_at:  r.updated_at,
    }))]

    const seen = new Set()
    return merged.filter(row => {
      const key = `${row.resource_id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, k)
  }

  _findExternalResources (query, type, limit) {
    if (limit <= 0) return []
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const roots = searchRoots()
    const results = []
    const want = type?.toLowerCase()
    const isDirWanted = want === 'dir' || want === 'directory'
    const isFileWanted = want === 'file'

    const visit = (dir, depth = 0) => {
      if (results.length >= limit || depth > 5) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (results.length >= limit) break
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        const lower = entry.name.toLowerCase()
        const fullLower = full.toLowerCase()
        const matches = terms.every(t => lower.includes(t) || fullLower.includes(t)) || fullLower.includes(query.toLowerCase())
        const kind = entry.isDirectory() ? 'directory' : 'file'
        const typeOk = !want || (isDirWanted && entry.isDirectory()) || (isFileWanted && entry.isFile()) || want === kind
        if (matches && typeOk) {
          results.push({
            resource_id: fsId(full),
            title:       entry.name,
            type:        kind,
            corpus:      'external-filesystem',
            source_ref:  full,
            source_kind: 'path',
            summary:     `${kind} on the live filesystem`,
            external:    true,
          })
        }
        if (entry.isDirectory()) visit(full, depth + 1)
      }
    }

    for (const root of roots) visit(root, 0)
    return results
  }

  async _load ({ resource_id, max_chars = 12000 }) {
    const externalPath = fromFsId(resource_id) ?? (isPathLike(resource_id) ? path.resolve(`${resource_id}`) : null)
    if (externalPath) return this._loadExternal(externalPath, max_chars)

    const numericId = parseInt(resource_id, 10)
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return JSON.stringify({ error: `Invalid resource_id: ${resource_id}` })
    }

    const pool = getPool()
    const { rows } = await pool.query(`
      SELECT r.id, r.title, r.type, r.source_ref, r.source_kind, r.summary, r.metadata,
             r.size_bytes, r.mime_type, r.stored_path, r.created_at, r.updated_at,
             co.slug AS corpus, co.display_name AS corpus_name
      FROM resources r
      LEFT JOIN corpora co ON co.id = r.corpus_id
      WHERE r.id = $1
    `, [numericId])

    const resource = rows[0]
    if (!resource) return JSON.stringify({ error: `Resource ${resource_id} not found` })

    const { rows: chunks } = await pool.query(`
      SELECT id AS chunk_id, chunk_index,
             COALESCE(section_path, CASE WHEN section_header IS NULL THEN ARRAY[]::text[] ELSE ARRAY[section_header] END) AS section_path,
             section_header, content, start_line, end_line, char_start, char_end
      FROM chunks
      WHERE resource_id = $1
      ORDER BY chunk_index ASC
    `, [numericId])

    let loadedChunks = chunks
    if (loadedChunks.length === 0 && resource.stored_path && fs.existsSync(resource.stored_path)) {
      const stat = fs.statSync(resource.stored_path)
      if (stat.isFile()) {
        const content = fs.readFileSync(resource.stored_path, 'utf8').slice(0, max_chars)
        loadedChunks = [{ chunk_id: null, chunk_index: 0, section_path: [], section_header: null, content }]
      }
    }

    return JSON.stringify({
      result_type: 'resource',
      resource: this._resourceOut(resource),
      chunks: loadedChunks.map(c => ({
        chunk_id:       c.chunk_id,
        resource_id:    String(resource.id),
        doc_id:         String(resource.id),
        chunk_index:    c.chunk_index,
        section_path:   c.section_path ?? [],
        section_header: c.section_header ?? (c.section_path?.join(' > ') || null),
        content:        c.content,
        title:          resource.title,
        domain:         resource.corpus,
        corpus:         resource.corpus,
        source_ref:     resource.source_ref,
        source_path:    resource.source_ref,
        rrf_score:      0,
        is_neighbor:    false,
        start_line:     c.start_line ?? null,
        end_line:       c.end_line ?? null,
        char_start:     c.char_start ?? null,
        char_end:       c.char_end ?? null,
      })),
    })
  }

  _loadExternal (targetPath, maxChars = 12000) {
    const resolved = path.resolve(targetPath)
    if (!fs.existsSync(resolved)) return JSON.stringify({ error: `External resource not found: ${resolved}` })
    const stat = fs.statSync(resolved)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter(e => e.name !== 'node_modules' && e.name !== '.git' && !e.name.startsWith('.'))
        .slice(0, 100)
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          resource_id: fsId(path.join(resolved, e.name)),
        }))
      const textFiles = entries
        .filter(e => e.type === 'file')
        .map(e => path.join(resolved, e.name))
        .filter(isLikelyTextFile)
        .slice(0, 40)
      const perFileChars = Math.max(800, Math.floor(maxChars / Math.max(textFiles.length, 1)))
      const chunks = []
      for (let i = 0; i < textFiles.length; i++) {
        try {
          const filePath = textFiles[i]
          chunks.push({
            chunk_id: null,
            resource_id: fsId(filePath),
            doc_id: fsId(filePath),
            chunk_index: i,
            section_path: [path.basename(filePath)],
            section_header: path.basename(filePath),
            content: fs.readFileSync(filePath, 'utf8').slice(0, perFileChars),
            title: path.basename(filePath),
            domain: 'external-filesystem',
            corpus: 'external-filesystem',
            source_ref: filePath,
            source_path: filePath,
            rrf_score: 0,
            is_neighbor: false,
          })
        } catch {
          // Skip unreadable files; the directory listing still exposes them.
        }
      }
      return JSON.stringify({
        result_type: 'resource',
        resource: {
          id: fsId(resolved),
          title: path.basename(resolved),
          type: 'directory',
          corpus: 'external-filesystem',
          source_ref: resolved,
          source_kind: 'path',
          external: true,
        },
        entries,
        chunks,
      })
    }

    let content = ''
    try { content = fs.readFileSync(resolved, 'utf8') } catch (err) { return JSON.stringify({ error: err.message }) }
    const truncated = content.length > maxChars
    if (truncated) content = content.slice(0, maxChars)
    return JSON.stringify({
      result_type: 'resource',
      resource: {
        id: fsId(resolved),
        title: path.basename(resolved),
        type: 'file',
        corpus: 'external-filesystem',
        source_ref: resolved,
        source_kind: 'path',
        size_bytes: stat.size,
        external: true,
      },
      chunks: [{
        chunk_id: null,
        resource_id: fsId(resolved),
        doc_id: fsId(resolved),
        chunk_index: 0,
        section_path: [],
        section_header: null,
        content,
        title: path.basename(resolved),
        domain: 'external-filesystem',
        corpus: 'external-filesystem',
        source_ref: resolved,
        source_path: resolved,
        rrf_score: 0,
        is_neighbor: false,
      }],
      truncated,
    })
  }

  _reflect () {
    return JSON.stringify({
      result_type: 'reflection',
      sufficient: false,
      summary: 'Reflection is computed by the broker from current observations.',
      gaps: [],
    })
  }

  _resourceOut (row) {
    return {
      id:          String(row.id),
      title:       row.title,
      type:        row.type,
      corpus:      row.corpus,
      corpus_name: row.corpus_name,
      source_ref:  row.source_ref,
      source_kind: row.source_kind,
      summary:     row.summary,
      metadata:    row.metadata ?? {},
      size_bytes:  row.size_bytes,
      mime_type:   row.mime_type,
      stored_path: row.stored_path,
      created_at:  row.created_at,
      updated_at:  row.updated_at,
    }
  }
}

new KnowledgeAgent().run()
