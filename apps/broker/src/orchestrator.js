/**
 * apps/broker/src/orchestrator.js
 *
 * Modality-based orchestration. Retrieval and memory stay on the universal
 * Resource agent. Only draft requests branch to thin specialist adapters.
 */

import { runAgent } from './agent-runner.js'

const MAX_KNOWLEDGE_ATTEMPTS = 3

export async function orchestrate (jobTicket, originalMessage, context, trace, emit) {
  const modality = jobTicket.modality ?? 'retrieve'
  const agentContext = { ...context, originalMessage }

  if (modality === 'conversation') {
    return {
      general: stubResult('general', 'No resource lookup is required. Answer directly and concisely.'),
    }
  }

  if (modality === 'act') {
    return {
      general: stubResult('general', 'This request requires an external action adapter that is not implemented yet.'),
    }
  }

  if (modality === 'draft') {
    const domain = chooseExecutionPath(jobTicket, originalMessage)
    const task = buildTask(jobTicket, originalMessage, domain)

    if (!shouldUseDraftSupport(jobTicket, originalMessage, domain)) {
      const result = await runWithRetry(domain, task, agentContext, trace, emit, jobTicket)
      return { [domain]: result }
    }

    const supportModality = chooseDraftSupportModality(jobTicket, originalMessage)
    const supportTicket = { ...jobTicket, modality: supportModality }
    const knowledgeTask = buildTask(supportTicket, originalMessage, 'knowledge')
    const support = await runWithRetry('knowledge', knowledgeTask, agentContext, trace, emit, supportTicket)
    const result = await runWithRetry(domain, task, { ...agentContext, resourceSupport: support }, trace, emit, jobTicket)

    if (support.success && Array.isArray(support.items) && support.items.length > 0) {
      return { knowledge: support, [domain]: result }
    }
    return { [domain]: result }
  }

  const domain = chooseExecutionPath(jobTicket, originalMessage)
  const task = buildTask(jobTicket, originalMessage, domain)
  const result = await runWithRetry(domain, task, agentContext, trace, emit, jobTicket)
  return { [domain]: result }
}

export function chooseExecutionPath (jobTicket, message) {
  if (jobTicket.modality === 'draft') {
    if (/\b(proposal|rfp|pitch|bid)\b/i.test(message)) return 'proposals'
    return 'comms'
  }
  return 'knowledge'
}

function buildTask (jobTicket, originalMessage, domain) {
  if (domain === 'knowledge') {
    const rememberHint = jobTicket.modality === 'remember'
      ? 'This is a remember request: search conversation records as resources when useful.'
      : 'This is a retrieve request: inform yourself from resources, then stop when sufficient.'
    return [
      `Intent: ${jobTicket.intent ?? originalMessage}`,
      `Topic: ${jobTicket.topic ?? originalMessage}`,
      `Original request: ${originalMessage}`,
      rememberHint,
      `If the request contains multiple distinct questions, topics, or corpora, gather evidence for each one before you reflect or stop.`,
      `Use only recall, find, load, and reflect.`,
    ].join('\n')
  }
  if (jobTicket.modality === 'draft') {
    return originalMessage
  }
  return [
    `Intent: ${jobTicket.intent ?? originalMessage}`,
    `Topic/context: ${jobTicket.topic ?? originalMessage}`,
    `Original request: ${originalMessage}`,
  ].join('\n')
}

function chooseDraftSupportModality (jobTicket, message) {
  const text = `${jobTicket?.topic ?? ''}\n${message ?? ''}`
  if (/\b(remember|recall|last time|previously|earlier|our call|last call|phone call|meeting|met|follow up|follow-up|discussed|talked about|notes?)\b/i.test(text)) {
    return 'remember'
  }
  return 'retrieve'
}

function shouldUseDraftSupport (jobTicket, message, domain) {
  const text = `${jobTicket?.topic ?? ''}\n${message ?? ''}`
  return /\b(based on|using|use the|from the attached|from this file|from these files|from this document|from these documents|from our notes|from the notes|include the details|use the details|summarize our conversation|summarize the meeting|grounded in|cite|quote|reference|attached|attachment|notes from)\b/i.test(text)
}

async function runWithRetry (domain, task, context, trace, emit, jobTicket) {
  const result = await runAgent(domain, task, context, trace, emit, jobTicket)
  if (domain !== 'knowledge') return result

  const attemptedQueries = [task]
  let current = result
  let currentQuery = task

  for (let attempt = 1; attempt < MAX_KNOWLEDGE_ATTEMPTS; attempt++) {
    const decision = getKnowledgeRetryDecision(currentQuery, current, jobTicket, attemptedQueries)
    emitVerification(emit, {
      attempt,
      query: currentQuery,
      verdict: decision.verdict,
      shouldRetry: decision.shouldRetry,
      rationale: decision.rationale,
      nextQuery: decision.nextQuery,
    })

    if (!decision.shouldRetry || !decision.nextQuery || attemptedQueries.includes(decision.nextQuery)) break

    console.log(`[orchestrator] knowledge weak — retrying topic: "${decision.nextQuery.slice(0, 120)}"`)
    attemptedQueries.push(decision.nextQuery)
    emitVerification(emit, {
      attempt: attempt + 1,
      phase: 'retry',
      query: decision.nextQuery,
      previousQuery: currentQuery,
      verdict: decision.verdict,
      shouldRetry: true,
      rationale: decision.rationale,
    })

    const retry = await runAgent('knowledge', decision.nextQuery, context, trace, emit, jobTicket)
    current = selectKnowledgeResult(current, retry, attemptedQueries)
    currentQuery = decision.nextQuery
  }

  current.triedQueries = attemptedQueries
  return current
}

function getKnowledgeRetryDecision (task, result, jobTicket, attemptedQueries = []) {
  const empty = !result.success || result.foundNothing || (Array.isArray(result.items) && result.items.length === 0 && !result.summary?.trim())
  const simplified = simplifyRetryQuery(jobTicket?.topic ?? task)
  const verification = result.verification ?? null
  const candidateQueries = buildKnowledgeRetryCandidates({ task, jobTicket, simplified, verification, attemptedQueries })
  const nextCandidate = candidateQueries[0] ?? null

  if (verification?.shouldRetry) {
    return {
      verdict: verification.verdict ?? 'insufficient',
      shouldRetry: Boolean(nextCandidate),
      rationale: verification.rationale ?? 'Retrieved evidence was too weak to support an answer.',
      nextQuery: nextCandidate,
    }
  }

  if (verification && verification.verdict && verification.verdict !== 'supported' && nextCandidate) {
    return {
      verdict: verification.verdict,
      shouldRetry: true,
      rationale: verification.rationale ?? 'Retrieved evidence was too weak to support an answer.',
      nextQuery: nextCandidate,
    }
  }

  if (empty && nextCandidate) {
    return {
      verdict: verification?.verdict ?? 'insufficient',
      shouldRetry: true,
      rationale: verification?.rationale ?? 'No evidence was retrieved on the first query.',
      nextQuery: nextCandidate,
    }
  }

  return {
    verdict: verification?.verdict ?? (empty ? 'insufficient' : 'supported'),
    shouldRetry: false,
    rationale: verification?.rationale ?? (empty ? 'No retry query was available.' : 'Evidence is sufficient enough to continue.'),
    nextQuery: null,
  }
}

function selectKnowledgeResult (initial, retry, attemptedQueries) {
  const retryVerdict = retry.verification?.verdict ?? 'insufficient'
  const initialVerdict = initial.verification?.verdict ?? 'insufficient'
  const retryHasEvidence = retry.success && !retry.foundNothing && (retry.items?.length ?? 0) > 0

  retry.triedQueries = attemptedQueries
  // Don't automatically prefer a 'supported' retry when the initial already
  // identified a topic_mismatch — the retry may have found tangential content
  // that tricks the verification model into saying 'supported'.
  if (retryVerdict === 'supported' && initialVerdict === 'topic_mismatch') {
    // Only upgrade if the retry found substantially more evidence (2x or more)
    const retryCount = retry.items?.length ?? 0
    const initialCount = initial.items?.length ?? 0
    if (retryCount < initialCount * 2 || retryCount < 4) {
      return { ...initial, triedQueries: attemptedQueries, verification: { ...(initial.verification ?? {}), shouldRetry: false } }
    }
  }
  if (retryVerdict === 'supported' && initialVerdict !== 'supported') return retry
  if (retryVerdict === 'supported') return retry
  if (retryHasEvidence && (retry.items?.length ?? 0) > (initial.items?.length ?? 0)) return retry

  return {
    ...initial,
    triedQueries: attemptedQueries,
    verification: {
      ...(retry.verification ?? initial.verification ?? {}),
      shouldRetry: false,
      rationale: retryHasEvidence
        ? retry.verification?.rationale ?? initial.verification?.rationale ?? 'Evidence remained weak after retry.'
        : initial.verification?.rationale ?? retry.verification?.rationale ?? 'Evidence remained weak after retry.',
    },
  }
}

function simplifyRetryQuery (query) {
  return `${query ?? ''}`
    .replace(/"[^"]*"/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function buildKnowledgeRetryCandidates ({ task, jobTicket, simplified, verification, attemptedQueries = [] }) {
  const attempted = new Set(attemptedQueries)
  const originalRequest = extractKnowledgeOriginalRequest(task)
  const dispatcherTopic = `${jobTicket?.topic ?? ''}`.trim()
  const seedTerms = new Set(extractRetryTerms(`${dispatcherTopic} ${originalRequest}`))
  const candidates = []

  const addCandidate = query => {
    const normalized = normalizeRetryCandidate(query)
    if (!normalized || attempted.has(normalized) || candidates.includes(normalized)) return
    candidates.push(normalized)
  }

  if (simplified && simplified !== task) addCandidate(simplified)

  const focused = buildFocusedRetryQuery(originalRequest, dispatcherTopic)
  addCandidate(focused)

  if (isAnchoredRetryQuery(verification?.nextQuery, seedTerms) && isScopeCompatibleRetryQuery(verification?.nextQuery, originalRequest, dispatcherTopic)) {
    addCandidate(verification.nextQuery)
  }

  if (isAnchoredRetryQuery(originalRequest, seedTerms)) addCandidate(originalRequest)

  return candidates
}

function normalizeRetryCandidate (query) {
  return `${query ?? ''}`
    .replace(/\s+/g, ' ')
    .trim()
}

function extractKnowledgeOriginalRequest (task) {
  const text = `${task ?? ''}`
  return text.match(/Original request:\s*(.+)/i)?.[1]?.trim()
    ?? text.match(/Topic(?:\/context)?:\s*(.+)/i)?.[1]?.trim()
    ?? text.trim()
}

function extractRetryTerms (text) {
  return `${text ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
    .filter(term => !RETRY_STOP_WORDS.has(term))
}

function isAnchoredRetryQuery (query, seedTerms) {
  const terms = extractRetryTerms(query)
  if (terms.length === 0 || !seedTerms || seedTerms.size === 0) return false
  const overlap = [...new Set(terms)].filter(term => seedTerms.has(term))
  return overlap.length >= 2 || overlap.some(term => term.length >= 8)
}

function isScopeCompatibleRetryQuery (query, originalRequest, dispatcherTopic) {
  const candidate = `${query ?? ''}`.toLowerCase()
  const seed = `${originalRequest ?? ''} ${dispatcherTopic ?? ''}`.toLowerCase()

  const wantsNational = /\b(country|nationwide|national|united states|u\.s\.|usa|across the country)\b/.test(seed)
  const candidateStateSpecific = /\bwashington state|state law|state laws|state regulations\b/.test(candidate)
  if (wantsNational && candidateStateSpecific && !/\bwashington state\b/.test(seed)) return false

  return true
}

function buildFocusedRetryQuery (originalRequest, dispatcherTopic) {
  const baseTerms = [...new Set(extractRetryTerms(`${dispatcherTopic} ${originalRequest}`))]
    .filter(term => !RETRY_GENERIC_FACETS.has(term))

  const additions = []
  if (baseTerms.includes('interstate') || baseTerms.includes('interstates')) additions.push('highway', 'highways', 'transportation')
  if (baseTerms.includes('country') || baseTerms.includes('nationwide')) additions.push('united', 'states')
  if (baseTerms.includes('reservation') || baseTerms.includes('reservations')) additions.push('tribal')
  if (baseTerms.includes('iraq')) additions.push('war')

  const combined = [...new Set([...baseTerms, ...additions])]
  return combined.slice(0, 10).join(' ')
}

const RETRY_STOP_WORDS = new Set([
  'what', 'about', 'tell', 'across', 'country', 'the', 'and', 'with', 'from', 'that', 'this', 'those', 'these',
  'information', 'context', 'details', 'detail', 'provide', 'need', 'want', 'show', 'please', 'could', 'would', 'should',
  'notable', 'feature', 'features', 'conditions', 'condition', 'statistics', 'statistic', 'history', 'events', 'event',
  'dates', 'date', 'figures', 'figure', 'strategic', 'decisions', 'decision', 'key', 'state', 'states', 'route', 'routes',
  'nationwide', 'system',
])

const RETRY_GENERIC_FACETS = new Set([
  'information', 'context', 'details', 'detail', 'history', 'events', 'event', 'dates', 'date', 'figures', 'figure',
  'strategic', 'decisions', 'decision', 'key', 'notable', 'feature', 'features', 'conditions', 'condition', 'statistics', 'statistic',
])

function emitVerification (emit, payload) {
  emit?.('verification', payload)
}

function stubResult (domain, message) {
  return { domain, success: true, summary: message, items: [] }
}
