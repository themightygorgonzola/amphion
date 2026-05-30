/**
 * apps/desktop/renderer/app.js — chronicle UI logic
 *
 * Renders chat as a durable run chronicle:
 *   Conversation -> Run -> Entry -> Block -> Ref
 */

;(async () => {

let isStreaming = false
let activeRequestId = null
let currentRun = null
let persistTimer = null
const stickyScrollState = new WeakMap()

const STORAGE_KEY = 'amphion_sessions_v2'
const LEGACY_STORAGE_KEY = 'amphion_sessions_v1'
const INGEST_CORPUS_KEY = 'amphion_ingest_corpus_v1'
const DEFAULT_INGEST_CORPUS = 'research'

function nowIso () {
  return new Date().toISOString()
}

function normalizeText (value) {
  return `${value ?? ''}`.trim()
}

function safeJson (value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return `${value}`
  }
}

function truncateText (value, max = 160) {
  const text = normalizeText(value)
  if (!text || text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}...`
}

function countLabel (count, singular, plural) {
  const n = Number.isFinite(count) ? count : 0
  return `${n} ${n === 1 ? singular : plural}`
}

function timeStr (value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatDuration (startedAt, endedAt = nowIso()) {
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null

  const ms = end - start
  if (ms < 1000) return `${ms} ms`

  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, '0')}s`

  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}h ${remMinutes.toString().padStart(2, '0')}m`
}

function newSessionId () {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function newRequestId () {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function currentAssistantName () {
  return brandName.textContent ?? 'Atlas'
}

function resolveRefHref (ref) {
  const explicit = normalizeText(ref?.href)
  if (explicit && /^https?:\/\//i.test(explicit)) return explicit
  const targetId = normalizeText(ref?.target_id)
  if (targetId && /^https?:\/\//i.test(targetId)) return targetId
  return ''
}

function looksLikeLocalPath (value) {
  const text = normalizeText(value)
  return /^[a-zA-Z]:[\\/]/.test(text) || /^\\\\/.test(text) || (/^\//.test(text) && !/^https?:\/\//i.test(text))
}

function resolveRefLocalPath (ref) {
  const explicit = normalizeText(ref?.href)
  if (looksLikeLocalPath(explicit)) return explicit
  const targetId = normalizeText(ref?.target_id)
  if (looksLikeLocalPath(targetId)) return targetId
  return ''
}

function normalizeBlock (block) {
  if (!block || typeof block !== 'object') return null
  const type = normalizeText(block.type) || 'paragraph'

  if (type === 'paragraph' || type === 'code' || type === 'diff' || type === 'math') {
    return { type, text: `${block.text ?? ''}`, language: normalizeText(block.language) || 'text' }
  }
  if (type === 'badge') {
    return { type, text: normalizeText(block.text), tone: normalizeText(block.tone) || 'neutral' }
  }
  if (type === 'quote') {
    return {
      type,
      text: `${block.text ?? ''}`,
      attribution: normalizeText(block.attribution) || null,
    }
  }
  if (type === 'list') {
    return {
      type,
      ordered: Boolean(block.ordered),
      items: Array.isArray(block.items) ? block.items.map(item => `${item ?? ''}`) : [],
    }
  }
  if (type === 'json') {
    return { type, value: block.value ?? null }
  }
  if (type === 'table') {
    return {
      type,
      headers: Array.isArray(block.headers) ? block.headers.map(header => `${header ?? ''}`) : [],
      rows: Array.isArray(block.rows) ? block.rows.map(row => Array.isArray(row) ? row.map(cell => `${cell ?? ''}`) : []) : [],
    }
  }
  if (type === 'media') {
    return {
      type,
      url: normalizeText(block.url),
      caption: normalizeText(block.caption) || null,
    }
  }

  return { type: 'json', value: block }
}

function normalizeRef (ref) {
  if (!ref || typeof ref !== 'object') return null
  const targetId = normalizeText(ref.target_id) || null
  return {
    kind: normalizeText(ref.kind) || 'resource',
    target_id: targetId,
    label: normalizeText(ref.label) || targetId || 'reference',
    locator: ref.locator ?? null,
    href: resolveRefHref(ref),
    localPath: resolveRefLocalPath(ref),
  }
}

function normalizeEntry (entry) {
  if (!entry || typeof entry !== 'object') return null
  return {
    id: normalizeText(entry.id) || `entry_${Math.random().toString(36).slice(2, 10)}`,
    seq: Number.isFinite(entry.seq) ? entry.seq : null,
    mode: normalizeText(entry.mode) || 'observe',
    subject: {
      kind: normalizeText(entry.subject?.kind) || 'session',
      id: normalizeText(entry.subject?.id) || null,
      label: normalizeText(entry.subject?.label) || null,
    },
    status: normalizeText(entry.status) || 'done',
    summary: normalizeText(entry.summary) || 'Untitled entry',
    ts_start: normalizeText(entry.ts_start) || nowIso(),
    ts_end: normalizeText(entry.ts_end) || normalizeText(entry.ts_start) || nowIso(),
    blocks: Array.isArray(entry.blocks) ? entry.blocks.map(normalizeBlock).filter(Boolean) : [],
    refs: Array.isArray(entry.refs) ? entry.refs.map(normalizeRef).filter(Boolean) : [],
    raw: entry.raw ?? null,
  }
}

function normalizeMessageItem (item) {
  const role = item.role === 'assistant' ? 'assistant' : 'user'
  return {
    kind: 'message',
    role,
    content: `${item.content ?? ''}`,
    ts: normalizeText(item.ts ?? item.createdAt) || nowIso(),
  }
}

function normalizeRunItem (item) {
  return {
    kind: 'run',
    runId: normalizeText(item.runId) || newRequestId(),
    remoteRunId: normalizeText(item.remoteRunId) || null,
    status: normalizeText(item.status) || 'done',
    startedAt: normalizeText(item.startedAt) || nowIso(),
    endedAt: normalizeText(item.endedAt) || null,
    error: normalizeText(item.error) || null,
    entries: Array.isArray(item.entries) ? item.entries.map(normalizeEntry).filter(Boolean) : [],
  }
}

function normalizeSessionItem (item) {
  if (!item || typeof item !== 'object') return null
  if (item.kind === 'run') return normalizeRunItem(item)
  if (item.kind === 'message') return normalizeMessageItem(item)
  if (item.role === 'user' || item.role === 'assistant') {
    return normalizeMessageItem({ role: item.role, content: item.content, ts: item.ts ?? item.createdAt })
  }
  return null
}

function normalizeSessionRecord (raw) {
  if (Array.isArray(raw)) {
    return { items: raw.map(normalizeSessionItem).filter(Boolean) }
  }
  if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
    return { items: raw.items.map(normalizeSessionItem).filter(Boolean) }
  }
  return { items: [] }
}

function persistSessions () {
  try {
    const serialized = {}
    for (const [sid, session] of sessions.entries()) serialized[sid] = session
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serialized))
  } catch {}
}

function schedulePersist () {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistSessions()
    renderHistorySidebar()
  }, 250)
}

function flushPersist () {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  persistSessions()
  renderHistorySidebar()
}

function loadPersistedSessions () {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw)
    for (const [sid, session] of Object.entries(parsed)) {
      sessions.set(sid, normalizeSessionRecord(session))
    }
  } catch {}
}

const sessions = new Map()
loadPersistedSessions()

const _lastSid = [...sessions.keys()].pop()
let sessionId = _lastSid ?? newSessionId()

const messagesEl = document.getElementById('messages')
const inputEl = document.getElementById('message-input')
const formEl = document.getElementById('input-form')
const sendBtn = document.getElementById('send-btn')
const statusBar = document.getElementById('status-bar')
const brandStatus = document.getElementById('brand-status')
const historyList = document.getElementById('history-list')
const newChatBtn = document.getElementById('new-chat-btn')
const clearHistoryBtn = document.getElementById('clear-history-btn')
const brandName = document.getElementById('brand-name')

function getOrCreateSession (sid) {
  if (!sessions.has(sid)) sessions.set(sid, { items: [] })
  return sessions.get(sid)
}

function bindStickyScroll (el) {
  if (!el || stickyScrollState.has(el)) return
  stickyScrollState.set(el, true)
  el.addEventListener('scroll', () => {
    stickyScrollState.set(el, isNearBottom(el))
  })
}

function distanceFromBottom (el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

function isNearBottom (el = messagesEl, threshold = 72) {
  return distanceFromBottom(el) <= threshold
}

function scrollElementToBottom (el) {
  if (!el) return
  bindStickyScroll(el)
  const shouldStick = stickyScrollState.get(el)
  if (!shouldStick && !isNearBottom(el)) return
  el.scrollTop = el.scrollHeight
  stickyScrollState.set(el, true)
}

bindStickyScroll(messagesEl)

async function checkHealth () {
  try {
    const h = await window.amphion.health()
    if (h?.ok) {
      brandStatus.className = 'status-dot online'
      brandStatus.title = 'Broker online'
      if (h.system?.displayName) brandName.textContent = h.system.displayName
    } else {
      brandStatus.className = 'status-dot offline'
      brandStatus.title = 'Broker offline — run: npm run broker'
    }
  } catch {
    brandStatus.className = 'status-dot offline'
  }
}

checkHealth()
setInterval(checkHealth, 15_000)

function renderEmptyState () {
  const wrapper = document.createElement('div')
  wrapper.id = 'empty-state'

  const title = document.createElement('h2')
  title.textContent = currentAssistantName()

  const body = document.createElement('p')
  body.textContent = 'Runs stream here as a live chronicle of narration, actions, observations, and delivery.'

  wrapper.append(title, body)
  messagesEl.appendChild(wrapper)
}

function createMessageEl (item) {
  const el = document.createElement('article')
  el.className = `message ${item.role}`

  const bubble = document.createElement('div')
  bubble.className = 'message-bubble'
  bubble.textContent = `${item.content ?? ''}`

  const meta = document.createElement('div')
  meta.className = 'message-meta'
  meta.textContent = `${item.role === 'user' ? 'You' : currentAssistantName()} · ${timeStr(item.ts)}`

  el.append(bubble, meta)
  return el
}

function summarizeRun (run) {
  if (run.error) return run.error

  for (let i = run.entries.length - 1; i >= 0; i--) {
    const entry = run.entries[i]
    if (entry.mode === 'deliver') {
      const paragraph = entry.blocks.find(block => block.type === 'paragraph' && normalizeText(block.text))
      if (paragraph) return truncateText(paragraph.text, 160)
    }
    if (normalizeText(entry.summary)) return entry.summary
  }

  return run.status === 'live'
    ? 'Waiting for chronicle entries…'
    : 'Run complete'
}

function createChip (text, className) {
  const chip = document.createElement('span')
  chip.className = className
  chip.textContent = text
  return chip
}

function createEntryFact (text, tone = 'neutral') {
  const normalized = normalizeText(text)
  if (!normalized) return null
  return { text: normalized, tone }
}

function dedupeFacts (facts) {
  const seen = new Set()
  return facts.filter(fact => {
    const key = `${fact.text}|${fact.tone}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isEvidenceCollectorEntry (entry) {
  if (!entry) return false
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
  if (entry.mode !== 'observe') return false
  if (Number.isFinite(raw.docCount) || Number.isFinite(raw.chunkCount)) return true
  return /^Collected\s+/i.test(normalizeText(entry.summary))
}

function getEntryVariant (entry) {
  if (entry.mode === 'deliver') return 'deliver'
  if (entry.mode === 'narrate') return 'narration'
  if (entry.subject?.label === 'Dispatcher') return 'transition'
  if (entry.mode === 'act' || entry.subject?.kind === 'tool') return 'action'
  if (isEvidenceCollectorEntry(entry)) return 'collection'
  if (entry.subject?.kind === 'resource' || entry.refs.some(ref => ref.kind === 'resource')) return 'evidence'
  return 'compact'
}

function pushUniqueBlock (blocks, block) {
  const normalized = normalizeBlock(block)
  if (!normalized) return

  if ((normalized.type === 'paragraph' || normalized.type === 'quote') && !normalizeText(normalized.text)) return
  if (normalized.type === 'list' && !normalized.items.length) return

  if (normalized.type === 'paragraph' || normalized.type === 'quote') {
    const text = normalizeText(normalized.text)
    const exists = blocks.some(existing => {
      if (existing.type !== normalized.type) return false
      return normalizeText(existing.text) === text
    })
    if (exists) return
  }

  blocks.push(normalized)
}

function getEntryDisplayBlocks (entry) {
  const summaryText = normalizeText(entry.summary)
  const displayBlocks = []

  for (const block of entry.blocks ?? []) {
    const normalized = normalizeBlock(block)
    if (!normalized) continue
    if (normalized.type === 'paragraph' && normalizeText(normalized.text) === summaryText) continue
    pushUniqueBlock(displayBlocks, normalized)
  }

  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}

  if (entry.mode === 'act') {
    pushUniqueBlock(displayBlocks, { type: 'paragraph', text: raw.reasoning })
  }

  if (entry.subject?.label === 'Dispatcher') {
    pushUniqueBlock(displayBlocks, { type: 'paragraph', text: raw.intent })
    if (normalizeText(raw.topic) !== normalizeText(raw.intent)) {
      pushUniqueBlock(displayBlocks, { type: 'paragraph', text: raw.topic })
    }
  }

  if (entry.mode === 'observe') {
    pushUniqueBlock(displayBlocks, {
      type: 'quote',
      text: raw.highlight_phrase,
      attribution: normalizeText(raw.title) || normalizeText(raw.section_header) || null,
    })
    pushUniqueBlock(displayBlocks, { type: 'paragraph', text: raw.annotation })
    if (!displayBlocks.length) pushUniqueBlock(displayBlocks, { type: 'paragraph', text: raw.summary })
    if (!displayBlocks.length) pushUniqueBlock(displayBlocks, { type: 'paragraph', text: truncateText(raw.content, 420) })
  }

  return displayBlocks
}

function getEntryFacts (entry) {
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
  const facts = []

  if (entry.subject?.label === 'Dispatcher') {
    facts.push(createEntryFact(raw.modality, 'info'))
    facts.push(createEntryFact(raw.urgency, raw.urgency === 'high' ? 'warn' : 'neutral'))
    if (normalizeText(raw.responseLength) && normalizeText(raw.responseLength) !== 'standard') {
      facts.push(createEntryFact(raw.responseLength, 'neutral'))
    }
  }

  if (entry.mode === 'act') {
    facts.push(createEntryFact(raw.domain, 'info'))
    if (Number.isFinite(raw.resultCount)) {
      facts.push(createEntryFact(countLabel(raw.resultCount, 'result', 'results'), 'neutral'))
    }
  }

  if (entry.mode === 'observe') {
    if (Number.isFinite(raw.docCount)) {
      facts.push(createEntryFact(countLabel(raw.docCount, 'resource', 'resources'), 'neutral'))
    }
    if (Number.isFinite(raw.chunkCount)) {
      facts.push(createEntryFact(countLabel(raw.chunkCount, 'excerpt', 'excerpts'), 'neutral'))
    }
    if (normalizeText(raw.section_header)) facts.push(createEntryFact(raw.section_header, 'neutral'))
  }

  return dedupeFacts(facts.filter(Boolean))
}

function captureEntryOpenState (entryEl) {
  if (!entryEl) return null
  return {
    shellOpen: Boolean(entryEl.querySelector('.entry-shell')?.open),
    rawOpen: Boolean(entryEl.querySelector('.entry-raw')?.open),
  }
}

function applyEntryOpenState (entryEl, openState) {
  if (!entryEl || !openState) return
  const shell = entryEl.querySelector('.entry-shell')
  const raw = entryEl.querySelector('.entry-raw')
  if (shell) shell.open = openState.shellOpen
  if (raw) raw.open = openState.rawOpen
}

function buildTableBlock (block) {
  const wrapper = document.createElement('div')
  wrapper.className = 'entry-block block-table'

  const table = document.createElement('table')
  if (block.headers?.length) {
    const thead = document.createElement('thead')
    const row = document.createElement('tr')
    for (const headerText of block.headers) {
      const th = document.createElement('th')
      th.textContent = headerText
      row.appendChild(th)
    }
    thead.appendChild(row)
    table.appendChild(thead)
  }

  const tbody = document.createElement('tbody')
  for (const rowData of block.rows ?? []) {
    const row = document.createElement('tr')
    for (const cellText of rowData) {
      const td = document.createElement('td')
      td.textContent = cellText
      row.appendChild(td)
    }
    tbody.appendChild(row)
  }
  table.appendChild(tbody)
  wrapper.appendChild(table)
  return wrapper
}

function buildJsonDetails (title, value, className, isOpen = false) {
  const details = document.createElement('details')
  details.className = className
  if (isOpen) details.open = true

  const summary = document.createElement('summary')
  summary.textContent = title

  const pre = document.createElement('pre')
  pre.textContent = safeJson(value)

  details.append(summary, pre)
  return details
}

function renderBlock (block) {
  const normalized = normalizeBlock(block)
  if (!normalized) return null

  if (normalized.type === 'paragraph') {
    const el = document.createElement('p')
    el.className = 'entry-block block-paragraph'
    el.textContent = normalized.text
    return el
  }

  if (normalized.type === 'quote') {
    const figure = document.createElement('figure')
    figure.className = 'entry-block block-quote'

    const quote = document.createElement('blockquote')
    quote.textContent = normalized.text
    figure.appendChild(quote)

    if (normalized.attribution) {
      const caption = document.createElement('figcaption')
      caption.textContent = normalized.attribution
      figure.appendChild(caption)
    }
    return figure
  }

  if (normalized.type === 'code' || normalized.type === 'diff' || normalized.type === 'math') {
    const wrapper = document.createElement('div')
    wrapper.className = `entry-block block-${normalized.type}`

    const pre = document.createElement('pre')
    const code = document.createElement('code')
    code.textContent = normalized.text
    if (normalized.language) code.dataset.language = normalized.language
    pre.appendChild(code)
    wrapper.appendChild(pre)
    return wrapper
  }

  if (normalized.type === 'badge') {
    return createChip(normalized.text, `entry-block block-badge tone-${normalized.tone}`)
  }

  if (normalized.type === 'list') {
    const list = document.createElement(normalized.ordered ? 'ol' : 'ul')
    list.className = 'entry-block block-list'
    for (const itemText of normalized.items) {
      const li = document.createElement('li')
      li.textContent = itemText
      list.appendChild(li)
    }
    return list
  }

  if (normalized.type === 'json') {
    return buildJsonDetails('Structured block', normalized.value, 'entry-block block-json')
  }

  if (normalized.type === 'table') {
    return buildTableBlock(normalized)
  }

  if (normalized.type === 'media') {
    const wrapper = document.createElement('div')
    wrapper.className = 'entry-block block-media'

    const link = document.createElement('a')
    link.href = normalized.url || '#'
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = normalized.url || 'Open media'
    wrapper.appendChild(link)

    if (normalized.caption) {
      const caption = document.createElement('div')
      caption.className = 'block-media-caption'
      caption.textContent = normalized.caption
      wrapper.appendChild(caption)
    }
    return wrapper
  }

  return buildJsonDetails('Block', normalized, 'entry-block block-json')
}

function renderRef (ref) {
  return renderRefWithOptions(ref)
}

function renderRefWithOptions (ref, options = {}) {
  const normalized = normalizeRef(ref)
  if (!normalized) return null

  const {
    actionLabel = '',
    extraClassName = '',
    stopSummaryToggle = false,
  } = options

  const href = resolveRefHref(normalized)
  const localPath = normalizeText(normalized.localPath)
  const el = localPath
    ? document.createElement('button')
    : href
      ? document.createElement('a')
      : document.createElement('span')
  el.className = `ref-chip${localPath ? ' ref-chip-button ref-chip-local' : ''}${extraClassName ? ` ${extraClassName}` : ''}`
  el.textContent = normalizeText(actionLabel) || normalized.label
  if (localPath) {
    el.type = 'button'
    el.addEventListener('click', async (event) => {
      if (stopSummaryToggle) {
        event.preventDefault()
        event.stopPropagation()
      }
      const result = await window.atlasApp.showPath(localPath)
      if (!result?.ok) setStatus(result?.error || 'Could not reveal source file.', 3500)
    })
  } else if (href) {
    el.href = href
    el.target = '_blank'
    el.rel = 'noreferrer'
    if (stopSummaryToggle) {
      el.addEventListener('click', (event) => {
        event.stopPropagation()
      })
    }
  }

  const locator = normalized.locator ? safeJson(normalized.locator) : ''
  const titleParts = [normalized.kind, normalized.target_id, locator].filter(Boolean)
  if (localPath) titleParts.push('Click to reveal source file')
  if (titleParts.length) el.title = titleParts.join('\n')

  return el
}

function getPrimaryEntryRef (entry, variant) {
  if (variant !== 'evidence') return null
  return entry.refs.find(ref => normalizeText(ref.localPath) || resolveRefHref(ref)) ?? null
}

function isSameRef (left, right) {
  if (!left || !right) return false
  return normalizeText(left.target_id) === normalizeText(right.target_id)
    && normalizeText(left.href) === normalizeText(right.href)
    && normalizeText(left.localPath) === normalizeText(right.localPath)
    && normalizeText(left.label) === normalizeText(right.label)
}

function getEvidenceTitle (entry) {
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
  return normalizeText(raw.title)
    || normalizeText(entry.subject?.label)
    || normalizeText(entry.summary)
    || 'Source evidence'
}

function getPrimaryRefActionLabel (ref) {
  if (!ref) return ''
  return normalizeText(ref.localPath) ? 'File' : 'Source'
}

function getLeafLabel (value) {
  const text = normalizeText(value)
  if (!text) return ''

  const dotParts = text.split('·').map(part => normalizeText(part)).filter(Boolean)
  const trailingPart = dotParts.at(-1)
  if (trailingPart && /\.[a-z0-9]{2,8}$/i.test(trailingPart)) return trailingPart.replace(/^#\s*/, '')

  const slashParts = text.split(/[\\/]/).map(part => normalizeText(part)).filter(Boolean)
  const slashLeaf = slashParts.at(-1)
  if (slashLeaf && /\.[a-z0-9]{2,8}$/i.test(slashLeaf)) return slashLeaf.replace(/^#\s*/, '')

  try {
    const url = new URL(text)
    const urlLeaf = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '')
    if (urlLeaf) return urlLeaf.replace(/^#\s*/, '')
  } catch {}

  return text.replace(/^#\s*/, '')
}

function getSourceListLabel (entry) {
  const primaryRef = getPrimaryEntryRef(entry, 'evidence')
  const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
  const candidates = [
    primaryRef?.label,
    primaryRef?.localPath,
    primaryRef?.target_id,
    primaryRef?.href,
    raw.source_path,
    raw.title,
    entry.subject?.label,
    entry.summary,
  ]

  for (const candidate of candidates) {
    const leaf = getLeafLabel(candidate)
    if (leaf) return leaf
  }
  return 'source'
}

function canOwnEvidenceGroup (entry) {
  return isEvidenceCollectorEntry(entry)
}

function isDeferrableSourceBridge (entry) {
  if (!entry || getEntryVariant(entry) === 'evidence') return false
  if (entry.mode !== 'narrate') return false
  if (normalizeText(entry.subject?.label) !== 'Broker') return false
  return /composing response/i.test(normalizeText(entry.summary))
}

function captureDetailOpenStates (root) {
  const states = new Map()
  if (!root) return states
  for (const el of root.querySelectorAll('details[data-open-key]')) {
    states.set(el.dataset.openKey, el.open)
  }
  return states
}

function restoreDetailOpenStates (root, states) {
  if (!root || !states?.size) return
  for (const el of root.querySelectorAll('details[data-open-key]')) {
    const key = el.dataset.openKey
    if (states.has(key)) el.open = states.get(key)
  }
}

function buildEntryRawDetails (entry, openKey) {
  const rawDetails = buildJsonDetails('Raw JSON', {
    id: entry.id,
    mode: entry.mode,
    subject: entry.subject,
    status: entry.status,
    summary: entry.summary,
    refs: entry.refs,
    raw: entry.raw,
  }, 'entry-raw')
  rawDetails.dataset.openKey = openKey
  return rawDetails
}

function buildEntryBody (entry, displayBlocks, refs = entry.refs) {
  const body = document.createElement('div')
  body.className = 'entry-body'

  if (displayBlocks.length) {
    const blocksEl = document.createElement('div')
    blocksEl.className = 'entry-blocks'
    for (const block of displayBlocks) {
      const blockEl = renderBlock(block)
      if (blockEl) blocksEl.appendChild(blockEl)
    }
    if (blocksEl.childNodes.length) body.appendChild(blocksEl)
  }

  if (refs.length) {
    const refsEl = document.createElement('div')
    refsEl.className = 'entry-refs'
    for (const ref of refs) {
      const refEl = renderRef(ref)
      if (refEl) refsEl.appendChild(refEl)
    }
    if (refsEl.childNodes.length) body.appendChild(refsEl)
  }

  body.appendChild(buildEntryRawDetails(entry, `entry:${entry.id}:raw`))

  return body
}

function createSourceItemEl (entry) {
  const displayBlocks = getEntryDisplayBlocks(entry)
  const primaryRef = getPrimaryEntryRef(entry, 'evidence')
  const visibleRefs = primaryRef
    ? entry.refs.filter(ref => !isSameRef(ref, primaryRef))
    : entry.refs

  const item = document.createElement('details')
  item.className = 'source-item'
  item.dataset.openKey = `source-item:${entry.id}`

  const summary = document.createElement('summary')
  summary.className = 'source-item-summary'

  const name = document.createElement('span')
  name.className = 'source-item-name'
  name.textContent = getSourceListLabel(entry)
  summary.appendChild(name)

  const timeEl = document.createElement('span')
  timeEl.className = 'source-item-time'
  timeEl.textContent = timeStr(entry.ts_end || entry.ts_start)
  summary.appendChild(timeEl)

  const body = document.createElement('div')
  body.className = 'source-item-body'

  const titleText = getEvidenceTitle(entry)
  if (normalizeText(titleText) && normalizeText(titleText) !== normalizeText(name.textContent)) {
    const title = document.createElement('div')
    title.className = 'source-item-title'
    title.textContent = titleText
    body.appendChild(title)
  }

  const actions = document.createElement('div')
  actions.className = 'source-item-actions'
  if (primaryRef) {
    actions.appendChild(renderRefWithOptions(primaryRef, {
      actionLabel: getPrimaryRefActionLabel(primaryRef),
      extraClassName: 'entry-source-action',
      stopSummaryToggle: true,
    }))
  }
  for (const ref of visibleRefs) {
    const refEl = renderRef(ref)
    if (refEl) actions.appendChild(refEl)
  }
  if (actions.childNodes.length) body.appendChild(actions)

  if (displayBlocks.length) {
    const blocksEl = document.createElement('div')
    blocksEl.className = 'entry-blocks source-item-blocks'
    for (const block of displayBlocks) {
      const blockEl = renderBlock(block)
      if (blockEl) blocksEl.appendChild(blockEl)
    }
    if (blocksEl.childNodes.length) body.appendChild(blocksEl)
  }

  body.appendChild(buildEntryRawDetails(entry, `source-item:${entry.id}:raw`))
  item.append(summary, body)
  return item
}

function createSourceGroupEl (entries, hostEntry) {
  const group = document.createElement('details')
  group.className = 'source-group'
  group.dataset.openKey = `source-group:${hostEntry?.id ?? entries[0]?.id ?? 'sources'}`

  const summary = document.createElement('summary')
  summary.className = 'source-group-summary'
  summary.textContent = countLabel(entries.length, 'source', 'sources')

  const body = document.createElement('div')
  body.className = 'source-group-body'
  for (const entry of entries) {
    body.appendChild(createSourceItemEl(entry))
  }

  group.append(summary, body)
  return group
}

function createEntryEl (entry) {
  const variant = getEntryVariant(entry)
  const facts = getEntryFacts(entry)
  const displayBlocks = getEntryDisplayBlocks(entry)
  const primaryRef = getPrimaryEntryRef(entry, variant)
  const visibleRefs = primaryRef
    ? entry.refs.filter(ref => !isSameRef(ref, primaryRef))
    : entry.refs
  const el = document.createElement('article')
  el.className = `chronicle-entry entry-variant-${variant} entry-mode-${entry.mode} entry-status-${entry.status}`
  el.dataset.entryId = entry.id

  const rail = document.createElement('div')
  rail.className = 'entry-rail'
  rail.appendChild(createChip(entry.seq != null ? String(entry.seq) : '•', 'entry-seq'))

  const shell = document.createElement('details')
  shell.className = 'entry-shell'
  shell.dataset.openKey = `entry:${entry.id}`
  if (variant === 'deliver') shell.open = true

  const summary = document.createElement('summary')
  summary.className = 'entry-row'

  const label = document.createElement('span')
  label.className = 'entry-label'
  label.textContent = variant === 'evidence' ? 'Source' : (entry.subject.label || entry.subject.kind)
  summary.appendChild(label)

  const summaryText = document.createElement('span')
  summaryText.className = 'entry-row-summary'
  summaryText.textContent = variant === 'evidence' ? getEvidenceTitle(entry) : entry.summary
  summary.appendChild(summaryText)

  if (facts.length) {
    const factsEl = document.createElement('div')
    factsEl.className = 'entry-facts'
    for (const fact of facts) {
      factsEl.appendChild(createChip(fact.text, `entry-fact tone-${fact.tone}`))
    }
    summary.appendChild(factsEl)
  }

  if (primaryRef) {
    summary.appendChild(renderRefWithOptions(primaryRef, {
      actionLabel: getPrimaryRefActionLabel(primaryRef),
      extraClassName: 'entry-source-action',
      stopSummaryToggle: true,
    }))
  }

  if (entry.status && entry.status !== 'done') {
    summary.appendChild(createChip(entry.status, `entry-status status-${entry.status}`))
  }

  const timeEl = document.createElement('span')
  timeEl.className = 'entry-time'
  timeEl.textContent = timeStr(entry.ts_end || entry.ts_start)
  summary.appendChild(timeEl)

  if (variant === 'evidence') summary.classList.add('entry-row-evidence')

  shell.append(summary, buildEntryBody(entry, displayBlocks, visibleRefs))

  el.append(rail, shell)
  return el
}

// -----------------------------------------------------------------
// Source panel helpers
// -----------------------------------------------------------------

function groupSourcesByDocument (entries) {
  const groups = new Map()
  for (const entry of entries) {
    const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
    const key = normalizeText(raw.title) || normalizeText(entry.subject?.label) || 'Source'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  // sort within each group by chunk_index ascending so reading order is preserved
  for (const [, group] of groups) {
    group.sort((a, b) => {
      const ai = a.raw?.chunk_index ?? 0
      const bi = b.raw?.chunk_index ?? 0
      return ai - bi
    })
  }
  return groups
}

function markHighlight (text, phrase) {
  if (!phrase || !text) return document.createTextNode(text || '')
  const idx = text.indexOf(phrase)
  if (idx === -1) return document.createTextNode(text)
  const frag = document.createDocumentFragment()
  if (idx > 0) frag.appendChild(document.createTextNode(text.slice(0, idx)))
  const mark = document.createElement('mark')
  mark.textContent = phrase
  frag.appendChild(mark)
  if (idx + phrase.length < text.length) {
    frag.appendChild(document.createTextNode(text.slice(idx + phrase.length)))
  }
  return frag
}

function splitSentences (text) {
  // Split only at a real sentence boundary: punctuation followed by whitespace
  // then a capital letter or opening paren.  This avoids false splits on
  // decimal numbers (47.36), RCW citations (46.63.030), and abbreviations.
  return text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map(s => s.trim()).filter(Boolean)
}

function extractHighlightContext (content, phrase) {
  if (!content) return { before: null, target: '', after: null, found: false, continuation: false }

  // Collapse whitespace for phrase matching and sentence splitting.
  const flat = content.replace(/\s+/g, ' ').trim()
  const flatPhrase = phrase ? phrase.replace(/\s+/g, ' ').trim() : ''
  const continuation = flat.length > 0 && /^[a-z]/.test(flat)

  const sentences = splitSentences(flat)

  // If phrase starts lowercase it was extracted from the overlap region — ignore it.
  const usePhrase = flatPhrase && /^[A-Z([]/.test(flatPhrase) && flat.includes(flatPhrase)

  if (!usePhrase) {
    // Fall back: show first complete sentence that starts with a capital letter
    const firstGood = sentences.find(s => /^[A-Z([]/.test(s)) ?? sentences[0] ?? ''
    const firstGoodIdx = sentences.indexOf(firstGood)
    return {
      before: null,
      target: firstGood,
      after: firstGoodIdx >= 0 && firstGoodIdx < sentences.length - 1 ? sentences[firstGoodIdx + 1] : null,
      found: false,
      continuation,
    }
  }

  let targetIdx = sentences.findIndex(s => s.includes(flatPhrase))

  if (targetIdx === -1) {
    // phrase may span a sentence boundary — try merging adjacent pairs
    for (let i = 0; i < sentences.length - 1; i++) {
      const merged = sentences[i] + ' ' + sentences[i + 1]
      if (merged.includes(flatPhrase)) {
        return {
          before: i > 0 ? sentences[i - 1] : null,
          target: merged,
          after: i + 2 < sentences.length ? sentences[i + 2] : null,
          found: true,
          continuation,
        }
      }
    }
    return { before: null, target: flat, after: null, found: false, continuation }
  }

  // When the content starts mid-word (continuation), sentences[0] is a truncated
  // fragment — don't use it as a before-sentence.
  const beforeIdx = targetIdx - 1
  const beforeSentence = beforeIdx >= 0 && !(continuation && beforeIdx === 0) ? sentences[beforeIdx] : null

  return {
    before: beforeSentence,
    target: sentences[targetIdx],
    after: targetIdx < sentences.length - 1 ? sentences[targetIdx + 1] : null,
    found: true,
    continuation,
  }
}

function buildChunkExcerpt (content, phrase) {
  const frag = document.createDocumentFragment()
  const { before, target, after, found, continuation } = extractHighlightContext(content, phrase)
  // Use the same normalization as extractHighlightContext so markHighlight can find the phrase
  const flatPhrase = phrase ? phrase.replace(/\s+/g, ' ').trim() : ''

  const mkSentence = (text, extra = '') => {
    const el = document.createElement('div')
    el.className = `source-chunk-sentence${extra ? ' ' + extra : ''}`
    el.textContent = text
    return el
  }
  const mkEllipsis = () => {
    const el = document.createElement('div')
    el.className = 'source-chunk-ellipsis'
    el.textContent = '…'
    return el
  }

  if (continuation || before) frag.appendChild(mkEllipsis())
  if (before) frag.appendChild(mkSentence(before))

  const targetEl = document.createElement('div')
  targetEl.className = 'source-chunk-sentence is-target'
  if (found && flatPhrase) {
    targetEl.appendChild(markHighlight(target, flatPhrase))
  } else {
    targetEl.textContent = target
  }
  frag.appendChild(targetEl)

  if (after) {
    frag.appendChild(mkSentence(after))
    frag.appendChild(mkEllipsis())
  }

  return frag
}

function renderSourcesPanel (ui) {
  ui.sourcePanelEl.innerHTML = ''

  // Collect all source entries from sourcesEl (already routed there)
  const allSourceEntries = []
  for (const [, entryEl] of ui.entryEls) {
    // Only evidence entries — dedupe since source-group maps multiple entries to one el
    const entryId = entryEl.dataset?.entryId || entryEl.dataset?.openKey
    void entryId
  }

  // Walk the entries array directly — pick evidence variants
  const evidenceEntries = ui.data.entries.filter(e => getEntryVariant(e) === 'evidence')
  if (!evidenceEntries.length) return

  const groups = groupSourcesByDocument(evidenceEntries)

  // Find the entry with the best score (primary) to auto-scroll to
  let primaryEntry = evidenceEntries.reduce((best, e) => {
    const score = Number(e.raw?.rrf_score ?? 0)
    return score > Number(best.raw?.rrf_score ?? 0) ? e : best
  }, evidenceEntries[0])

  let primaryChunkEl = null

  for (const [docTitle, entries] of groups) {
    const col = document.createElement('div')
    col.className = 'source-column'
    col.dataset.docTitle = docTitle

    const colHeader = document.createElement('div')
    colHeader.className = 'source-column-header'
    colHeader.textContent = docTitle
    colHeader.title = docTitle
    col.appendChild(colHeader)

    const colBody = document.createElement('div')
    colBody.className = 'source-column-body'

    for (const entry of entries) {
      const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
      const chunk = document.createElement('div')
      chunk.className = 'source-chunk'
      chunk.dataset.chunkId = String(raw.chunk_id ?? entry.id ?? '')
      const isPrimary = entry === primaryEntry
      if (isPrimary) {
        chunk.dataset.isPrimary = 'true'
        primaryChunkEl = chunk
      }

      const sectionLabel = normalizeText(raw.section_header)
      const startLine = raw.start_line != null ? Number(raw.start_line) : null
      if (sectionLabel || startLine != null) {
        const sec = document.createElement('div')
        sec.className = 'source-chunk-section'
        const labelParts = []
        if (sectionLabel) labelParts.push(sectionLabel.replace(/^##\s*/, '§ '))
        if (startLine != null) labelParts.push(`Line ${startLine}`)
        sec.textContent = labelParts.join(' · ')
        chunk.appendChild(sec)
      }

      const content = normalizeText(raw.content) || normalizeText(entry.summary) || ''
      const highlight = normalizeText(raw.highlight_phrase) || ''

      const bodyEl = document.createElement('div')
      bodyEl.className = 'source-chunk-body'
      bodyEl.appendChild(buildChunkExcerpt(content, highlight))
      chunk.appendChild(bodyEl)

      const annotation = normalizeText(raw.annotation)
      if (annotation) {
        const annEl = document.createElement('div')
        annEl.className = 'source-chunk-annotation'
        annEl.textContent = annotation
        chunk.appendChild(annEl)
      }

      colBody.appendChild(chunk)
    }

    col.appendChild(colBody)
    ui.sourcePanelEl.appendChild(col)
  }

  // After DOM is ready, scroll primary chunk to center of its column
  if (primaryChunkEl) {
    requestAnimationFrame(() => {
      primaryChunkEl.scrollIntoView({ block: 'center', behavior: 'instant' })
    })
  }
}

function createSourceIndexEl (entries, ui) {
  const index = document.createElement('div')
  index.className = 'source-index'

  // Group by doc to get doc short-names, then one row per entry (section)
  for (const entry of entries) {
    const raw = entry.raw && typeof entry.raw === 'object' ? entry.raw : {}
    const docTitle = normalizeText(raw.title) || normalizeText(entry.subject?.label) || 'Source'
    const sectionLabel = normalizeText(raw.section_header)
    const rowLabel = sectionLabel ? sectionLabel.replace(/^##\s*/, '§ ') : docTitle

    // Short doc label — last segment after '—' or full title truncated
    const docShort = docTitle.includes('—')
      ? docTitle.split('—').at(-1).trim()
      : docTitle.length > 28 ? docTitle.slice(0, 28) + '…' : docTitle

    const row = document.createElement('div')
    row.className = 'source-index-row'
    row.dataset.docTitle = docTitle
    row.title = `${docTitle}${sectionLabel ? ' · ' + sectionLabel : ''}`

    const dot = document.createElement('span')
    dot.className = 'source-index-dot'
    row.appendChild(dot)

    const secEl = document.createElement('span')
    secEl.className = 'source-index-section'
    secEl.textContent = rowLabel
    row.appendChild(secEl)

    const docEl = document.createElement('span')
    docEl.className = 'source-index-doc'
    docEl.textContent = docShort
    row.appendChild(docEl)

    row.addEventListener('click', () => {
      // Scroll panel column into view
      const col = ui.sourcePanelEl.querySelector(`.source-column[data-doc-title="${CSS.escape(docTitle)}"]`)
      if (col) {
        col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' })
        // also try to scroll the specific chunk
        const chunkId = String(raw.chunk_id ?? entry.id ?? '')
        const chunk = chunkId
          ? col.querySelector(`.source-chunk[data-chunk-id="${CSS.escape(chunkId)}"]`)
          : null
        if (chunk) {
          const colBody = col.querySelector('.source-column-body')
          if (colBody) {
            chunk.scrollIntoView({ block: 'center', behavior: 'smooth' })
          }
        }
      }
      // Highlight active row
      for (const r of index.querySelectorAll('.source-index-row')) r.classList.remove('is-active')
      row.classList.add('is-active')
    })

    index.appendChild(row)
  }

  return index
}

function renderRunTimeline (ui) {
  const openStates = captureDetailOpenStates(ui.timelineEl)
  const openStatesSources = captureDetailOpenStates(ui.sourcesEl)
  for (const [k, v] of openStatesSources) openStates.set(k, v)
  ui.timelineEl.innerHTML = ''
  ui.sourcesEl.innerHTML = ''
  ui.entryEls.clear()

  for (let index = 0; index < ui.data.entries.length;) {
    const entry = ui.data.entries[index]
    const variant = getEntryVariant(entry)

    if (canOwnEvidenceGroup(entry)) {
      const entryEl = createEntryEl(entry)
      ui.entryEls.set(entry.id, entryEl)
      ui.timelineEl.appendChild(entryEl)

      const groupedEntries = []
      const deferredEntries = []
      let lookahead = index + 1

      while (lookahead < ui.data.entries.length) {
        const candidate = ui.data.entries[lookahead]
        const candidateVariant = getEntryVariant(candidate)

        if (candidateVariant === 'evidence') {
          groupedEntries.push(candidate)
          lookahead += 1
          continue
        }

        if (isDeferrableSourceBridge(candidate)) {
          deferredEntries.push(candidate)
          lookahead += 1
          continue
        }

        break
      }

      if (groupedEntries.length) {
        const sourceIndex = createSourceIndexEl(groupedEntries, ui)
        ui.sourcesEl.appendChild(sourceIndex)
        for (const groupedEntry of groupedEntries) ui.entryEls.set(groupedEntry.id, sourceIndex)

        for (const deferredEntry of deferredEntries) {
          const deferredEl = createEntryEl(deferredEntry)
          ui.entryEls.set(deferredEntry.id, deferredEl)
          ui.timelineEl.appendChild(deferredEl)
        }

        index = lookahead
        continue
      }

      index += 1
      continue
    }

    if (variant === 'evidence') {
      const groupedEntries = []
      while (index < ui.data.entries.length && getEntryVariant(ui.data.entries[index]) === 'evidence') {
        groupedEntries.push(ui.data.entries[index])
        index += 1
      }

      // map entry IDs for tracking but don't render full chronicle entries in sources column
      // the panel renders these via renderSourcesPanel; sources column gets the index
      const indexEl = createSourceIndexEl(groupedEntries, ui)
      for (const groupedEntry of groupedEntries) ui.entryEls.set(groupedEntry.id, indexEl)
      ui.sourcesEl.appendChild(indexEl)
      continue
    }

    const entryEl = createEntryEl(entry)
    // Dispatcher routing entries are internal plumbing — skip rendering in the timeline
    if (variant === 'transition') {
      ui.entryEls.set(entry.id, entryEl)
      index += 1
      continue
    }
    ui.entryEls.set(entry.id, entryEl)
    ui.timelineEl.appendChild(entryEl)

    index += 1
  }

  syncRunPlaceholder(ui)
  restoreDetailOpenStates(ui.timelineEl, openStates)
  restoreDetailOpenStates(ui.sourcesEl, openStates)
  renderSourcesPanel(ui)
}

function syncRunPlaceholder (ui) {
  const existing = ui.timelineEl.querySelector('.run-placeholder')
  if (ui.data.entries.length === 0) {
    if (!existing) {
      const placeholder = document.createElement('div')
      placeholder.className = 'run-placeholder'
      placeholder.textContent = 'Waiting for the first live chronicle entry…'
      ui.timelineEl.appendChild(placeholder)
    }
  } else {
    existing?.remove()
  }
}

function updateRunUi (ui) {
  ui.el.dataset.status = ui.data.status
  ui.statusEl.textContent = ui.data.status
  ui.statusEl.className = `run-state status-${ui.data.status}`
  ui.summaryEl.textContent = summarizeRun(ui.data)

  const metaParts = [
    timeStr(ui.data.startedAt),
    countLabel(ui.data.entries.length, 'entry', 'entries'),
  ]
  const duration = formatDuration(ui.data.startedAt, ui.data.endedAt || nowIso())
  if (duration) metaParts.push(duration)
  ui.metaEl.textContent = metaParts.join(' · ')
}

function mountRun (run) {
  const el = document.createElement('article')
  el.className = 'run-card'
  el.dataset.runId = run.runId

  const body = document.createElement('div')
  body.className = 'run-body'

  const header = document.createElement('div')
  header.className = 'run-header'

  const kicker = document.createElement('div')
  kicker.className = 'run-kicker'
  kicker.textContent = 'Run chronicle'

  const titleRow = document.createElement('div')
  titleRow.className = 'run-title-row'

  const title = document.createElement('div')
  title.className = 'run-title'
  title.textContent = currentAssistantName()

  const status = document.createElement('span')
  status.className = 'run-state'

  titleRow.append(title, status)

  const summary = document.createElement('div')
  summary.className = 'run-summary'

  const meta = document.createElement('div')
  meta.className = 'run-meta'

  header.append(kicker, titleRow, summary, meta)

  const timeline = document.createElement('div')
  timeline.className = 'run-timeline'

  body.append(header, timeline)

  const sources = document.createElement('div')
  sources.className = 'run-sources'

  const sourcePanel = document.createElement('div')
  sourcePanel.className = 'run-sources-panel'

  el.append(body, sources, sourcePanel)

  const ui = {
    data: run,
    el,
    statusEl: status,
    summaryEl: summary,
    metaEl: meta,
    timelineEl: timeline,
    sourcesEl: sources,
    sourcePanelEl: sourcePanel,
    entryEls: new Map(),
  }

  renderRunTimeline(ui)
  updateRunUi(ui)
  return ui
}

function upsertRunEntry (ui, entry, shouldPersist = true) {
  const normalized = normalizeEntry(entry)
  if (!normalized) return null

  const existingIdx = ui.data.entries.findIndex(item => item.id === normalized.id)
  if (existingIdx === -1) ui.data.entries.push(normalized)
  else ui.data.entries[existingIdx] = normalized

  renderRunTimeline(ui)
  updateRunUi(ui)
  scrollToBottom()
  if (shouldPersist) schedulePersist()
  return normalized
}

function buildDeliverEntry (run) {
  const seq = run.entries.reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) + 1
  return normalizeEntry({
    id: `${run.runId}:deliver`,
    seq,
    mode: 'deliver',
    subject: { kind: 'session', label: currentAssistantName() },
    status: 'live',
    summary: 'Drafting answer',
    ts_start: nowIso(),
    ts_end: nowIso(),
    blocks: [{ type: 'paragraph', text: '' }],
    refs: [],
    raw: { synthetic: true },
  })
}

function ensureDeliverEntry (ui) {
  const existing = ui.data.entries.find(entry => entry.id === `${ui.data.runId}:deliver`)
  if (existing) return existing
  const created = buildDeliverEntry(ui.data)
  upsertRunEntry(ui, created, false)
  return created
}

function getPrimaryParagraph (entry) {
  let block = entry.blocks.find(candidate => candidate.type === 'paragraph')
  if (!block) {
    block = { type: 'paragraph', text: '' }
    entry.blocks.push(block)
  }
  return block
}

function appendDeliverToken (token) {
  if (!currentRun) return
  const entry = ensureDeliverEntry(currentRun)
  const paragraph = getPrimaryParagraph(entry)
  paragraph.text = `${paragraph.text ?? ''}${token ?? ''}`
  entry.status = 'live'
  entry.summary = 'Drafting answer'
  entry.ts_end = nowIso()
  upsertRunEntry(currentRun, entry)
}

function setDeliverResponse (content) {
  if (!currentRun) return
  const entry = ensureDeliverEntry(currentRun)
  const paragraph = getPrimaryParagraph(entry)
  paragraph.text = `${content ?? ''}`
  entry.status = currentRun.data.status === 'error' ? 'error' : 'live'
  entry.summary = normalizeText(content) ? 'Delivered answer' : 'Drafting answer'
  entry.ts_end = nowIso()
  upsertRunEntry(currentRun, entry)
}

function markRunComplete (status = 'done', endedAt = nowIso()) {
  if (!currentRun) return
  currentRun.data.status = normalizeText(status) || 'done'
  currentRun.data.endedAt = normalizeText(endedAt) || nowIso()

  const deliver = currentRun.data.entries.find(entry => entry.id === `${currentRun.data.runId}:deliver`)
  if (deliver) {
    deliver.status = currentRun.data.status
    deliver.summary = currentRun.data.status === 'error' ? 'Run failed' : 'Delivered answer'
    deliver.ts_end = currentRun.data.endedAt
    upsertRunEntry(currentRun, deliver, false)
  }

  updateRunUi(currentRun)
  schedulePersist()
}

function createFallbackErrorEntry (message) {
  return normalizeEntry({
    id: `${activeRequestId}:renderer-error`,
    mode: 'observe',
    subject: { kind: 'session', label: 'Renderer' },
    status: 'error',
    summary: normalizeText(message) || 'Desktop error',
    ts_start: nowIso(),
    ts_end: nowIso(),
    blocks: [{ type: 'paragraph', text: normalizeText(message) || 'Desktop error' }],
    refs: [],
    raw: { source: 'renderer' },
  })
}

function renderSessionItem (item, captureRun = false) {
  const empty = messagesEl.querySelector('#empty-state')
  if (empty) empty.remove()

  if (item.kind === 'run') {
    const ui = mountRun(item)
    messagesEl.appendChild(ui.el)
    if (captureRun) currentRun = ui
    scrollToBottom()
    return ui
  }

  const messageEl = createMessageEl(item)
  messagesEl.appendChild(messageEl)
  scrollToBottom()
  return messageEl
}

function renderCurrentSession () {
  messagesEl.innerHTML = ''
  currentRun = null
  const session = getOrCreateSession(sessionId)
  if (!session.items.length) {
    renderEmptyState()
    return
  }

  for (const item of session.items) renderSessionItem(item, false)
  scrollToBottom()
}

function renderHistorySidebar () {
  historyList.innerHTML = ''
  for (const [sid, session] of [...sessions.entries()].reverse()) {
    if (!session.items.length) continue
    const firstUser = session.items.find(item => item.kind === 'message' && item.role === 'user')

    const button = document.createElement('button')
    button.type = 'button'
    button.className = `history-item${sid === sessionId ? ' active' : ''}`
    button.textContent = truncateText(firstUser?.content || 'New chat', 40) || 'New chat'
    button.addEventListener('click', () => switchSession(sid))
    historyList.appendChild(button)
  }
}

function switchSession (sid) {
  if (isStreaming || sid === sessionId) return
  flushPersist()
  sessionId = sid
  renderCurrentSession()
  renderHistorySidebar()
}

function appendUserMessage (content) {
  const item = normalizeMessageItem({ role: 'user', content, ts: nowIso() })
  getOrCreateSession(sessionId).items.push(item)
  renderSessionItem(item, false)
  schedulePersist()
  return item
}

function appendRunRecord (runId) {
  const run = normalizeRunItem({
    kind: 'run',
    runId,
    status: 'live',
    startedAt: nowIso(),
    entries: [],
  })
  getOrCreateSession(sessionId).items.push(run)
  const ui = renderSessionItem(run, true)
  schedulePersist()
  return ui
}

function setStreaming (value) {
  isStreaming = value
  sendBtn.disabled = value
  inputEl.disabled = value
}

function setStatus (message, autoClearMs = 0) {
  const text = normalizeText(message)
  statusBar.textContent = text
  if (autoClearMs > 0) {
    setTimeout(() => {
      if (statusBar.textContent === text) statusBar.textContent = ''
    }, autoClearMs)
  }
}

function finishStreaming () {
  setStreaming(false)
  activeRequestId = null
  currentRun = null
  setStatus('')
  flushPersist()
}

function scrollToBottom () {
  scrollElementToBottom(messagesEl)
}

function autoResizeInput () {
  inputEl.style.height = 'auto'
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 180)}px`
}

newChatBtn.addEventListener('click', () => {
  if (isStreaming) return
  flushPersist()
  sessionId = newSessionId()
  getOrCreateSession(sessionId)
  renderCurrentSession()
  renderHistorySidebar()
})

clearHistoryBtn.addEventListener('click', async () => {
  if (isStreaming) return
  // Clear all turns for this user so cross-session global history doesn't bleed through
  await window.amphion.clearAllConversations('default')
  sessions.set(sessionId, { items: [] })
  renderCurrentSession()
  renderHistorySidebar()
  flushPersist()
  setStatus('Conversation history cleared.', 2500)
})

formEl.addEventListener('submit', async (e) => {
  e.preventDefault()
  const message = normalizeText(inputEl.value)
  if (!message || isStreaming) return

  activeRequestId = newRequestId()
  setStreaming(true)
  inputEl.value = ''
  autoResizeInput()

  appendUserMessage(message)
  appendRunRecord(activeRequestId)

  const result = await window.amphion.query(message, sessionId, activeRequestId, handleEvent, 'default', null)

  if (!result.ok && !result.cancelled) {
    if (currentRun) {
      currentRun.data.error = result.error
      upsertRunEntry(currentRun, createFallbackErrorEntry(result.error))
      markRunComplete('error')
    }
    finishStreaming()
  } else if (isStreaming) {
    setTimeout(() => {
      if (isStreaming) finishStreaming()
    }, 5000)
  }
})

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    formEl.dispatchEvent(new Event('submit'))
  }
})
inputEl.addEventListener('input', autoResizeInput)

function handleEvent (event) {
  if (!isStreaming) return
  if (!activeRequestId || event?.requestId !== activeRequestId) return

  try {
    handleEventInner(event)
  } catch (err) {
    console.error('[app] handleEvent error:', err)
  }
}

function handleEventInner (event) {
  switch (event.type) {
    case 'run_start':
      if (currentRun) {
        currentRun.data.remoteRunId = normalizeText(event.runId) || currentRun.data.remoteRunId
        currentRun.data.startedAt = normalizeText(event.startedAt) || currentRun.data.startedAt
        updateRunUi(currentRun)
        schedulePersist()
      }
      break

    case 'status':
      setStatus(event.message)
      break

    case 'chronicle_entry':
      if (currentRun && event.entry) upsertRunEntry(currentRun, event.entry)
      break

    case 'token':
      appendDeliverToken(event.token)
      break

    case 'response':
      setDeliverResponse(event.content)
      break

    case 'error':
      setStatus(event.message)
      if (currentRun) currentRun.data.error = normalizeText(event.message) || currentRun.data.error
      break

    case 'run_done':
      if (currentRun) {
        if (event.runId) currentRun.data.remoteRunId = normalizeText(event.runId) || currentRun.data.remoteRunId
        if (normalizeText(event.status) === 'error' && !currentRun.data.error) {
          currentRun.data.error = 'Pipeline error'
        }
        markRunComplete(normalizeText(event.status) || 'done', event.endedAt)
      }
      break

    case 'done':
      finishStreaming()
      break
  }
}

const attachBtn = document.getElementById('attach-btn')
const ingestPopover = document.getElementById('ingest-popover')
const ingestClose = document.getElementById('ingest-close')
const ingestTargetNote = document.getElementById('ingest-target-note')
const learnRequestEl = document.getElementById('learn-request')
const learnUrlEl = document.getElementById('learn-url')
const learnUrlBtn = document.getElementById('learn-url-btn')
const learnFileBtn = document.getElementById('learn-file-btn')
const learnRefreshBtn = document.getElementById('learn-refresh-btn')
const learnPlansEmpty = document.getElementById('learn-plans-empty')
const learnPlansList = document.getElementById('learn-plans-list')
const ingestUrlEl = document.getElementById('ingest-url')
const ingestUrlBtn = document.getElementById('ingest-url-btn')
const ingestFileBtn = document.getElementById('ingest-file-btn')
const ingestCorpusEl = document.getElementById('ingest-corpus')
const ingestDropHint = document.getElementById('ingest-drop-hint')
const ingestFeedback = document.getElementById('ingest-feedback')
const dropOverlay = document.getElementById('drop-overlay')
const dropLabel = document.getElementById('drop-label')

function getSavedIngestCorpus () {
  try {
    return normalizeText(localStorage.getItem(INGEST_CORPUS_KEY)) || DEFAULT_INGEST_CORPUS
  } catch {
    return DEFAULT_INGEST_CORPUS
  }
}

function getActiveIngestCorpus () {
  return normalizeText(ingestCorpusEl?.value) || DEFAULT_INGEST_CORPUS
}

function syncIngestTargetUi (corpus = getActiveIngestCorpus()) {
  const targetCorpus = normalizeText(corpus) || DEFAULT_INGEST_CORPUS
  if (ingestCorpusEl && document.activeElement !== ingestCorpusEl) ingestCorpusEl.value = targetCorpus
  if (ingestTargetNote) ingestTargetNote.textContent = `Learn runs and direct add will use the ${targetCorpus} corpus.`
  if (ingestDropHint) ingestDropHint.textContent = `drag and drop local files to add directly to the ${targetCorpus} corpus`
  if (dropLabel) dropLabel.textContent = `Drop files to add to ${targetCorpus}`
  return targetCorpus
}

function setActiveIngestCorpus (corpus) {
  const targetCorpus = normalizeText(corpus) || DEFAULT_INGEST_CORPUS
  if (ingestCorpusEl) ingestCorpusEl.value = targetCorpus
  try { localStorage.setItem(INGEST_CORPUS_KEY, targetCorpus) } catch {}
  syncIngestTargetUi(targetCorpus)
  return targetCorpus
}

function showIngestPopover () {
  ingestPopover.classList.remove('hidden')
  if (learnRequestEl) learnRequestEl.value = ''
  if (learnUrlEl) learnUrlEl.value = ''
  ingestUrlEl.value = ''
  ingestFeedback.textContent = ''
  ingestFeedback.className = ''
  syncIngestTargetUi()
  learnRequestEl?.focus()
  refreshLearnPlans({ silent: false })
}

function hideIngestPopover () {
  ingestPopover.classList.add('hidden')
}

function setIngestFeedback (message, isError = false) {
  ingestFeedback.textContent = message
  ingestFeedback.className = isError ? 'ingest-error' : 'ingest-ok'
}

function getLearnRequestValue () {
  return normalizeText(learnRequestEl?.value)
}

function requireLearnRequest () {
  const request = getLearnRequestValue()
  if (request) return request
  setIngestFeedback('Enter a learn request first.', true)
  learnRequestEl?.focus()
  return null
}

function planStatusLabel (plan) {
  return normalizeText(plan?.status) || 'pending'
}

function planTargetCorpus (plan) {
  return normalizeText(plan?.target_corpus ?? plan?.metadata?.targetCorpus ?? plan?.findings?.target_corpus)
}

function planMetaText (plan) {
  const staged = plan?.staged_summary ?? {}
  const parts = []
  const corpus = planTargetCorpus(plan)
  if (corpus) parts.push(corpus)
  if (staged.review_count > 0) parts.push(`${staged.review_count} awaiting review`)
  if (staged.pending_count > 0 || staged.scanning_count > 0) parts.push(`${staged.pending_count + staged.scanning_count} processing`)
  if (staged.approved_count > 0) parts.push(`${staged.approved_count} approved`)
  if (staged.rejected_count > 0) parts.push(`${staged.rejected_count} rejected`)
  if (staged.ingested_count > 0) parts.push(`${staged.ingested_count} ingested`)
  return parts.join(' · ')
}

function canDecidePlan (plan) {
  const reviewCount = plan?.staged_summary?.review_count ?? 0
  return planStatusLabel(plan) === 'pending' && reviewCount > 0
}

function renderLearnPlans (plans = []) {
  learnPlansList?.replaceChildren()

  if (!plans.length) {
    if (learnPlansEmpty) {
      learnPlansEmpty.textContent = 'No pending learn batches.'
      learnPlansEmpty.classList.remove('hidden')
    }
    return
  }

  learnPlansEmpty?.classList.add('hidden')
  for (const plan of plans) {
    const card = document.createElement('div')
    card.className = 'learn-plan-card'

    const header = document.createElement('div')
    header.className = 'learn-plan-header'

    const title = document.createElement('div')
    title.className = 'learn-plan-title'
    title.textContent = truncateText(normalizeText(plan.title) || normalizeText(plan.request) || 'Untitled learn batch', 96)

    const status = document.createElement('span')
    const statusValue = planStatusLabel(plan)
    status.className = `learn-plan-status ${statusValue}`
    status.textContent = statusValue

    header.append(title, status)

    const summary = document.createElement('div')
    summary.className = 'learn-plan-summary'
    summary.textContent = truncateText(normalizeText(plan.summary) || 'No summary yet.', 180)

    const meta = document.createElement('div')
    meta.className = 'learn-plan-meta'
    meta.textContent = planMetaText(plan) || 'No staged files yet.'

    card.append(header, summary, meta)

    if (canDecidePlan(plan)) {
      const actions = document.createElement('div')
      actions.className = 'learn-plan-actions'

      const approveBtn = document.createElement('button')
      approveBtn.className = 'learn-plan-btn approve'
      approveBtn.textContent = 'Approve Batch'

      const rejectBtn = document.createElement('button')
      rejectBtn.className = 'learn-plan-btn reject'
      rejectBtn.textContent = 'Reject Batch'

      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true
        rejectBtn.disabled = true
        await decideLearnPlan(plan.id, 'approve')
      })
      rejectBtn.addEventListener('click', async () => {
        approveBtn.disabled = true
        rejectBtn.disabled = true
        await decideLearnPlan(plan.id, 'reject')
      })

      actions.append(approveBtn, rejectBtn)
      card.append(actions)
    } else {
      const note = document.createElement('div')
      note.className = 'learn-plan-note'
      note.textContent = statusValue === 'draft'
        ? 'Add sources to this learn request before it can be reviewed.'
        : 'No batch decision is available right now.'
      card.append(note)
    }

    learnPlansList?.append(card)
  }
}

async function refreshLearnPlans ({ silent = true } = {}) {
  if (!learnPlansList) return
  if (!silent && learnPlansEmpty) {
    learnPlansEmpty.textContent = 'Loading learn batches...'
    learnPlansEmpty.classList.remove('hidden')
  }
  if (learnRefreshBtn) learnRefreshBtn.disabled = true
  try {
    const response = await window.atlasApp.learnPlans('pending,draft', 10)
    if (!response?.ok) throw new Error(response?.error ?? 'Could not load learn batches.')
    renderLearnPlans(response.plans ?? [])
  } catch (err) {
    learnPlansList?.replaceChildren()
    if (learnPlansEmpty) {
      learnPlansEmpty.textContent = 'Could not load learn batches.'
      learnPlansEmpty.classList.remove('hidden')
    }
    setIngestFeedback(err.message, true)
  } finally {
    if (learnRefreshBtn) learnRefreshBtn.disabled = false
  }
}

async function decideLearnPlan (planId, decision) {
  const verb = decision === 'approve' ? 'Approving' : 'Rejecting'
  setIngestFeedback(`${verb} batch...`)
  try {
    const response = await window.atlasApp.learnPlanDecide(planId, decision)
    if (!response?.ok) throw new Error(response?.error ?? 'Learn batch decision failed.')
    setIngestFeedback(response.message ?? 'Learn batch updated.')
    setStatus(response.message ?? 'Learn batch updated.', 4000)
    await refreshLearnPlans({ silent: true })
  } catch (err) {
    setIngestFeedback(err.message, true)
    await refreshLearnPlans({ silent: true })
  }
}

setActiveIngestCorpus(getSavedIngestCorpus())
ingestCorpusEl?.addEventListener('input', () => syncIngestTargetUi(getActiveIngestCorpus()))
ingestCorpusEl?.addEventListener('change', () => { setActiveIngestCorpus(ingestCorpusEl.value) })
ingestCorpusEl?.addEventListener('blur', () => { setActiveIngestCorpus(ingestCorpusEl.value) })

attachBtn.addEventListener('click', () => {
  ingestPopover.classList.contains('hidden') ? showIngestPopover() : hideIngestPopover()
})

ingestClose.addEventListener('click', hideIngestPopover)

learnRefreshBtn?.addEventListener('click', () => refreshLearnPlans({ silent: false }))

learnUrlBtn?.addEventListener('click', async () => {
  const request = requireLearnRequest()
  const url = normalizeText(learnUrlEl?.value)
  if (!request || !url) {
    if (!url) setIngestFeedback('Enter a direct source URL for the learn batch.', true)
    return
  }

  const targetCorpus = setActiveIngestCorpus(getActiveIngestCorpus())
  learnUrlBtn.disabled = true
  setIngestFeedback('Running learn batch...')
  try {
    const response = await window.atlasApp.learnPlanRun({
      request,
      title: truncateText(request, 96),
      corpus: targetCorpus,
      urls: [url],
    })
    if (!response?.ok) throw new Error(response?.error ?? 'Learn batch failed.')

    const message = response.plan?.summary ?? response.message ?? 'Learn batch updated.'
    setIngestFeedback(message)
    setStatus(message, 5000)
    if (learnUrlEl) learnUrlEl.value = ''
    await refreshLearnPlans({ silent: true })
  } catch (err) {
    setIngestFeedback(err.message, true)
  } finally {
    learnUrlBtn.disabled = false
  }
})

learnUrlEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    learnUrlBtn?.click()
  }
})

learnFileBtn?.addEventListener('click', async () => {
  const request = requireLearnRequest()
  if (!request) return

  const targetCorpus = setActiveIngestCorpus(getActiveIngestCorpus())
  learnFileBtn.disabled = true
  setIngestFeedback('Choose files or folders for the learn batch...')
  try {
    const response = await window.atlasApp.learnFilePicker(request, targetCorpus, truncateText(request, 96))
    if (!response || response.cancelled) {
      setIngestFeedback('Learn batch file selection cancelled.')
      return
    }
    if (!response.ok) throw new Error(response.error ?? 'Learn batch failed.')

    const message = response.plan?.summary ?? response.message ?? 'Learn batch updated.'
    setIngestFeedback(message)
    setStatus(message, 5000)
    await refreshLearnPlans({ silent: true })
  } catch (err) {
    setIngestFeedback(err.message, true)
  } finally {
    learnFileBtn.disabled = false
  }
})

ingestUrlBtn.addEventListener('click', async () => {
  const url = normalizeText(ingestUrlEl.value)
  if (!url) return
  const targetCorpus = setActiveIngestCorpus(getActiveIngestCorpus())
  ingestUrlBtn.disabled = true
  setIngestFeedback('Fetching...')
  try {
    const response = await window.atlasApp.stageUrl(url, targetCorpus)
    if (response.ok) {
      setIngestFeedback(`Queued for ${targetCorpus}: ${response.filename ?? url}`)
      ingestUrlEl.value = ''
    } else {
      setIngestFeedback(response.error ?? 'Failed', true)
    }
  } catch (err) {
    setIngestFeedback(err.message, true)
  } finally {
    ingestUrlBtn.disabled = false
  }
})

ingestUrlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ingestUrlBtn.click()
})

ingestFileBtn.addEventListener('click', async () => {
  const targetCorpus = setActiveIngestCorpus(getActiveIngestCorpus())
  hideIngestPopover()
  const response = await window.atlasApp.stageFilePicker(targetCorpus)
  if (!response || response.cancelled) return
  const ok = response.results?.filter(result => result.ok).length ?? 0
  const fail = response.results?.filter(result => !result.ok).length ?? 0
  const parts = []
  if (ok) parts.push(`${ok} file${ok !== 1 ? 's' : ''} indexed into ${targetCorpus}`)
  if (fail) parts.push(`${fail} failed`)
  if (parts.length) setStatus(parts.join(', '), 4000)
})

let dragCounter = 0

document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return
  dragCounter++
  dropOverlay.classList.remove('hidden')
})

document.addEventListener('dragleave', () => {
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    dropOverlay.classList.add('hidden')
  }
})

document.addEventListener('dragover', (e) => { e.preventDefault() })

document.addEventListener('drop', async (e) => {
  e.preventDefault()
  dragCounter = 0
  dropOverlay.classList.add('hidden')

  const files = [...(e.dataTransfer?.files ?? [])]
  if (!files.length) return
  const targetCorpus = setActiveIngestCorpus(getActiveIngestCorpus())

  let ok = 0
  let fail = 0

  for (const file of files) {
    const filePath = file.path
    if (!filePath) {
      fail++
      continue
    }
    try {
      const response = await window.atlasApp.stageLocalPath(filePath, targetCorpus)
      response.ok ? ok++ : fail++
    } catch {
      fail++
    }
  }

  const parts = []
  if (ok) parts.push(`${ok} file${ok !== 1 ? 's' : ''} indexed into ${targetCorpus}`)
  if (fail) parts.push(`${fail} failed`)
  if (parts.length) setStatus(parts.join(', '), 4000)
})

if (!sessions.has(sessionId)) sessions.set(sessionId, { items: [] })
renderCurrentSession()
renderHistorySidebar()
autoResizeInput()

})()
