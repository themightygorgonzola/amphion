/**
 * apps/broker/src/agent-runner.js
 *
 * MCP child-process runner. The knowledge agent is a small ReAct loop over the
 * Resource tools: recall, find, load, reflect.
 */

import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { callOllama, callOllamaTools } from './ollama.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_ROOT = path.resolve(__dirname, '../../../agents')
const MAX_REACT_STEPS = 16
const MAX_VERIFY_RESULTS = 6
const VERIFY_TIMEOUT_MS = 15_000
const MAX_ATTRIBUTED_RESOURCES = 4
const MAX_ATTRIBUTION_ROWS = 10
const ATTRIBUTION_STOP_WORDS = new Set([
  'a', 'after', 'all', 'an', 'and', 'another', 'any', 'are', 'at', 'be', 'before', 'best', 'both', 'briefly', 'but',
  'by', 'case', 'during', 'first', 'fit', 'fits', 'for', 'from', 'got', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'log', 'logs', 'looks', 'may', 'might', 'normal', 'now', 'of', 'on', 'only', 'or', 'other', 'our',
  'out', 'path', 'roadside', 'should', 'show', 'since', 'that', 'the', 'their', 'then', 'there', 'this', 'to', 'under',
  'vehicle', 'van', 'what', 'which', 'with', 'without', 'work', 'would', 'your'
])
const GENERIC_ATTRIBUTION_KEYWORDS = new Set([
  'case', 'component', 'diagnostic', 'documentation', 'issue', 'problem', 'resource', 'service', 'support', 'system',
])
const NEGATIVE_SECTION_HEADING = /^(not the usual fit|when not to use|do not use|escalate to)/i

const VERIFICATION_VERDICTS = new Set([
  'supported',
  'insufficient',
  'contradicted',
  'path_only_match',
  'conversation_echo',
  'identity_definition_missing',
  'topic_mismatch',
])

// Terms that are generic to all legal queries — exclude from title-match relevance check
const GENERIC_VERIFICATION_TERMS = new Set([
  'what', 'are', 'the', 'for', 'in', 'of', 'with', 'that', 'this', 'and', 'or', 'not',
  'can', 'how', 'does', 'when', 'where', 'who', 'which', 'why', 'was', 'were', 'will',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'did', 'is', 'its', 'it', 'any',
  'washington', 'state', 'law', 'laws', 'legal', 'act', 'acts', 'rcw', 'chapter', 'code',
  'revised', 'section', 'subsection', 'statute', 'statutes', 'regulation', 'regulations',
  'also', 'specifically', 'including', 'includes', 'applies', 'apply', 'under', 'per', 'about',
  // Common English words that appear throughout unrelated legal text
  'large', 'small', 'major', 'minor', 'general', 'public', 'private', 'county', 'city',
  'district', 'local', 'person', 'persons', 'people', 'owner', 'owners', 'owning', 'owned',
  'property', 'required', 'allowed', 'shall', 'must', 'may', 'all', 'each', 'every', 'other',
  'such', 'following', 'provided', 'pursuant', 'related', 'relevant', 'documentation',
  'overview', 'information', 'rights', 'duties', 'requirements', 'authority', 'provisions',
])

const DOMAIN_CONFIG = {
  knowledge: {
    file:     'knowledge/index.js',
    useReact: true,
  },
  comms: {
    file:       'comms/index.js',
    useReact:   false,
    tool:       'draft_email',
    argBuilder: (task, context) => ({
      recipient: extractDraftRecipient(task),
      purpose: task,
      context: buildDraftSupportContext(context),
    }),
  },
  proposals: {
    file:       'proposals/index.js',
    useReact:   false,
    tool:       'outline_proposal',
    argBuilder: (task, context) => ({
      opportunity: task,
      client: extractProposalClient(task),
      value: extractProposalValue(task),
      context: buildDraftSupportContext(context),
    }),
  },
  finance: {
    file:       'finance/index.js',
    useReact:   false,
    tool:       'query_deals',
    argBuilder: task => ({ filter: task }),
  },
}

function buildDraftSupportContext (context = {}) {
  const support = context?.resourceSupport
  const primaryItems = (support?.items ?? [])
    .filter(item => !item?.is_neighbor)
    .slice(0, 4)

  const lines = []
  for (const item of primaryItems) {
    const title = [item.title, item.section_header].filter(Boolean).join(' — ')
    const snippet = `${item.content ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 280)
    if (title || snippet) lines.push(`- ${title || 'resource'}: ${snippet}`)
  }

  if (lines.length === 0 && support?.summary?.trim()) {
    lines.push(`- ${support.summary.trim()}`)
  }

  return lines.length > 0
    ? ['Relevant resource context:', ...lines].join('\n')
    : ''
}

function extractDraftRecipient (task) {
  const text = `${task ?? ''}`
  const match = text.match(/\b(?:to|for)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})\b/)
  return match?.[1]?.trim() || 'the recipient'
}

function extractProposalClient (task) {
  const text = `${task ?? ''}`
  const match = text.match(/\b(?:for|client)\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,4})\b/)
  return match?.[1]?.trim() || 'the client'
}

function extractProposalValue (task) {
  const text = `${task ?? ''}`
  const match = text.match(/\$\s?\d[\d,]*(?:\.\d+)?\s*[KMB]?/i)
  return match?.[0]?.replace(/\s+/g, '') || 'TBD'
}

export async function runAgent (domain, task, context = {}, trace = null, emit = null, jobTicket = null) {
  const config = DOMAIN_CONFIG[domain]
  if (!config) {
    return { domain, success: false, summary: `No agent configured for domain: ${domain}`, items: [] }
  }

  const mode = config.useReact ? 'react' : config.tool
  const t0 = Date.now()
  console.log(`[agent-runner] ${domain} [${mode}] "${String(task).slice(0, 80)}..."`)

  try {
    const raw = config.useReact
      ? await runReactAgent(config, domain, task, context, trace, emit, jobTicket)
      : await callAgentOnce(config, task, context)
    const attributionTask = context?.originalMessage
      ? `${context.originalMessage}\n${task}`
      : task
    const parsed = parseAgentResult(domain, raw, attributionTask)
    trace?.stage(`agent:${domain}`, {
      mode,
      durationMs: Date.now() - t0,
      parsedResult: {
        success: parsed.success,
        itemCount: parsed.items?.length ?? 0,
        foundNothing: parsed.foundNothing ?? false,
        summaryPreview: parsed.summary?.slice(0, 220) ?? '',
        verificationVerdict: parsed.verification?.verdict ?? null,
        verificationRetry: parsed.verification?.shouldRetry ?? false,
      },
      resourceAttribution: parsed.resourceAttribution ?? null,
    })
    return parsed
  } catch (err) {
    trace?.stage(`agent:${domain}`, { mode, error: err.message, durationMs: Date.now() - t0 })
    console.error(`[agent-runner] ${domain} failed: ${err.message}`)
    return { domain, success: false, summary: `Agent error: ${err.message}`, items: [], error: err.message }
  }
}

async function runReactAgent (config, domain, task, context, trace, emit, jobTicket) {
  const session = createAgentSession({ ...config, domain })
  const observations = []
  const allResults = []
  let lastRawMcpResult = null
  const initialRecallTopic = extractOriginalRequest(task) || `${task ?? ''}`.trim()

  try {
    await session.send('initialize', { clientInfo: { name: 'amphion-broker', version: '0.1.0' } })
    const { tools: mcpTools } = await session.send('tools/list', {})
    const calledKeys = new Set()

    lastRawMcpResult = await preloadFilesystemDetail({ session, task, domain, observations, allResults, calledKeys, emit, context })
    if (lastRawMcpResult && allResults.length > 0) {
      return { content: [{ text: JSON.stringify({ result_type: 'recall_results', results: dedupResults(allResults) }) }] }
    }

    const implementationPreloaded = await preloadImplementationDetail({ session, task, domain, observations, allResults, calledKeys, emit, context })
    if (implementationPreloaded) {
      return { content: [{ text: JSON.stringify({ result_type: 'recall_results', results: dedupResults(allResults) }) }] }
    }

    // Pre-execute initial recall to seed context before the native tool-calling loop.
    // Filesystem and implementation detail tasks are handled by preload functions above;
    // for all other tasks, always start with a recall on the original topic.
    if (!isFilesystemDetailTask(task)) {
      const initialRecallArgs = { topic: initialRecallTopic, k: 8 }
      calledKeys.add(`recall:${JSON.stringify(initialRecallArgs)}`)
      const initialResult = await callSessionTool(session, 'recall', initialRecallArgs, context)
      lastRawMcpResult = initialResult
      const initialParsed = parseJsonResult(initialResult)
      recordObservation({ observations, emit, domain, step: 1, tool: 'recall', args: initialRecallArgs, reasoning: 'Initial retrieval on the original user request.', parsed: initialParsed })
      accumulateResults(allResults, initialParsed)
    }

    // Convert MCP tool definitions to Ollama native tool format.
    // Add a local 'reflect' tool the model can call to self-assess sufficiency.
    const ollamaTools = [
      ...mcpTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema ?? { type: 'object', properties: {} },
        },
      })),
      {
        type: 'function',
        function: {
          name: 'reflect',
          description: 'Check whether you have retrieved sufficient grounded evidence to answer the task. Call this after recall/find/load calls. When sufficient=true, stop calling any more tools.',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]

    const reactMessages = [
      { role: 'system', content: buildNativeReactSystemPrompt(task) },
      { role: 'user', content: extractOriginalRequest(task) },
    ]

    const reactGen = callOllamaTools({
      model: process.env.OLLAMA_MODEL_REACT ?? process.env.OLLAMA_MODEL_DISPATCHER ?? 'llama3.1:8b',
      messages: reactMessages,
      tools: ollamaTools,
      maxRounds: MAX_REACT_STEPS,
      numPredict: 200,
      executeTool: async (toolName, args) => {
        const callKey = `${toolName}:${JSON.stringify(args)}`
        if (calledKeys.has(callKey)) {
          return JSON.stringify({ error: 'Duplicate call — use a different query or topic.' })
        }
        calledKeys.add(callKey)

        let parsed
        if (toolName === 'reflect') {
          parsed = buildReflection(task, observations, allResults)
          lastRawMcpResult = { content: [{ text: JSON.stringify(parsed) }] }
        } else {
          const mcpResult = await callSessionTool(session, toolName, args, context)
          lastRawMcpResult = mcpResult
          parsed = parseJsonResult(mcpResult)
        }

        recordObservation({ observations, emit, domain, step: observations.length + 1, tool: toolName, args, reasoning: null, parsed })
        accumulateResults(allResults, parsed)

        if (toolName === 'find' && parsed.result_type === 'resource_list') {
          const loaded = await autoLoadSingleResource({ session, task, domain, observations, allResults, calledKeys, emit, resources: parsed.resources ?? [] })
          if (loaded) lastRawMcpResult = loaded
        }

        return JSON.stringify(parsed)
      },
    })

    // Consume the generator — all state (allResults, observations) is built via executeTool side effects.
    for await (const _ of reactGen) { /* noop */ }
  } finally {
    session.destroy()
  }

  const verification = await verifyKnowledgeSupport(task, observations, allResults, jobTicket)

  if (allResults.length > 0) {
    return {
      content: [{
        text: JSON.stringify({
          result_type: 'recall_results',
          results: dedupResults(allResults),
          verification,
        }),
      }],
    }
  }

  if (lastRawMcpResult) return attachVerification(lastRawMcpResult, verification)
  return { content: [{ text: JSON.stringify({ results: [], verification }) }] }
}

function buildAgentToolContext (context = {}) {
  const activeScope = `${context?.activeScope ?? context?.workspaceId ?? ''}`.trim()
  return activeScope ? { activeScope } : {}
}

async function callSessionTool (session, toolName, args = {}, context = {}) {
  const params = { name: toolName, arguments: args }
  const toolContext = buildAgentToolContext(context)
  if (Object.keys(toolContext).length > 0) params.context = toolContext
  return await session.send('tools/call', params)
}

async function preloadImplementationDetail ({ session, task, domain, observations, allResults, calledKeys, emit, context = {} }) {
  if (!/\bamphion\b/i.test(task) || !/\b(implement|implementation|implements|source|code)\b/i.test(task)) return false
  if (!/\b(mcp|tool|input schema|input schemas|inputSchema)\b/i.test(task)) return false

  const recallArgs = { topic: 'MCP tools input schemas inputSchema JSON schema tool definitions', corpus: 'research', k: 6 }
  calledKeys.add(`recall:${JSON.stringify(recallArgs)}`)
  const recallResult = await callSessionTool(session, 'recall', recallArgs, context)
  const recalled = parseJsonResult(recallResult)
  recordObservation({ observations, emit, domain, step: observations.length + 1, tool: 'recall', args: recallArgs, reasoning: 'Preloaded MCP tools spec context for implementation comparison.', parsed: recalled })
  accumulateResults(allResults, recalled)

  const codeFiles = [
    path.resolve(AGENTS_ROOT, '_base/index.js'),
    path.resolve(AGENTS_ROOT, 'knowledge/index.js'),
    path.resolve(AGENTS_ROOT, '../tools/mcp/amphion-server.js'),
    path.resolve(AGENTS_ROOT, '../apps/broker/src/agent-runner.js'),
  ]
  for (const filePath of codeFiles) {
    await loadResource({ session, task, domain, observations, allResults, calledKeys, emit, resourceId: `fs:${filePath}`, reasoning: 'Preloaded Amphion source code for implementation comparison.' })
  }
  return true
}

async function preloadFilesystemDetail ({ session, task, domain, observations, allResults, calledKeys, emit, context = {} }) {
  if (!isFilesystemDetailTask(task)) return null

  const name = filesystemFindName(task)
  if (!name) return null

  const findArgs = { name, k: 5 }
  if (/\b(folder|directory|scripts)\b/i.test(task)) findArgs.type = 'directory'
  calledKeys.add(`find:${JSON.stringify(findArgs)}`)

  const findResult = await callSessionTool(session, 'find', findArgs, context)
  const found = parseJsonResult(findResult)
  recordObservation({ observations, emit, domain, step: observations.length + 1, tool: 'find', args: findArgs, reasoning: 'Preloaded explicit filesystem lookup for this resource-detail task.', parsed: found })

  const resource = chooseAutoLoadResource(task, found.resources ?? [])
    ?? (found.resources ?? []).find(r => r.external && (r.type === 'directory' || r.type === 'file'))
    ?? found.resources?.[0]
  if (!resource?.resource_id) return findResult

  const loadResult = await loadResource({ session, task, domain, observations, allResults, calledKeys, emit, resourceId: resource.resource_id, reasoning: 'Preloaded content for the located filesystem resource.' })
  return loadResult ?? findResult
}

async function autoLoadSingleResource ({ session, task, domain, observations, allResults, calledKeys, emit, resources }) {
  const resource = chooseAutoLoadResource(task, resources)
  if (!resource?.resource_id) return null
  return await loadResource({ session, task, domain, observations, allResults, calledKeys, emit, resourceId: resource.resource_id, reasoning: 'Auto-loaded the single located resource for this detailed resource request.' })
}

async function loadResource ({ session, task, domain, observations, allResults, calledKeys, emit, resourceId, reasoning }) {
  const loadArgs = { resource_id: resourceId }
  const loadKey = `load:${JSON.stringify(loadArgs)}`
  if (calledKeys.has(loadKey)) return null
  calledKeys.add(loadKey)

  const loadResult = await session.send('tools/call', { name: 'load', arguments: loadArgs })
  const loaded = parseJsonResult(loadResult)
  recordObservation({ observations, emit, domain, step: observations.length + 1, tool: 'load', args: loadArgs, reasoning, parsed: loaded })
  accumulateResults(allResults, loaded)
  return loadResult
}

function isFilesystemDetailTask (task) {
  return /\b(file|folder|directory|script|scripts|repo|workspace|path)\b/i.test(task)
}

function filesystemFindName (task) {
  const original = task.match(/Original request:\s*(.+)/i)?.[1]
  const topic = task.match(/Topic:\s*(.+)/i)?.[1]
  const text = original ?? topic ?? task
  if (/\bamphion\b.*\bscripts?\b|\bscripts?\b.*\bamphion\b/i.test(text)) return 'amphion scripts'
  const quoted = text.match(/"([^"]+)"|'([^']+)'/)
  if (quoted) return quoted[1] ?? quoted[2]
  return text
    .replace(/\b(find|locate|load|open|read|describe|tell me what|tell me|what each|each|every|all|does|do|contents?|purpose|of)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

function chooseAutoLoadResource (task, resources) {
  if (!Array.isArray(resources) || resources.length !== 1) return null
  const resource = resources[0]
  const detailRequest = /\b(each|every|all|describe|what .* does|tell me what|folder|directory|file|script)\b/i.test(task)
  if (!detailRequest) return null
  if (resource.type === 'directory' || resource.type === 'file' || resource.external) return resource
  return null
}

function recordObservation ({ observations, emit, domain, step, tool, args, reasoning, parsed }) {
  const summary = summarizeObservation(tool, parsed)
  observations.push({ step, tool, args, summary, raw: parsed })
  emit?.('agent_step', {
    domain,
    step,
    tool,
    args,
    reasoning: reasoning ?? null,
    resultCount: countParsedResults(parsed),
    summary,
  })
}

function parseJsonResult (mcpResult) {
  const text = mcpResult?.content?.[0]?.text ?? '{}'
  try { return JSON.parse(text) } catch { return { raw: text } }
}

function buildNativeReactSystemPrompt (task) {
  return [
    'You are a knowledge retrieval agent. Find grounded evidence to answer the task using the provided tools.',
    'Your job is to call tools — do NOT write a final narrative answer.',
    '',
    'Tool strategy:',
    '- recall(topic, corpus?, k?): Search the knowledge base for relevant excerpts. Always start here.',
    '- find(name, type?, k?): Locate a specific resource by title, filename, folder name, or path.',
    '- load(resource_id): Read the full content of a resource returned by recall or find.',
    '- reflect(): Check if you have sufficient grounded evidence. When it returns sufficient=true, stop calling tools.',
    '',
    'Rules:',
    '- If the task has multiple distinct sub-questions, call recall separately for each one.',
    '- Never repeat a tool call with the same arguments.',
    '- Call find() then load() when looking for a specific named document or file.',
    '- After reflect() returns sufficient=true, do not call any more tools.',
  ].join('\n')
}

async function reactDecide (task, tools, observations, accumulatedResults = []) {
  const model = process.env.OLLAMA_MODEL_REACT ?? process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b'
  const toolList = tools.map(t => {
    const required = t.inputSchema?.required ?? []
    const props = t.inputSchema?.properties ?? {}
    const params = required.map(p => `${p}: ${(props[p]?.description ?? '').split('.')[0]}`).join(', ')
    return params ? `- ${t.name}(${params}): ${t.description}` : `- ${t.name}: ${t.description}`
  }).join('\n')

  const obsBlock = observations.length === 0
    ? 'None yet.'
    : observations.map(o => `Step ${o.step}: ${o.tool}(${JSON.stringify(o.args)}) -> ${o.summary}`).join('\n')

  const findingsBlock = accumulatedResults.length > 0
    ? accumulatedResults.slice(0, 5).map(r => `- ${r.title ?? r.resource_id ?? 'resource'}: ${(r.content ?? '').slice(0, 240).replace(/\n/g, ' ')}`).join('\n')
    : 'None yet.'

  const systemPrompt = [
    'You control a Resource agent. Decide the next MCP tool call.',
    '',
    'Available tools:',
    toolList,
    '',
    'Principles:',
    '- Your decisions are only: what topic/resource do I need, and am I informed enough yet?',
    '- Use recall(topic) to inform yourself about a subject.',
    '- Use find(name) to locate a specific resource by title, filename, folder, path, or label.',
    '- Use load(resource_id) to inspect a resource returned by recall/find.',
    '- Use reflect() when you think you may be done, or when you need to identify the remaining gap.',
    '- If the user asks what each file/script/resource does, load individual resources; a resource list only gives names.',
    '- Never invent resource_id values. Use IDs exactly as observed.',
    '- Never repeat the same tool call with the same arguments.',
    '- Output ONLY valid JSON:',
    '  {"reasoning":"why this call is next","action":"call","tool":"recall|find|load|reflect","args":{...}}',
    '  or {"reasoning":"why no further information is needed","action":"done"}',
  ].join('\n')

  const raw = await callOllama({
    model,
    systemPrompt,
    userMessage: `Task:\n${task}\n\nObservations:\n${obsBlock}\n\nCurrent findings:\n${findingsBlock}\n\nNext action?`,
    stream: false,
    format: 'json',
    numPredict: 500,
    timeoutMs: 20_000,
  })

  let decision
  try { decision = JSON.parse(raw) } catch { return { action: 'done' } }
  if (decision?.action === 'call' && tools.some(t => t.name === decision.tool)) return decision
  return { action: 'done', reasoning: decision?.reasoning }
}

function buildReflection (task, observations, results) {
  const loaded = observations.filter(o => o.tool === 'load')
  const found = observations.filter(o => o.tool === 'find' || o.tool === 'recall')
  const primary = dedupResults(results).filter(result => !result.is_neighbor)
  const substantive = primary.filter(result => `${result.content ?? ''}`.trim().length > 80)
  const hasContent = substantive.length > 0
  const resourceCounts = new Map()
  for (const result of substantive) {
    const key = result.resource_id != null ? String(result.resource_id) : `${result.title ?? 'unknown'}:${result.source_path ?? ''}`
    resourceCounts.set(key, (resourceCounts.get(key) ?? 0) + 1)
  }
  const dominantResourceCount = resourceCounts.size > 0 ? Math.max(...resourceCounts.values()) : 0
  const dominantShare = substantive.length > 0 ? dominantResourceCount / substantive.length : 0
  const topScore = Math.max(0, ...substantive.map(result => numericScore(result.rrf_score, 0)))
  const briefPrompt = /\b(brief|simple|what is|who is|where is)\b/i.test(task)
  const coherentEvidence = dominantResourceCount >= 2 || dominantShare >= 0.6 || topScore >= 0.35
  const sufficient = hasContent && coherentEvidence && (substantive.length >= 3 || loaded.length > 0 || briefPrompt)
  const gaps = []
  if (!found.length) gaps.push('No topic/resource search has been performed yet.')
  if (!hasContent) gaps.push('No substantive resource content has been retrieved yet.')
  if (hasContent && !coherentEvidence) gaps.push('Retrieved excerpts are not yet coherent enough around one grounded source or cluster.')
  if (/\b(each|every|all scripts?|all files?)\b/i.test(task) && loaded.length === 0) gaps.push('The task asks about individual resources, but none have been loaded yet.')
  return {
    result_type: 'reflection',
    sufficient,
    summary: sufficient
      ? `Sufficient context: ${substantive.length} substantive excerpt(s), dominant source share ${(dominantShare * 100).toFixed(0)}%, ${loaded.length} loaded resource(s).`
      : `Not sufficient yet: ${gaps.join(' ') || 'need one more targeted lookup.'}`,
    gaps,
  }
}

async function verifyKnowledgeSupport (task, observations, results, jobTicket) {
  const primary = dedupResults(results).filter(result => !result.is_neighbor)
  const signals = buildVerificationSignals(task, primary)
  const fallback = buildFallbackVerification(task, primary, jobTicket, signals)

  if (fallback.shouldRetry) return fallback
  if (isFilesystemDetailTask(task)) {
    return {
      verdict: 'supported',
      shouldRetry: false,
      rationale: 'Filesystem detail requests are answered from loaded filesystem content.',
      missingFacet: null,
      nextQuery: null,
      confidence: 'high',
      signals,
    }
  }

  const evidence = primary
    .slice(0, MAX_VERIFY_RESULTS)
    .map((result, index) => {
      const label = [result.title, result.section_header].filter(Boolean).join(' — ') || `result ${index + 1}`
      return [
        `#${index + 1} ${label}`,
        `corpus=${result.corpus ?? result.domain ?? 'unknown'}`,
        `source=${result.source_path ?? 'unknown'}`,
        `content=${truncateForVerification(result.content, 700)}`,
      ].join('\n')
    })
    .join('\n\n')

  const systemPrompt = [
    'You verify whether retrieved evidence actually supports answering a user request.',
    'Return ONLY valid JSON.',
    'Do not answer the user. Judge support and, if needed, suggest one better retry query.',
    'If the evidence is mostly past conversation echoes, path names, or tangential implementation notes, do not mark it supported.',
    'Prefer supported only when the evidence directly answers the request in a coherent way.',
    '{',
    '  "verdict": "supported|insufficient|contradicted|path_only_match|conversation_echo|identity_definition_missing",',
    '  "shouldRetry": true,',
    '  "confidence": "low|medium|high",',
    '  "rationale": "short reason",',
    '  "missingFacet": "what is missing or null",',
    '  "nextQuery": "one improved retry query or null"',
    '}',
  ].join('\n')

  const userMessage = [
    `Task:\n${extractOriginalRequest(task)}`,
    `Mode: ${jobTicket?.modality ?? 'retrieve'}`,
    `Signals: ${JSON.stringify(signals)}`,
    '',
    'Evidence:',
    evidence || '(none)',
    '',
    'Verify whether the evidence directly supports a coherent answer.',
  ].join('\n')

  try {
    const raw = await callOllama({
      model: process.env.OLLAMA_MODEL_VERIFY ?? process.env.OLLAMA_MODEL_REACT ?? process.env.OLLAMA_MODEL_DISPATCHER ?? 'qwen3:14b',
      systemPrompt,
      userMessage,
      stream: false,
      format: 'json',
      numPredict: 300,
      timeoutMs: VERIFY_TIMEOUT_MS,
    })
    const parsed = JSON.parse(raw)
    return normalizeVerification(parsed, fallback, task)
  } catch {
    return fallback
  }
}

function buildFallbackVerification (task, primaryResults, jobTicket, signals) {
  if (primaryResults.length === 0) {
    return {
      verdict: 'insufficient',
      shouldRetry: true,
      rationale: 'No evidence excerpts were retrieved.',
      missingFacet: 'relevant source excerpts',
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'broader-source'),
      confidence: 'low',
      signals,
    }
  }

  const substantive = primaryResults.some(result => `${result.content ?? ''}`.trim().length > 80)
  if (!substantive) {
    return {
      verdict: 'insufficient',
      shouldRetry: true,
      rationale: 'Retrieved results did not contain enough substantive content.',
      missingFacet: 'substantive source content',
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'broader-source'),
      confidence: 'low',
      signals,
    }
  }

  // Guard against garbage retrieval: if we have meaningful subject terms but NONE of the
  // top resources contain any of them in their title or leading content, the search returned
  // off-topic results. Threshold of >=1 meaningful term catches even single-concept queries.
  if (signals.meaningfulTerms?.length >= 1 && signals.titleMatchCount === 0 && primaryResults.length >= 2) {
    return {
      verdict: 'topic_mismatch',
      shouldRetry: true,
      rationale: `Retrieved resources (e.g. "${primaryResults[0]?.title ?? 'unknown'}") do not appear to cover the requested topic.`,
      missingFacet: `evidence about ${signals.meaningfulTerms.slice(0, 3).join(', ')}`,
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'broader-source'),
      confidence: 'high',
      signals,
    }
  }

  const rememberMode = jobTicket?.modality === 'remember'
  if (!rememberMode && signals.conversationCount >= Math.max(1, Math.ceil(primaryResults.length / 2))) {
    return {
      verdict: 'conversation_echo',
      shouldRetry: true,
      rationale: 'Most evidence came from prior conversations instead of canonical resources.',
      missingFacet: 'resource-backed evidence',
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'canonical-resource'),
      confidence: 'medium',
      signals,
    }
  }

  if (isDefinitionLikeTask(task, jobTicket) && signals.canonicalCount === 0) {
    return {
      verdict: 'identity_definition_missing',
      shouldRetry: true,
      rationale: `The evidence provides implementation details but does not provide an overview of the canonical definition for ${extractVerificationSubject(task)}.`,
      missingFacet: 'canonical definition information',
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'definition'),
      confidence: 'medium',
      signals,
    }
  }

  if (isDefinitionLikeTask(task, jobTicket) && signals.definitionLikeCount === 0) {
    return {
      verdict: 'identity_definition_missing',
      shouldRetry: true,
      rationale: 'The evidence mentions the subject but does not clearly define what it is.',
      missingFacet: 'a direct definition or overview',
      nextQuery: buildVerificationRetryQuery(task, jobTicket, 'definition'),
      confidence: 'medium',
      signals,
    }
  }

  return {
    verdict: 'supported',
    shouldRetry: false,
    rationale: 'Retrieved evidence appears substantive enough to answer from.',
    missingFacet: null,
    nextQuery: null,
    confidence: 'medium',
    signals,
  }
}

function buildVerificationSignals (task, primaryResults) {
  const subjectTerms = verificationSubjectTerms(task)
  const meaningfulTerms = subjectTerms.filter(t => !GENERIC_VERIFICATION_TERMS.has(t) && t.length >= 4)
  const conversationCount = primaryResults.filter(isConversationEvidence).length
  const filesystemCount = primaryResults.filter(isFilesystemEvidence).length
  const definitionLikeCount = primaryResults.filter(result => isDefinitionLikeEvidence(result, subjectTerms)).length
  const canonicalCount = primaryResults.filter(result => isCanonicalDefinitionSource(result, subjectTerms)).length
  const corpora = [...new Set(primaryResults.map(result => result.corpus ?? result.domain).filter(Boolean))]
  // Count resources whose title OR leading content contains at least one subject-specific term
  const titleMatchCount = meaningfulTerms.length === 0 ? primaryResults.length : primaryResults.filter(result => {
    const titleLower = `${result.title ?? ''}`.toLowerCase()
    const contentSnippet = `${result.content ?? ''}`.toLowerCase().slice(0, 300)
    return meaningfulTerms.some(term => titleLower.includes(term) || contentSnippet.includes(term))
  }).length
  return {
    primaryCount: primaryResults.length,
    conversationCount,
    filesystemCount,
    definitionLikeCount,
    canonicalCount,
    titleMatchCount,
    meaningfulTerms,
    corpora: corpora.slice(0, 6),
  }
}

function normalizeVerification (parsed, fallback, task) {
  if (fallback.shouldRetry && parsed?.verdict === 'supported') {
    return fallback
  }
  const verdict = VERIFICATION_VERDICTS.has(parsed?.verdict) ? parsed.verdict : fallback.verdict
  const confidence = ['low', 'medium', 'high'].includes(parsed?.confidence) ? parsed.confidence : fallback.confidence
  const rationale = sanitizeVerificationText(parsed?.rationale, 240) || fallback.rationale
  const missingFacet = sanitizeVerificationText(parsed?.missingFacet, 160) || fallback.missingFacet
  const nextQuery = sanitizeVerificationQuery(parsed?.nextQuery, task) || fallback.nextQuery
  const shouldRetry = verdict !== 'supported'
    ? Boolean(nextQuery) && (parsed?.shouldRetry !== false || fallback.shouldRetry)
    : false
  return {
    verdict,
    shouldRetry,
    rationale,
    missingFacet,
    nextQuery,
    confidence,
    signals: fallback.signals,
  }
}

function buildVerificationRetryQuery (task, jobTicket, hint) {
  const subject = extractVerificationSubject(task)
  if (jobTicket?.modality === 'remember') {
    return subject ? `${subject} previous conversation notes` : extractOriginalRequest(task)
  }
  if (hint === 'definition' && subject) return `canonical definition overview ${subject}`
  if (hint === 'canonical-resource' && subject) return `${subject} overview description` 
  if (hint === 'broader-source' && subject) return `${subject} documentation overview`
  if (subject) return `what is ${subject}`
  return extractOriginalRequest(task)
}

function extractVerificationSubject (task) {
  const request = extractOriginalRequest(task)
  const definitionMatch = request.match(/\b(?:what is|who is|define|definition of|what does)\s+(.+?)(?:\?|$)/i)
  if (definitionMatch?.[1]) return definitionMatch[1].trim().replace(/^the\s+/i, '')
  const topicMatch = `${task ?? ''}`.match(/Topic:\s*(.+)/i)
  if (topicMatch?.[1]) return topicMatch[1].trim()
  return request
}

function verificationSubjectTerms (task) {
  const all = extractVerificationSubject(task)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3)
  // Filter generics first so meaningful domain-specific terms survive the slice
  const meaningful = all.filter(t => !GENERIC_VERIFICATION_TERMS.has(t) && t.length >= 4)
  return meaningful.length > 0 ? meaningful.slice(0, 6) : all.slice(0, 6)
}

function extractOriginalRequest (task) {
  const text = `${task ?? ''}`
  return text.match(/Original request:\s*(.+)/i)?.[1]?.trim()
    ?? text.match(/Topic(?:\/context)?:\s*(.+)/i)?.[1]?.trim()
    ?? text.trim()
}

function isDefinitionLikeTask (task, jobTicket) {
  if (jobTicket?.modality === 'remember') return false
  const text = extractOriginalRequest(task).toLowerCase()
  return /\b(what is|who is|define|definition of|what does .+ mean|what does .+ refer to)\b/.test(text)
}

function isConversationEvidence (result) {
  return /conversation/i.test(`${result.corpus ?? ''}`) || /conversation/i.test(`${result.source_path ?? ''}`)
}

function isFilesystemEvidence (result) {
  return /external-filesystem/i.test(`${result.corpus ?? ''}`)
    || /^[a-z]:\\/i.test(`${result.source_path ?? ''}`)
    || /^fs:/i.test(`${result.resource_id ?? ''}`)
}

function isDefinitionLikeEvidence (result, subjectTerms = []) {
  const content = `${result.content ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 260).toLowerCase()
  if (!content) return false
  const mentionsSubject = subjectTerms.length === 0 || subjectTerms.some(term => content.includes(term))
  if (!mentionsSubject) return false
  return /\b(is|are|refers to|serves as|acts as|means)\b/.test(content)
}

function isCanonicalDefinitionSource (result, subjectTerms = []) {
  const label = `${result.title ?? ''} ${result.source_path ?? ''}`.toLowerCase()
  const content = `${result.content ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 220).toLowerCase()
  const mentionsSubject = subjectTerms.length === 0
    || subjectTerms.some(term => label.includes(term) || content.includes(term))
  if (!mentionsSubject) return false
  return /\breadme\b|\boverview\b|\babout\b|\bintroduction\b/.test(label)
}

function truncateForVerification (value, maxLen) {
  const text = `${value ?? ''}`.replace(/\s+/g, ' ').trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function sanitizeVerificationText (value, maxLen) {
  const text = `${value ?? ''}`.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.slice(0, maxLen)
}

function sanitizeVerificationQuery (value, task) {
  const text = sanitizeVerificationText(value, 180)
  if (!text) return null
  if (text === extractOriginalRequest(task)) return null
  return text
}

function attachVerification (mcpResult, verification) {
  const parsed = parseJsonResult(mcpResult)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return mcpResult
  return { content: [{ text: JSON.stringify({ ...parsed, verification }) }] }
}

function accumulateResults (allResults, parsed) {
  if (Array.isArray(parsed.results)) allResults.push(...parsed.results)
  if (parsed.resource && Array.isArray(parsed.chunks)) {
    for (const c of parsed.chunks) {
      allResults.push({
        chunk_id:       c.chunk_id ?? null,
        resource_id:    c.resource_id ?? parsed.resource.id,
        document_id:    c.resource_id ?? parsed.resource.id,
        doc_id:         c.doc_id ?? c.resource_id ?? parsed.resource.id,
        chunk_index:    c.chunk_index ?? 0,
        section_path:   c.section_path ?? [],
        section_header: c.section_header ?? (Array.isArray(c.section_path) ? c.section_path.join(' > ') : null),
        content:        c.content,
        title:          c.title ?? parsed.resource.title,
        domain:         c.domain ?? parsed.resource.corpus,
        corpus:         c.corpus ?? parsed.resource.corpus,
        source_path:    c.source_path ?? c.source_ref ?? parsed.resource.source_ref,
        source_ref:     c.source_ref ?? parsed.resource.source_ref,
        rrf_score:      c.rrf_score ?? 0,
        is_neighbor:    c.is_neighbor ?? false,
        start_line:     c.start_line ?? null,
        end_line:       c.end_line ?? null,
        char_start:     c.char_start ?? null,
        char_end:       c.char_end ?? null,
      })
    }
  }
}

function countParsedResults (parsed) {
  if (Array.isArray(parsed.results)) return parsed.results.length
  if (Array.isArray(parsed.resources)) return parsed.resources.length
  if (Array.isArray(parsed.chunks)) return parsed.chunks.length
  if (Array.isArray(parsed.entries)) return parsed.entries.length
  if (parsed.result_type === 'reflection') return parsed.sufficient ? 1 : 0
  return 0
}

function summarizeObservation (tool, parsed) {
  if (parsed.error) return `Error: ${parsed.error}`
  if (parsed.result_type === 'resource_list') {
    const names = (parsed.resources ?? []).slice(0, 8).map(r => `${r.title} [${r.resource_id}]`).join('; ')
    return `Found ${parsed.count ?? parsed.resources?.length ?? 0} resource(s): ${names || 'none'}`
  }
  if (parsed.result_type === 'resource') {
    const resource = parsed.resource ?? {}
    const chunkCount = parsed.chunks?.length ?? 0
    const entries = parsed.entries?.length ?? 0
    const preview = parsed.chunks?.[0]?.content?.slice(0, 240)?.replace(/\n/g, ' ')
    if (chunkCount > 0) return `Loaded ${resource.title ?? resource.id}: ${chunkCount} chunk(s). ${preview ?? ''}`
    if (entries > 0) return `Loaded ${resource.title ?? resource.id}: directory with ${entries} entrie(s): ${parsed.entries.slice(0, 10).map(e => `${e.name} [${e.resource_id}]`).join('; ')}`
    return `Loaded ${resource.title ?? resource.id}: no text chunks.`
  }
  if (parsed.result_type === 'reflection') return parsed.summary
  if (Array.isArray(parsed.results)) {
    if (parsed.results.length === 0) return 'No resource excerpts found'
    const titles = [...new Set(parsed.results.slice(0, 4).map(r => r.title).filter(Boolean))]
    const top = parsed.results[0]?.content?.slice(0, 220)?.replace(/\n/g, ' ')
    return `${parsed.results.length} excerpt(s) from ${titles.join(', ') || 'resources'}${top ? `; top: ${top}` : ''}`
  }
  return JSON.stringify(parsed).slice(0, 200)
}

function numericResourceId (value) {
  const numeric = Number.parseInt(`${value ?? ''}`, 10)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null
}

function numericScore (value, fallback = 0) {
  const numeric = Number.parseFloat(`${value ?? ''}`)
  return Number.isFinite(numeric) ? numeric : fallback
}

function normalizeAttributionTerm (term) {
  const normalized = `${term ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length > 4 && normalized.endsWith('s')) return normalized.slice(0, -1)
  return normalized
}

function buildAttributionSignals (task = '') {
  const tokens = (`${task ?? ''}`.match(/[a-z]+[a-z0-9-]*|[a-z]\d[a-z0-9-]*/gi) ?? [])
    .map(normalizeAttributionTerm)
    .filter(token => token.length >= 3 && !ATTRIBUTION_STOP_WORDS.has(token))
  const keywords = [...new Set(tokens.filter(token => !GENERIC_ATTRIBUTION_KEYWORDS.has(token)))]
  const phrases = new Set()
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i]
    const right = tokens[i + 1]
    if (!left || !right) continue
    if ((left.length >= 5 || right.length >= 5) || /\d/.test(left + right)) {
      phrases.add(`${left} ${right}`)
    }
  }
  return { keywords, phrases: [...phrases] }
}

function countSignalMatches (signals, text = '') {
  const haystack = normalizeAttributionTerm(text)
  if (!haystack) return { keywordMatches: 0, phraseMatches: 0 }

  let keywordMatches = 0
  for (const keyword of signals.keywords ?? []) {
    if (keyword && haystack.includes(keyword)) keywordMatches += 1
  }

  let phraseMatches = 0
  for (const phrase of signals.phrases ?? []) {
    if (phrase && haystack.includes(phrase)) phraseMatches += 1
  }

  return { keywordMatches, phraseMatches }
}

function isAttributionHeading (line = '') {
  const trimmed = `${line ?? ''}`.trim()
  if (!trimmed) return false
  if (/^#{1,6}\s+/.test(trimmed)) return true
  if (/^[-*]|^\d+[.)]/.test(trimmed)) return false
  if (trimmed.length > 90) return false
  if (/[.:!?]$/.test(trimmed)) return false
  return /^[A-Za-z][A-Za-z0-9 '&(),\/-]+$/.test(trimmed)
}

function splitAttributionContent (content = '') {
  const positive = []
  const negative = []
  let currentTarget = positive

  for (const line of `${content ?? ''}`.split(/\r?\n/)) {
    const trimmed = line.trim()
    const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/)
    const headingText = headingMatch?.[1] ?? (isAttributionHeading(trimmed) ? trimmed : null)
    if (headingText) currentTarget = NEGATIVE_SECTION_HEADING.test(headingText) ? negative : positive
    currentTarget.push(line)
  }

  return {
    positiveText: positive.join('\n'),
    negativeText: negative.join('\n'),
  }
}

function buildResourceAttribution (task = '', items = []) {
  const primary = (items ?? []).filter(item => item && !item.is_neighbor)
  if (primary.length === 0) return null
  const signals = buildAttributionSignals(task)

  const byResource = new Map()
  for (const [index, item] of primary.slice(0, MAX_ATTRIBUTION_ROWS).entries()) {
    const resourceId = numericResourceId(item.resource_id ?? item.doc_id)
    if (resourceId == null) continue

    const rowRank = index + 1
    const rankWeight = 1 / rowRank
    const evidenceScore = Math.max(0, numericScore(item.rrf_score, 0) - numericScore(item.scope_experience_boost, 0))
    const baseScore = Math.max(0.01, evidenceScore)
    const titleText = [item.title, item.section_header].filter(Boolean).join('\n')
    const { positiveText, negativeText } = splitAttributionContent(item.content ?? '')
    const titleMatches = countSignalMatches(signals, titleText)
    const positiveMatches = countSignalMatches(signals, positiveText)
    const negativeMatches = countSignalMatches(signals, negativeText)
    const fitScore = (titleMatches.keywordMatches * 2) + (titleMatches.phraseMatches * 4) + positiveMatches.keywordMatches + (positiveMatches.phraseMatches * 3)
    const negativeScore = (negativeMatches.keywordMatches * 0.35) + (negativeMatches.phraseMatches * 1.4)
    const fitMultiplier = signals.keywords.length > 0 ? 0.25 + Math.min(3, fitScore * 0.12) : 1
    const contradictionPenalty = signals.keywords.length > 0 ? (1 / (1 + (negativeScore * 0.2))) : 1
    const attributionScore = rankWeight * baseScore * fitMultiplier * contradictionPenalty
    const current = byResource.get(resourceId) ?? {
      resourceId,
      title: item.title ?? `resource:${resourceId}`,
      rowCount: 0,
      bestRank: rowRank,
      maxScore: 0,
      totalScore: 0,
      evidenceScore: 0,
      attributionScore: 0,
      fitScore: 0,
      negativeScore: 0,
      rankPositions: [],
    }

    current.rowCount += 1
    current.bestRank = Math.min(current.bestRank, rowRank)
    current.maxScore = Math.max(current.maxScore, baseScore)
    current.totalScore += baseScore
    current.evidenceScore += evidenceScore
    current.attributionScore += attributionScore
    current.fitScore += fitScore
    current.negativeScore += negativeScore
    current.rankPositions.push(rowRank)
    byResource.set(resourceId, current)
  }

  const rankedResources = [...byResource.values()]
    .map(entry => ({
      resourceId: entry.resourceId,
      title: entry.title,
      rowCount: entry.rowCount,
      bestRank: entry.bestRank,
      maxScore: Number(entry.maxScore.toFixed(4)),
      totalScore: Number(entry.totalScore.toFixed(4)),
      evidenceScore: Number(entry.evidenceScore.toFixed(4)),
      attributionScore: Number(entry.attributionScore.toFixed(6)),
      fitScore: Number(entry.fitScore.toFixed(2)),
      negativeScore: Number(entry.negativeScore.toFixed(2)),
      fitPriority: Number(Math.max(0, entry.fitScore - entry.negativeScore).toFixed(2)),
      selectionScore: Number((entry.attributionScore + (Math.max(0, entry.fitScore - entry.negativeScore) * 0.0025)).toFixed(6)),
      eligible: entry.fitScore > 0 && entry.negativeScore <= entry.fitScore,
      rankPositions: entry.rankPositions,
    }))
    .sort((left, right) => {
      if (right.selectionScore !== left.selectionScore) return right.selectionScore - left.selectionScore
      if (right.attributionScore !== left.attributionScore) return right.attributionScore - left.attributionScore
      if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore
      if (left.bestRank !== right.bestRank) return left.bestRank - right.bestRank
      return left.resourceId - right.resourceId
    })

  if (rankedResources.length === 0) return null

  const selectionPool = rankedResources.some(entry => entry.eligible)
    ? rankedResources.filter(entry => entry.eligible)
    : rankedResources
  const topAttribution = selectionPool[0].selectionScore
  const totalAttribution = selectionPool.reduce((sum, entry) => sum + entry.selectionScore, 0)
  const creditedResourceIds = []
  let cumulative = 0

  for (const entry of selectionPool) {
    const reachedCoverage = cumulative >= totalAttribution * 0.72
    const scoreTooSmall = creditedResourceIds.length > 0 && entry.selectionScore < topAttribution * 0.55
    if ((reachedCoverage && scoreTooSmall) || creditedResourceIds.length >= MAX_ATTRIBUTED_RESOURCES) break
    creditedResourceIds.push(entry.resourceId)
    cumulative += entry.selectionScore
  }

  return {
    rowCount: primary.length,
    creditedResourceIds,
    rankedResources: rankedResources.slice(0, 6),
  }
}

function guardVerificationWithAttribution (verification, resourceAttribution, task = '') {
  if (!verification || !resourceAttribution) return verification

  const top = resourceAttribution.rankedResources?.[0] ?? null
  if (!top) return verification

  const second = resourceAttribution.rankedResources?.[1] ?? null
  const topSelectionScore = top.selectionScore ?? 0
  const secondSelectionScore = second?.selectionScore ?? 0
  const dominantTopResource = top.bestRank === 1 && (
    second == null || topSelectionScore >= Math.max(0.02, secondSelectionScore * 2.5)
  )
  const strongAttribution = dominantTopResource && (
    (top.fitPriority ?? 0) >= 40 ||
    (top.rowCount ?? 0) >= 3 ||
    topSelectionScore >= 0.35
  )

  if (verification.verdict !== 'supported') {
    if (!strongAttribution) return verification
    if (verification.verdict === 'contradicted' || verification.verdict === 'conversation_echo') return verification

    return {
      ...verification,
      verdict: 'supported',
      shouldRetry: false,
      rationale: 'A dominant resource supplied multiple directly relevant excerpts for this request.',
      missingFacet: null,
      nextQuery: null,
      confidence: verification.confidence === 'low' ? 'medium' : verification.confidence,
    }
  }

  if ((top.fitPriority ?? 0) >= 10 || (top.selectionScore ?? 0) >= 0.05) return verification

  return {
    ...verification,
    verdict: 'insufficient',
    shouldRetry: false,
    rationale: `Retrieved results were only loosely aligned to the request: ${truncateForVerification(task, 140)}`,
    missingFacet: verification.missingFacet ?? 'directly relevant resource',
    nextQuery: null,
  }
}

async function callAgentOnce (config, task, context) {
  const session = createAgentSession(config)
  try {
    await session.send('initialize', { clientInfo: { name: 'amphion-broker', version: '0.1.0' } })
    return await session.send('tools/call', {
      name:      config.tool,
      arguments: config.argBuilder(task, context),
    })
  } finally {
    session.destroy()
  }
}

function createAgentSession (config) {
  const agentPath = path.join(AGENTS_ROOT, config.file)
  const domainName = config.domain ?? config.file.split('/')[0]
  const child = spawn('node', [agentPath], {
    env:   { ...process.env, AMPHION_AGENT: domainName },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let stdoutBuf = ''
  let msgId = 0
  const pending = new Map()
  let destroyed = false

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    stdoutBuf += chunk
    const lines = stdoutBuf.split('\n')
    stdoutBuf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      const waiter = pending.get(msg.id)
      if (!waiter) continue
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.log(`  [${domainName}] ${line}`)
  })

  child.on('exit', (code, signal) => {
    if (destroyed) return
    const err = new Error(`Agent ${domainName} exited unexpectedly (code=${code} signal=${signal})`)
    for (const waiter of pending.values()) waiter.reject(err)
    pending.clear()
  })

  const hardTimer = setTimeout(() => {
    if (!destroyed) child.kill('SIGKILL')
  }, 60_000)

  function send (method, params) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  function destroy () {
    if (destroyed) return
    destroyed = true
    clearTimeout(hardTimer)
    child.stdin.destroy()
  }

  return { send, destroy }
}

function parseAgentResult (domain, mcpResult, task = '') {
  const parsed = parseJsonResult(mcpResult)
  const verification = parsed?.verification ?? null
  const triedQueries = Array.isArray(parsed?.triedQueries) ? parsed.triedQueries : []

  if (parsed.result_type === 'resource_list') {
    return {
      domain,
      success: true,
      isResources: true,
      hasChunks: false,
      items: parsed.resources ?? [],
      foundNothing: (parsed.resources ?? []).length === 0,
      summary: (parsed.resources ?? []).length > 0
        ? `Found ${(parsed.resources ?? []).length} resource(s): ${(parsed.resources ?? []).slice(0, 6).map(r => r.title).join(', ')}`
        : `No resources found for ${parsed.query ?? 'that query'}.`,
      resourceAttribution: null,
      verification,
      triedQueries,
    }
  }

  if (parsed.result_type === 'resource') {
    const chunks = (parsed.chunks ?? []).map(c => ({
      chunk_id:       c.chunk_id ?? null,
      doc_id:         c.doc_id ?? c.resource_id ?? parsed.resource?.id,
      resource_id:    c.resource_id ?? parsed.resource?.id,
      chunk_index:    c.chunk_index ?? 0,
      title:          c.title ?? parsed.resource?.title ?? null,
      domain:         c.domain ?? parsed.resource?.corpus ?? null,
      corpus:         c.corpus ?? parsed.resource?.corpus ?? null,
      section_path:   c.section_path ?? [],
      section_header: c.section_header ?? (Array.isArray(c.section_path) ? c.section_path.join(' > ') : null),
      content:        (c.content ?? '').trim(),
      rrf_score:      c.rrf_score ?? 0,
      scope_experience_boost: c.scope_experience_boost ?? 0,
      is_neighbor:    c.is_neighbor ?? false,
      source_path:    c.source_path ?? c.source_ref ?? parsed.resource?.source_ref ?? null,
      start_line:     c.start_line ?? null,
      end_line:       c.end_line ?? null,
      char_start:     c.char_start ?? null,
      char_end:       c.char_end ?? null,
    }))
    const resourceAttribution = buildResourceAttribution(task, chunks)
    return {
      domain,
      success: true,
      hasChunks: chunks.length > 0,
      isResources: chunks.length === 0,
      resource: parsed.resource,
      entries: parsed.entries ?? [],
      items: chunks.length > 0 ? chunks : (parsed.entries ?? []),
      foundNothing: chunks.length === 0 && !(parsed.entries?.length > 0),
      summary: chunks.length > 0
        ? `Loaded ${parsed.resource?.title ?? 'resource'} (${chunks.length} chunk(s)).`
        : `Loaded ${parsed.resource?.title ?? 'resource'} (${parsed.entries?.length ?? 0} entrie(s)).`,
      resourceAttribution,
      verification: guardVerificationWithAttribution(verification, resourceAttribution, task),
      triedQueries,
    }
  }

  if (Array.isArray(parsed.results)) {
    const chunks = parsed.results.map(r => ({
      chunk_id:       r.chunk_id ?? r.id,
      doc_id:         r.document_id ?? r.doc_id ?? r.resource_id,
      resource_id:    r.resource_id ?? null,
      chunk_index:    r.chunk_index ?? 0,
      title:          r.title ?? null,
      domain:         r.domain ?? r.corpus ?? null,
      corpus:         r.corpus ?? r.domain ?? null,
      section_path:   r.section_path ?? [],
      section_header: r.section_header ?? (Array.isArray(r.section_path) ? r.section_path.join(' > ') : null),
      content:        (r.content ?? r.text ?? '').trim(),
      rrf_score:      r.rrf_score ?? 0,
      scope_experience_boost: r.scope_experience_boost ?? 0,
      is_neighbor:    r.is_neighbor ?? false,
      source_path:    r.source_path ?? r.source_ref ?? null,
      start_line:     r.start_line ?? null,
      end_line:       r.end_line ?? null,
      char_start:     r.char_start ?? null,
      char_end:       r.char_end ?? null,
    }))
    const primary = chunks.filter(c => !c.is_neighbor)
    const labelSource = primary.length > 0 ? primary : chunks
    const resourceAttribution = buildResourceAttribution(task, chunks)
    return {
      domain,
      success: true,
      hasChunks: chunks.length > 0,
      items: chunks,
      summary: chunks.length > 0
        ? labelSource.slice(0, 6).map(c => [c.title, c.section_header].filter(Boolean).join(' - ')).join('; ')
        : 'No resource excerpts found.',
      foundNothing: chunks.length === 0,
      resourceAttribution,
      verification: guardVerificationWithAttribution(verification, resourceAttribution, task),
      triedQueries,
    }
  }

  if (parsed.draft) {
    return {
      domain,
      success: true,
      summary: `Drafted communication for: ${parsed.purpose ?? parsed.recipient ?? 'request'}`,
      generatedText: parsed.draft,
      outputKind: 'draft',
      items: [{ draft: parsed.draft }],
      resourceAttribution: null,
      verification,
      triedQueries,
    }
  }
  if (parsed.outline) {
    return {
      domain,
      success: true,
      summary: `Generated proposal outline for: ${parsed.opportunity ?? 'opportunity'}`,
      generatedText: parsed.outline,
      outputKind: 'outline',
      items: [{ outline: parsed.outline }],
      resourceAttribution: null,
      verification,
      triedQueries,
    }
  }
  if (parsed.deals) {
    return { domain, success: true, summary: parsed.deals.length > 0 ? JSON.stringify(parsed.deals, null, 2) : 'No deal records found.', items: parsed.deals, resourceAttribution: null, verification, triedQueries }
  }
  if (parsed.win_rate !== undefined) {
    return { domain, success: true, summary: `Win rate: ${parsed.win_rate} (${parsed.won}/${parsed.total} proposals)`, items: [parsed], resourceAttribution: null, verification, triedQueries }
  }

  return { domain, success: true, summary: parsed.message ?? `${domain} agent completed.`, items: [], resourceAttribution: null, verification, triedQueries }
}

function dedupResults (results) {
  const seen = new Set()
  return results.filter(r => {
    const key = r.chunk_id != null ? String(r.chunk_id) : `${r.resource_id}:${r.chunk_index}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
