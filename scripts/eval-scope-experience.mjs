#!/usr/bin/env node

import 'dotenv/config'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import { ingestFile, closePool, getPool } from './_ingest-lib.mjs'
import { upsertScope } from '../apps/broker/src/organization-store.js'
import { getScopeExperienceBoosts } from '../apps/broker/src/scope-experience.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATASET_DIR = path.join(ROOT, 'data', 'sample-docs', 'general-experience-lab')
const BROKER_URL = process.env.AMPHION_BROKER_URL ?? 'http://localhost:3000'
const CORPUS = 'research'

const SUITES = [
  {
    key: 'it-access',
    scopeSlug: 'experience-lab-it-access',
    displayName: 'Experience Lab IT Access',
    description: 'Synthetic IT scope for auth-reset versus dock-network selective experience credit.',
    datasetFiles: [
      'it-bulletin-vpn-auth-reset.md',
      'it-manual-vpn-token-cache.md',
      'it-ticket-vpn-after-password-reset.md',
      'it-note-stale-auth-cache.md',
      'it-manual-dock-packet-loss.md',
      'it-ticket-dock-packet-loss.md',
    ],
    baselineQuery: {
      name: 'vpn-loop-after-reset',
      message: 'A remote employee can browse normally, but after a forced password reset and MFA reset the VPN client just loops back to sign-in. What should support inspect first and which procedure fits best?',
      expectedTitles: [
        'Service Bulletin IT-24B: VPN Loop After Password or MFA Reset',
        'IT Manual IT-318: Clear Token Cache and Re-register Secure Access',
        'Incident 8417: VPN Loop After Forced Password Reset',
      ],
      distractorTitles: [
        'IT Manual NW-204: Dock Ethernet Packet Loss and Split-Tunnel Instability',
        'Incident 8462: Packet Loss Only While Docked on Ethernet',
      ],
    },
    reinforcementQueries: [
      'A user reset identity credentials this morning, internet works, but the secure access client keeps returning to the login screen. Which repair path matches that pattern?',
      'Password reset and MFA reset are done, off-VPN browsing looks normal, but the tunnel never establishes. What should support do before touching the dock or router?',
      'Which note and access procedure line up with a login loop caused by stale auth state after identity reset?',
    ],
    contrastQuery: {
      name: 'dock-packet-loss',
      message: 'Another employee signs into VPN successfully, but calls break up and file sync stalls only while the laptop is on a USB-C dock. Gateway ping loss spikes on ethernet. Which procedure fits that case?',
      expectedTitles: [
        'IT Manual NW-204: Dock Ethernet Packet Loss and Split-Tunnel Instability',
        'Incident 8462: Packet Loss Only While Docked on Ethernet',
      ],
      distractorTitles: [
        'Service Bulletin IT-24B: VPN Loop After Password or MFA Reset',
        'IT Manual IT-318: Clear Token Cache and Re-register Secure Access',
        'Incident 8417: VPN Loop After Forced Password Reset',
      ],
    },
  },
  {
    key: 'finance-ops',
    scopeSlug: 'experience-lab-finance-ops',
    displayName: 'Experience Lab Finance Ops',
    description: 'Synthetic finance scope for expense-receipt versus duplicate-invoice selective experience credit.',
    datasetFiles: [
      'finance-bulletin-expense-receipt-sync.md',
      'finance-manual-expense-receipt-exception.md',
      'finance-ticket-expense-travel-receipt.md',
      'finance-note-mobile-receipt-delay.md',
      'finance-manual-vendor-duplicate-invoice.md',
      'finance-ticket-vendor-duplicate-payment.md',
    ],
    baselineQuery: {
      name: 'expense-receipt-sync',
      message: 'A traveler submitted meals from a client trip, the corporate card feed imported, but reimbursement is stuck because mobile receipts never attached and manager approval is waiting. Which process fits best?',
      expectedTitles: [
        'Finance Bulletin EX-12C: Mobile Receipt Sync Delay Blocks Reimbursement',
        'Finance Manual EX-410: Receipt Exception Workflow for Travel Reimbursement',
        'Finance Ticket 5538: Travel Reimbursement Stuck on Missing Receipts',
      ],
      distractorTitles: [
        'Finance Manual AP-221: Duplicate Vendor Invoice Reversal and Remittance Correction',
        'Finance Ticket 5594: Duplicate Vendor Payment After Bank Detail Update',
      ],
    },
    reinforcementQueries: [
      'The expense report already has card charges, but approval is blocked because mobile receipt images never landed. What workflow matches that pattern?',
      'Employee travel spend is visible, but receipt attachments are missing and the manager cannot approve the report. Which finance path should ops use before calling AP?',
      'Which note and reimbursement procedure line up with a delayed receipt queue rather than a supplier payment problem?',
    ],
    contrastQuery: {
      name: 'duplicate-vendor-invoice',
      message: 'A supplier invoice was paid twice after a bank detail update, and the remittance no longer matches the PO schedule. Which finance procedure fits that case?',
      expectedTitles: [
        'Finance Manual AP-221: Duplicate Vendor Invoice Reversal and Remittance Correction',
        'Finance Ticket 5594: Duplicate Vendor Payment After Bank Detail Update',
      ],
      distractorTitles: [
        'Finance Bulletin EX-12C: Mobile Receipt Sync Delay Blocks Reimbursement',
        'Finance Manual EX-410: Receipt Exception Workflow for Travel Reimbursement',
        'Finance Ticket 5538: Travel Reimbursement Stuck on Missing Receipts',
      ],
    },
  },
  {
    key: 'content-ops',
    scopeSlug: 'experience-lab-content-ops',
    displayName: 'Experience Lab Content Ops',
    description: 'Synthetic publishing scope for redirect-repair versus bounce-suppression selective experience credit.',
    datasetFiles: [
      'content-bulletin-redirect-after-rename.md',
      'content-manual-slug-redirect-publish.md',
      'content-ticket-broken-links-after-rename.md',
      'content-note-editorial-redirect-checklist.md',
      'content-manual-bounce-suppression-recovery.md',
      'content-ticket-newsletter-bounce-suppression.md',
    ],
    baselineQuery: {
      name: 'redirect-after-rename',
      message: 'A knowledge base article was renamed for a campaign, and now internal links plus email CTA buttons hit 404s on the old slug even though the new page loads directly. Which process fits best?',
      expectedTitles: [
        'Publishing Bulletin KB-17A: Redirect Setup After Article Rename',
        'Publishing Manual KB-301: Slug Redirect and Link Repair Checklist',
        'Publishing Ticket 6284: Broken Internal Links After Knowledge Base Rename',
      ],
      distractorTitles: [
        'Email Delivery Manual ED-214: Bounce Suppression Recovery and Domain Review',
        'Email Delivery Ticket 6339: Newsletter Suppressed After Hard Bounce Wave',
      ],
    },
    reinforcementQueries: [
      'Editors renamed a page, the new article works, but old cross-links and campaign buttons still land on 404s. Which publishing path matches that?',
      'This looks like redirect coverage after a slug change, not an inbox problem. What checklist should editorial ops use first?',
      'Which note and publish procedure line up with broken links after a content rename?',
    ],
    contrastQuery: {
      name: 'bounce-suppression',
      message: 'Newsletter subscribers stopped receiving campaign email after a wave of hard bounces, but the site itself and article links still work. Which process fits that case?',
      expectedTitles: [
        'Email Delivery Manual ED-214: Bounce Suppression Recovery and Domain Review',
        'Email Delivery Ticket 6339: Newsletter Suppressed After Hard Bounce Wave',
      ],
      distractorTitles: [
        'Publishing Bulletin KB-17A: Redirect Setup After Article Rename',
        'Publishing Manual KB-301: Slug Redirect and Link Repair Checklist',
        'Publishing Ticket 6284: Broken Internal Links After Knowledge Base Rename',
      ],
    },
  },
].map(suite => ({
  ...suite,
  datasetFiles: suite.datasetFiles.map(name => path.join(DATASET_DIR, name)),
}))

async function main () {
  const runToken = randomUUID().slice(0, 8)
  console.log(`[experience-eval] broker=${BROKER_URL}`)

  const results = []
  for (const suite of SUITES) {
    results.push(await runSuite(suite, runToken))
  }

  for (const result of results) printSuiteSummary(result)
  await closePool()
}

async function runSuite (suite, runToken) {
  console.log(`\n[experience-eval] suite=${suite.key}`)
  await ensureScope(suite)
  await resetScopeExperience(suite.scopeSlug)
  const datasetResources = await ingestDataset(suite)

  const baseline = await runMeasuredQuery(suite, suite.baselineQuery, 'baseline', datasetResources, runToken)

  for (let i = 0; i < suite.reinforcementQueries.length; i++) {
    await runBrokerQuery({
      message: suite.reinforcementQueries[i],
      sessionId: `experience-${suite.key}-reinforce-${runToken}-${i + 1}`,
      requestId: `experience-${suite.key}-reinforce-${runToken}-${Date.now()}-${i + 1}`,
      workspaceId: suite.scopeSlug,
    })
  }

  const reinforced = await runMeasuredQuery(suite, suite.baselineQuery, 'reinforced', datasetResources, runToken)
  const contrast = await runMeasuredQuery(suite, suite.contrastQuery, 'contrast', datasetResources, runToken)

  return { suite, baseline, reinforced, contrast }
}

async function ensureScope (suite) {
  const scope = await upsertScope({
    slug: suite.scopeSlug,
    displayName: suite.displayName,
    description: suite.description,
    metadata: { test: true, suite: suite.key },
  })
  console.log(`[experience-eval] scope=${scope.slug} id=${scope.id}`)
  return scope
}

async function resetScopeExperience (scopeSlug) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id
     FROM workspaces
     WHERE slug = $1
     LIMIT 1`,
    [scopeSlug],
  )

  if (!rows[0]) throw new Error(`Scope not found: ${scopeSlug}`)

  await pool.query('DELETE FROM resource_scope_stats WHERE workspace_id = $1', [rows[0].id])
  console.log(`[experience-eval] cleared prior scope experience for ${scopeSlug}`)
}

async function ingestDataset (suite) {
  console.log(`[experience-eval] ingesting ${suite.datasetFiles.length} dataset files...`)
  for (const filePath of suite.datasetFiles) {
    const result = await ingestFile(filePath, CORPUS, {
      corpus: CORPUS,
      force: true,
      noSummary: true,
      noCopy: true,
      scopeSlug: suite.scopeSlug,
      scopeDisplayName: suite.displayName,
      scopeMetadata: { test: true, dataset: suite.key },
    })
    console.log(`[experience-eval] ingested ${path.basename(filePath)} chunks=${result.chunks}`)
  }
  return await loadDatasetResources(suite.datasetFiles)
}

async function loadDatasetResources (datasetFiles) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id, title, source_ref
     FROM resources
     WHERE source_ref = ANY($1::text[])
     ORDER BY title ASC`,
    [datasetFiles],
  )

  return rows.map(row => ({
    id: Number(row.id),
    title: row.title,
    sourceRef: row.source_ref,
  }))
}

async function runMeasuredQuery (suite, querySpec, label, datasetResources, runToken) {
  const beforeScopeStats = await loadScopeStats(suite.scopeSlug, datasetResources)
  const run = await runBrokerQuery({
    message: querySpec.message,
    sessionId: `experience-${suite.key}-${querySpec.name}-${label}-${runToken}`,
    requestId: `experience-${suite.key}-${querySpec.name}-${label}-${runToken}-${Date.now()}`,
    workspaceId: suite.scopeSlug,
  })
  const { agentStage, stageNames } = findKnowledgeStage(run.trace)
  const afterScopeStats = await loadScopeStats(suite.scopeSlug, datasetResources)
  const deltaScopeStats = diffScopeStats(beforeScopeStats, afterScopeStats)
  const traceAttribution = agentStage
    ? extractTraceAttribution(agentStage, datasetResources)
    : emptyTraceAttribution()
  const matchedExpected = matchExpectedTitles(afterScopeStats, deltaScopeStats, traceAttribution, querySpec.expectedTitles)
  const selectivity = calculateSelectivity({
    afterRows: afterScopeStats,
    deltaRows: deltaScopeStats,
    traceAttribution,
    expectedTitles: querySpec.expectedTitles,
    distractorTitles: querySpec.distractorTitles ?? [],
  })

  return {
    label,
    queryName: querySpec.name,
    response: run.response,
    traceId: run.traceId,
    agentStageName: agentStage?.name ?? null,
    stageNames,
    summaryPreview: agentStage?.data?.parsedResult?.summaryPreview ?? '',
    scopeStats: afterScopeStats,
    deltaScopeStats,
    traceAttribution,
    matchedExpected,
    selectivity,
  }
}

async function loadScopeStats (scopeSlug, datasetResources) {
  const resourceIds = datasetResources.map(item => item.id)
  const pool = getPool()
  const { rows } = await pool.query(
    `WITH target_scope AS (
       SELECT id
       FROM workspaces
       WHERE slug = $1
       LIMIT 1
     )
     SELECT r.id, r.title, COALESCE(rss.hit_count, 0) AS hit_count, rss.last_hit_at
     FROM resources r
     LEFT JOIN target_scope ts ON true
     LEFT JOIN resource_scope_stats rss
       ON rss.resource_id = r.id
      AND rss.workspace_id = ts.id
     WHERE r.id = ANY($2::bigint[])
     ORDER BY COALESCE(rss.hit_count, 0) DESC, r.title ASC`,
    [scopeSlug, resourceIds],
  )

  const boosts = await getScopeExperienceBoosts({ scope: scopeSlug, resourceIds })

  return rows.map((row, index) => ({
    rank: index + 1,
    resourceId: Number(row.id),
    title: row.title,
    hitCount: Number(row.hit_count ?? 0),
    boost: Number(boosts.get(String(row.id))?.boost ?? 0),
    lastHitAt: row.last_hit_at ?? null,
  }))
}

function diffScopeStats (beforeRows, afterRows) {
  const beforeById = new Map(beforeRows.map(row => [row.resourceId, row]))
  return afterRows.map(row => {
    const before = beforeById.get(row.resourceId)
    return {
      ...row,
      deltaHitCount: row.hitCount - Number(before?.hitCount ?? 0),
      deltaBoost: row.boost - Number(before?.boost ?? 0),
    }
  })
}

async function runBrokerQuery ({ message, sessionId, requestId, workspaceId }) {
  const res = await fetch(`${BROKER_URL}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId, requestId, workspaceId }),
  })

  if (!res.ok) {
    throw new Error(`Broker returned HTTP ${res.status}: ${await res.text()}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('Broker response did not include a readable body')

  const decoder = new TextDecoder()
  let buffer = ''
  let response = ''
  let traceId = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = safeJsonParse(line.slice(6))
      if (!payload) continue
      if (payload.type === 'token' && typeof payload.token === 'string') response += payload.token
      if (payload.type === 'done' && payload.traceId) traceId = payload.traceId
    }
  }

  if (!traceId) throw new Error(`Query finished without a traceId for request ${requestId}`)

  const resolved = await fetchTrace({ requestId, sessionId })
  return { response, traceId: resolved.id, trace: resolved.trace }
}

async function fetchTrace ({ requestId, sessionId }) {
  const maxAttempts = 10

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const listRes = await fetch(`${BROKER_URL}/traces`)
    if (!listRes.ok) throw new Error(`Trace list fetch failed: HTTP ${listRes.status}`)

    const traceList = await listRes.json()
    for (const item of traceList.slice(0, 12)) {
      const traceRes = await fetch(`${BROKER_URL}/traces/${item.id}`)
      if (!traceRes.ok) continue
      const trace = await traceRes.json()
      if (trace?.requestId === requestId) return { id: item.id, trace }
      if (trace?.sessionId === sessionId && trace?.requestId?.endsWith(requestId.slice(-8))) {
        return { id: item.id, trace }
      }
    }

    await delay(200)
  }

  throw new Error(`Trace fetch timed out for request ${requestId}`)
}

function findKnowledgeStage (trace) {
  const stages = trace?.stages ?? []
  const stage = stages.find(entry => entry?.name?.startsWith('agent:') && entry?.data?.resourceAttribution)
    ?? stages.find(entry => entry?.name === 'agent:knowledge')
  return {
    agentStage: stage ?? null,
    stageNames: stages.map(entry => entry?.name).filter(Boolean),
  }
}

function emptyTraceAttribution () {
  return {
    rowCount: 0,
    creditedResourceIds: [],
    rankedResources: [],
    creditedResources: [],
  }
}

function extractTraceAttribution (agentStage, datasetResources) {
  const raw = agentStage?.data?.resourceAttribution ?? {}
  const resourceMap = new Map(datasetResources.map(row => [row.id, row.title]))
  const creditedIds = new Set((raw.creditedResourceIds ?? []).map(value => Number(value)).filter(Number.isFinite))
  const rankedResources = (raw.rankedResources ?? []).map(entry => ({
    resourceId: Number(entry.resourceId),
    title: entry.title ?? resourceMap.get(Number(entry.resourceId)) ?? `resource:${entry.resourceId}`,
    attributionScore: Number(entry.attributionScore ?? 0),
    selectionScore: Number(entry.selectionScore ?? 0),
    fitScore: Number(entry.fitScore ?? 0),
    negativeScore: Number(entry.negativeScore ?? 0),
    evidenceScore: Number(entry.evidenceScore ?? 0),
    bestRank: Number(entry.bestRank ?? 0),
    eligible: Boolean(entry.eligible),
    credited: creditedIds.has(Number(entry.resourceId)),
  }))
  const rankedById = new Map(rankedResources.map(row => [row.resourceId, row]))
  const creditedResources = [...creditedIds]
    .map(resourceId => rankedById.get(resourceId) ?? {
      resourceId,
      title: resourceMap.get(resourceId) ?? `resource:${resourceId}`,
      attributionScore: 0,
      selectionScore: 0,
      fitScore: 0,
      negativeScore: 0,
      evidenceScore: 0,
      bestRank: 0,
      eligible: false,
      credited: true,
    })
    .filter(Boolean)

  return {
    rowCount: Number(raw.rowCount ?? 0),
    creditedResourceIds: [...creditedIds],
    rankedResources,
    creditedResources,
  }
}

function matchExpectedTitles (afterRows, deltaRows, traceAttribution, expectedTitles) {
  const afterByTitle = indexByTitle(afterRows)
  const deltaByTitle = indexByTitle(deltaRows)
  const creditedTitles = new Set(traceAttribution.creditedResources.map(row => row.title))

  return expectedTitles.map(title => {
    const after = afterByTitle.get(title)
    const delta = deltaByTitle.get(title)
    return {
      title,
      found: Boolean(after),
      rank: after?.rank ?? null,
      hitCount: after?.hitCount ?? 0,
      boost: after?.boost ?? 0,
      deltaHits: delta?.deltaHitCount ?? 0,
      credited: creditedTitles.has(title),
    }
  })
}

function calculateSelectivity ({ afterRows, deltaRows, traceAttribution, expectedTitles, distractorTitles }) {
  const afterByTitle = indexByTitle(afterRows)
  const deltaByTitle = indexByTitle(deltaRows)
  const creditedTitles = new Set(traceAttribution.creditedResources.map(row => row.title))

  return {
    traceExpectedCredit: average(expectedTitles.map(title => creditedTitles.has(title) ? 1 : 0)),
    traceDistractorCredit: average(distractorTitles.map(title => creditedTitles.has(title) ? 1 : 0)),
    deltaExpectedHits: average(expectedTitles.map(title => deltaByTitle.get(title)?.deltaHitCount ?? 0)),
    deltaDistractorHits: average(distractorTitles.map(title => deltaByTitle.get(title)?.deltaHitCount ?? 0)),
    totalExpectedHits: average(expectedTitles.map(title => afterByTitle.get(title)?.hitCount ?? 0)),
    totalDistractorHits: average(distractorTitles.map(title => afterByTitle.get(title)?.hitCount ?? 0)),
    totalExpectedBoost: average(expectedTitles.map(title => afterByTitle.get(title)?.boost ?? 0)),
    totalDistractorBoost: average(distractorTitles.map(title => afterByTitle.get(title)?.boost ?? 0)),
  }
}

function safeJsonParse (value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function delay (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printSuiteSummary ({ suite, baseline, reinforced, contrast }) {
  console.log(`\n=== Suite: ${suite.displayName} ===`)
  printRun('Baseline', baseline)
  printRun('Reinforced', reinforced)
  printRun('Contrast case', contrast)

  const baselineRanks = indexByTitle(baseline.scopeStats)
  const reinforcedRanks = indexByTitle(reinforced.scopeStats)

  console.log(`\n=== Movement: ${suite.displayName} ===`)
  for (const title of suite.baselineQuery.expectedTitles) {
    const before = baselineRanks.get(title)
    const after = reinforcedRanks.get(title)
    console.log(`- ${title}`)
    console.log(`  before: rank=${before?.rank ?? 'missing'} hits=${before?.hitCount ?? 0} boost=${formatNumber(before?.boost)}`)
    console.log(`  after:  rank=${after?.rank ?? 'missing'} hits=${after?.hitCount ?? 0} boost=${formatNumber(after?.boost)}`)
  }
}

function printRun (label, run) {
  console.log(`\n${label} trace=${run.traceId}`)
  console.log(`routing: agent_stage=${run.agentStageName ?? 'none'} stages=${run.stageNames.join(', ')}`)
  console.log(`response: ${truncate(run.response, 220)}`)
  console.log(`knowledge summary: ${truncate(run.summaryPreview, 220)}`)
  console.log(`credit: trace_expected=${formatNumber(run.selectivity.traceExpectedCredit)} trace_distractor=${formatNumber(run.selectivity.traceDistractorCredit)} delta_expected_hits=${formatNumber(run.selectivity.deltaExpectedHits)} delta_distractor_hits=${formatNumber(run.selectivity.deltaDistractorHits)}`)
  console.log(`totals: expected_hits=${formatNumber(run.selectivity.totalExpectedHits)} distractor_hits=${formatNumber(run.selectivity.totalDistractorHits)} expected_boost=${formatNumber(run.selectivity.totalExpectedBoost)} distractor_boost=${formatNumber(run.selectivity.totalDistractorBoost)}`)
  console.log('credited resources:')
  if (run.traceAttribution.creditedResources.length === 0) {
    console.log('- none')
  } else {
    for (const row of run.traceAttribution.creditedResources) {
      console.log(`- ${row.title} selection=${formatNumber(row.selectionScore)} evidence=${formatNumber(row.evidenceScore)} fit=${formatNumber(row.fitScore)} negative=${formatNumber(row.negativeScore)}`)
    }
  }
  console.log('top scope resources:')
  for (const row of run.scopeStats.slice(0, 5)) {
    console.log(`- #${row.rank} ${row.title} hits=${row.hitCount} boost=${formatNumber(row.boost)}`)
  }
  console.log('expected matches:')
  for (const item of run.matchedExpected) {
    console.log(`- ${item.title} :: found=${item.found} rank=${item.rank ?? 'missing'} hits=${item.hitCount} delta_hits=${item.deltaHits} credited=${item.credited} boost=${formatNumber(item.boost)}`)
  }
}

function indexByTitle (rows) {
  return new Map(rows.map(row => [row.title, row]))
}

function formatNumber (value) {
  const numeric = Number(value ?? 0)
  return numeric.toFixed(4)
}

function average (values) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + Number(value ?? 0), 0)
  return total / values.length
}

function truncate (value, max) {
  const text = `${value ?? ''}`.replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

main().catch(async err => {
  console.error('[experience-eval] fatal:', err.message)
  try { await closePool() } catch {}
  process.exit(1)
})