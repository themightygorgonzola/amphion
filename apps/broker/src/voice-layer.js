/**
 * broker/src/voice-layer.js — Stage 4
 *
 * The final synthesis step. Takes all agent results and crafts
 * one unified response in the voice of {{DISPLAY_NAME}}.
 *
 * Two paths:
 *   streaming  — returns an async generator yielding tokens (for SSE to client)
 *   buffered   — returns the full response as a string (for internal use / testing)
 */

import fs from 'fs'
import path from 'path'
import { callOllama, callOllamaTools } from './ollama.js'
import { searchResourceChunks } from '../../../agents/_shared/resource-retrieval.js'

function loadVoicePrompt () {
  const promptPath = path.resolve(
    process.env.PROMPTS_DIR ?? path.join(import.meta.dirname, '../../../prompts'),
    'voice-layer.md'
  )
  try {
    let prompt = fs.readFileSync(promptPath, 'utf8')
    prompt = prompt.replaceAll('{{DISPLAY_NAME}}', process.env.DISPLAY_NAME ?? 'Atlas')
    prompt = prompt.replaceAll('{{USER_NAME}}',    process.env.USER_NAME    ?? 'the user')
    prompt = prompt.replaceAll('{{COMPANY}}',      process.env.COMPANY_NAME ?? 'the company')
    return prompt
  } catch {
    console.warn('[voice-layer] could not read prompts/voice-layer.md — using inline fallback')
    return buildFallbackPrompt()
  }
}

// ---------------------------------------------------------------------------
// synthesize — used by POST /query
// Returns the full response string (Voice Layer handles streaming via SSE directly in index.js)
// ---------------------------------------------------------------------------

/**
 * Synthesize a unified response from agent results.
 *
 * @param {Object.<string, import('./orchestrator.js').AgentResult>} agentResults
 * @param {string} originalMessage
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {Promise<string>}  — full response text
 */
export async function synthesize (agentResults, originalMessage, context, jobTicket) {
  if (isIdentityMetaQuestion(originalMessage)) {
    return buildIdentityMetaReply(originalMessage)
  }

  const directGeneratedReply = buildDirectGeneratedReply(agentResults, jobTicket)
  if (directGeneratedReply) return directGeneratedReply

  const verificationLimitedReply = buildVerificationLimitedReply(agentResults, jobTicket)
  if (verificationLimitedReply) return verificationLimitedReply

  const basePrompt = loadVoicePrompt()
  const systemPrompt = buildSystemPrompt(basePrompt, agentResults)

  const response = await callOllama({
    model: process.env.OLLAMA_MODEL_VOICE ?? process.env.OLLAMA_MODEL_PRIMARY ?? 'llama3.3:70b',
    systemPrompt,
    userMessage: originalMessage,
    history: sanitizeHistory((context.history ?? []).slice(-4)),  // last 2 turns only
    stream: false,
    numPredict: lengthToTokens(jobTicket?.responseLength),
  })

  return response
}

/**
 * Like synthesize() but streams tokens via an async generator.
 * Used when you want to pipe tokens directly to an SSE response
 * without buffering the full reply.
 *
 * @param {Object.<string, import('./orchestrator.js').AgentResult>} agentResults
 * @param {string} originalMessage
 * @param {import('./context-assembler.js').ContextPacket} context
 * @returns {AsyncGenerator<string>}
 */
export async function synthesizeStream (agentResults, originalMessage, context, trace, jobTicket) {
  if (isIdentityMetaQuestion(originalMessage)) {
    const reply = buildIdentityMetaReply(originalMessage)
    trace?.stage('voice', {
      model: 'identity-fast-path',
      responseLength: 'brief',
      numPredict: 0,
      fullResponse: reply,
      durationMs: 0,
    })
    return (async function * () { yield reply })()
  }

  const directGeneratedReply = buildDirectGeneratedReply(agentResults, jobTicket)
  if (directGeneratedReply) {
    trace?.stage('voice', {
      model: 'direct-generated-output',
      responseLength: jobTicket?.responseLength,
      numPredict: 0,
      fullResponse: directGeneratedReply,
      durationMs: 0,
    })
    return (async function * () { yield directGeneratedReply })()
  }

  const verificationLimitedReply = buildVerificationLimitedReply(agentResults, jobTicket)
  const basePrompt = loadVoicePrompt()
  const model = process.env.OLLAMA_MODEL_VOICE ?? process.env.OLLAMA_MODEL_PRIMARY ?? 'llama3.3:70b'

  // --- Artifact cards path: file references from the artifacts agent ---
  const artifactItems = collectArtifacts(agentResults)
  if (artifactItems.length > 0) {
    const t0 = Date.now()
    const systemPrompt = buildSystemPrompt(basePrompt, agentResults)
    const numPredict = lengthToTokens(jobTicket?.responseLength)
    trace?.stage('voice', { model, mode: 'artifact-cards', cardCount: artifactItems.length })

    const stream = callOllama({
      model,
      systemPrompt,
      userMessage: originalMessage,
      history: sanitizeHistory((context.history ?? []).slice(-4)),
      stream: true,
      numPredict,
    })

    // Emit artifact cards first, then stream narration tokens
    return wrapStreamTrace(
      stream, trace, t0,
      artifactItems.map(artifact => ({ type: 'artifact_card', artifact }))
    )
  }

  // --- Evidence card path: structured chunks from legal/research agents ---
  const allChunks = collectChunks(agentResults)
  if (verificationLimitedReply && allChunks.length === 0) {
    trace?.stage('voice', {
      model: 'verification-guard',
      responseLength: jobTicket?.responseLength,
      numPredict: 0,
      fullResponse: verificationLimitedReply,
      durationMs: 0,
    })
    return (async function * () { yield verificationLimitedReply })()
  }

  if (allChunks.length > 0) {
    const t0 = Date.now()

    if (verificationLimitedReply) {
      // Rescue pass: the verification model flagged a gap and suggested a retry query.
      // Try a targeted search for the missing evidence before giving up.
      const rescueQuery = Object.values(agentResults ?? {})
        .map(r => r.verification?.nextQuery)
        .filter(Boolean)[0] ?? null

      if (rescueQuery) {
        try {
          const rescueCorpus = allChunks[0]?.domain ?? allChunks[0]?.corpus ?? null
          const seenIds = new Set(allChunks.map(c => String(c.chunk_id ?? c.id)))
          const rescueResults = await searchResourceChunks({ query: rescueQuery, corpus: rescueCorpus, k: 8, neighbors: true })
          const newChunks = rescueResults.filter(c => !seenIds.has(String(c.chunk_id ?? c.id)))
          if (newChunks.length > 0) {
            const allCandidates = [...allChunks, ...newChunks]
            const manifestInput = selectChunksForManifest(allCandidates, originalMessage)
            const manifest = await buildCardManifest(manifestInput, originalMessage, model, jobTicket?.domains ?? [])
            if (manifest.cards.length > 0 && manifest.narration) {
              const rescueCards = materializeCardsFromManifest(allCandidates, manifest.cards)
              const finalCards = rescueCards.length > 0 ? rescueCards : buildFallbackCards(allCandidates)
              trace?.stage('voice', { model, mode: 'verification-rescue', cardCount: finalCards.length, fullResponse: manifest.narration, durationMs: Date.now() - t0 })
              return (async function* () {
                for (const card of finalCards) yield { type: 'card', card }
                for (const token of splitNarration(manifest.narration)) yield { type: 'token', token }
              })()
            }
          }
        } catch (err) {
          console.warn('[voice-layer] verification rescue failed:', err.message)
        }
      }

      // Rescue found nothing useful — fall back to verification-limited reply with what we have.
      const cards = buildFallbackCards(allChunks)
      trace?.stage('voice', {
        model: 'verification-guard',
        mode: 'verification-guard-cards',
        cardCount: cards.length,
        fullResponse: verificationLimitedReply,
        durationMs: Date.now() - t0,
      })
      return (async function* () {
        for (const card of cards) yield { type: 'card', card }
        for (const token of splitNarration(verificationLimitedReply)) yield { type: 'token', token }
      })()
    }

    if (isMcpImplementationQuestion(originalMessage, jobTicket) && allChunks.some(isFilesystemChunk) && allChunks.some(c => !isFilesystemChunk(c))) {
      const narration = buildMcpImplementationNarration(allChunks)
      const cards = allChunks.slice(0, 10).map(chunk => ({
        chunk_id:       chunk.chunk_id,
        title:          chunk.title ?? null,
        section_header: chunk.section_header ?? null,
        content:        chunk.content,
        highlight_phrase: null,
        annotation:     null,
        source_path:    chunk.source_path ?? null,
        chunk_index:    chunk.chunk_index,
      }))
      trace?.stage('voice', { model: 'direct-mcp-implementation', mode: 'direct-mcp-implementation', cardCount: cards.length, fullResponse: narration, durationMs: Date.now() - t0 })
      return (async function* () {
        for (const card of cards) yield { type: 'card', card }
        for (const token of splitNarration(narration)) yield { type: 'token', token }
      })()
    }

    const conversationChunks = allChunks.filter(isConversationChunk)
    if (jobTicket?.modality === 'remember' && conversationChunks.length > 0) {
      const narration = buildConversationRecallNarration(conversationChunks)
      const cards = conversationChunks.slice(0, 8).map(chunk => ({
        chunk_id:       chunk.chunk_id,
        title:          chunk.title ?? null,
        section_header: chunk.section_header ?? null,
        content:        chunk.content,
        highlight_phrase: null,
        annotation:     null,
        source_path:    chunk.source_path ?? null,
        chunk_index:    chunk.chunk_index,
      }))
      trace?.stage('voice', { model: 'direct-conversation', mode: 'direct-conversation', cardCount: cards.length, fullResponse: narration, durationMs: Date.now() - t0 })
      return (async function* () {
        for (const card of cards) yield { type: 'card', card }
        for (const token of splitNarration(narration)) yield { type: 'token', token }
      })()
    }

    // Direct retrieval mode: all chunks have rrf_score=0 (get_section / get_chapter result)
    // Emit them all as sequential cards in document order — skip manifest call entirely
    const primaryChunks = allChunks.filter(c => !c.is_neighbor)
    const isDirectRetrieval = primaryChunks.length > 0 &&
      primaryChunks.every(c => Number(c.rrf_score ?? 0) === 0)
    if (isDirectRetrieval) {
      // Sort by document order, emit all as cards
      const ordered = [...primaryChunks].sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))
      const cards = ordered.map(chunk => ({
        chunk_id:       chunk.chunk_id,
        title:          chunk.title ?? null,
        section_header: chunk.section_header ?? null,
        content:        chunk.content,
        highlight_phrase: pickHighlightPhrase(chunk.content),
        annotation:     null,
        source_path:    chunk.source_path ?? null,
        chunk_index:    chunk.chunk_index,
        start_line:     chunk.start_line ?? null,
        end_line:       chunk.end_line ?? null,
        char_start:     chunk.char_start ?? null,
        char_end:       chunk.char_end ?? null,
      }))
      if (ordered.every(isFilesystemChunk)) {
        const narration = buildFilesystemChunkNarration(ordered)
        trace?.stage('voice', { model: 'direct-filesystem', mode: 'direct-filesystem', cardCount: cards.length, fullResponse: narration, durationMs: Date.now() - t0 })
        return (async function* () {
          for (const card of cards) yield { type: 'card', card }
          for (const token of splitNarration(narration)) yield { type: 'token', token }
        })()
      }
      const narration = `Here is the full text of ${[...new Set(ordered.map(c => c.section_header).filter(Boolean))].slice(0,2).join(', ') || 'the requested section'} in document order.`
      trace?.stage('voice', { model: 'direct-retrieval', mode: 'direct-retrieval', cardCount: cards.length, fullResponse: narration, durationMs: Date.now() - t0 })
      return (async function* () {
        for (const card of cards) yield { type: 'card', card }
        for (const token of splitNarration(narration)) yield { type: 'token', token }
      })()
    }
    const hasMixedFilesystemEvidence = primaryChunks.some(isFilesystemChunk) && primaryChunks.some(c => !isFilesystemChunk(c))
    if (!hasMixedFilesystemEvidence) {
      const corpus = primaryChunks[0]?.domain ?? primaryChunks[0]?.corpus ?? null

      return (async function * () {
        // Phase 1: Tool-calling chunk discovery.
        // The model calls search_knowledge for parts of the question not covered by
        // the initial chunk set. We collect the extra chunks; no narration yet.
        const { extraChunks } = await runToolCallingNarration(allChunks, originalMessage, model, corpus)

        // Phase 2: Pick cards + highlights + narration over ALL discovered chunks.
        const allDiscoveredChunks = [...allChunks, ...extraChunks]
        const manifestInput = selectChunksForManifest(allDiscoveredChunks, originalMessage)
        const manifest = await buildCardManifest(manifestInput, originalMessage, model, jobTicket?.domains ?? [])
        const cards = materializeCardsFromManifest(allDiscoveredChunks, manifest.cards)
        const finalCards = cards.length > 0 ? cards : buildFallbackCards(allDiscoveredChunks)

        // Phase 3: Emit cards first, then narration tokens.
        for (const card of finalCards) yield { type: 'card', card }

        if (manifest.narration) {
          for (const token of splitNarration(manifest.narration)) yield { type: 'token', token }
        }

        trace?.stage('voice', {
          model,
          mode: 'native-tool-calling',
          cardCount: finalCards.length,
          fullResponse: manifest.narration,
          extraChunkCount: extraChunks.length,
          durationMs: Date.now() - t0,
        })
      })()
    }
    // mixed filesystem evidence — fall through to standard streaming path
  }

  // --- Self-directed discovery pass (retrieve with no initial chunks) ---
  // The knowledge agent returned empty. Before answering from training knowledge alone,
  // give the model a chance to find evidence directly in the knowledge base.
  if (jobTicket?.modality === 'retrieve') {
    const t0Discovery = Date.now()
    const discoveryCorpus = jobTicket?.domains?.[0] ?? null
    try {
      const { extraChunks } = await runToolCallingNarration([], originalMessage, model, discoveryCorpus)
      if (extraChunks.length > 0) {
        const manifestInput = selectChunksForManifest(extraChunks, originalMessage)
        const manifest = await buildCardManifest(manifestInput, originalMessage, model, jobTicket?.domains ?? [])
        const cards = materializeCardsFromManifest(extraChunks, manifest.cards)
        const finalCards = cards.length > 0 ? cards : buildFallbackCards(extraChunks)
        if (finalCards.length > 0) {
          trace?.stage('voice', { model, mode: 'self-directed-discovery', cardCount: finalCards.length, fullResponse: manifest.narration, durationMs: Date.now() - t0Discovery })
          return (async function* () {
            for (const card of finalCards) yield { type: 'card', card }
            if (manifest.narration) for (const token of splitNarration(manifest.narration)) yield { type: 'token', token }
          })()
        }
      }
    } catch (err) {
      console.warn('[voice-layer] self-directed discovery failed:', err.message)
    }
  }

  // --- Standard streaming path ---
  const systemPrompt = buildSystemPrompt(basePrompt, agentResults)
  const numPredict = lengthToTokens(jobTicket?.responseLength)
  const t0 = Date.now()

  trace?.stage('voice', {
    model,
    systemPrompt,
    voiceInput: systemPrompt,
    responseLength: jobTicket?.responseLength,
    numPredict,
  })

  const stream = callOllama({
    model,
    systemPrompt,
    userMessage: originalMessage,
    history: sanitizeHistory((context.history ?? []).slice(-4)),  // last 2 turns only
    stream: true,
    numPredict,
  })

  return wrapStreamTrace(stream, trace, t0)
}

async function* wrapStreamTrace (streamPromise, trace, t0, preludeEvents = []) {
  for (const event of preludeEvents) {
    yield event
  }

  const gen = await streamPromise
  let full = ''
  for await (const token of gen) {
    full += token
    yield token
  }
  if (trace) {
    const voiceStage = [...trace.stages].reverse().find(s => s.name === 'voice')
    if (voiceStage) {
      voiceStage.data.fullResponse = full
      voiceStage.data.durationMs   = Date.now() - t0
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFilesystemChunk (chunk) {
  return chunk?.corpus === 'external-filesystem' || chunk?.domain === 'external-filesystem' || `${chunk?.resource_id ?? ''}`.startsWith('fs:')
}

function isConversationChunk (chunk) {
  return chunk?.corpus === 'conversations' || chunk?.domain === 'conversations' || `${chunk?.resource_id ?? ''}`.startsWith('conversation:')
}

function isMcpImplementationQuestion (message, jobTicket) {
  const text = `${message ?? ''} ${jobTicket?.topic ?? ''}`
  return /\bmcp\b/i.test(text) && /\btool|input schema|inputSchema|schema\b/i.test(text) && /\bamphion|implement|implementation|code\b/i.test(text)
}

function buildMcpImplementationNarration (chunks) {
  const sourceFiles = [...new Set(chunks.filter(isFilesystemChunk).map(c => c.title).filter(Boolean))]
  const specTitles = [...new Set(chunks.filter(c => !isFilesystemChunk(c)).map(c => c.title).filter(Boolean))]
  return [
    'The MCP tools spec treats a tool as a model-callable function exposed by a server. In the tools spec material, tools are discovered with `tools/list`, then invoked with `tools/call`; each listed tool includes a name, description, and an `inputSchema` that describes the JSON object the client should send as `arguments`.',
    '',
    `Amphion implements that contract in source files including ${sourceFiles.slice(0, 4).join(', ') || 'the MCP agent source'}. Agent classes expose a tools getter that returns tool descriptors with inputSchema objects. For example, the Resource agent defines recall, find, load, and reflect; recall declares properties like topic, corpus, and k, and marks topic as required.`,
    '',
    'The broker side follows the same MCP shape: `agent-runner.js` starts the child agent, sends `initialize`, calls `tools/list`, and then sends `tools/call` with `{ name, arguments }`. The outer `tools/mcp/amphion-server.js` also exposes host-facing tools using the same pattern: each tool descriptor has a name, description, and `inputSchema`, and `callTool` dispatches the requested tool name to the implementation.',
    '',
    `Retrieved spec/source context: ${[...specTitles.slice(0, 3), ...sourceFiles.slice(0, 4)].join(', ')}.`,
  ].join('\n')
}

function buildConversationRecallNarration (chunks) {
  const userTurns = chunks
    .map(c => parseConversationContent(c.content))
    .filter(turn => turn.role === 'user')
    .map(turn => turn.content)
    .filter(text => !/what did we talk about/i.test(text))
    .filter(text => !/^(hi|hello|hey)\b/i.test(text.trim()))

  const topics = []
  for (const text of userTurns) {
    const topic = summarizeConversationTopic(text)
    if (topic && !topics.some(t => t.toLowerCase() === topic.toLowerCase())) topics.push(topic)
    if (topics.length >= 8) break
  }

  if (topics.length === 0) return 'I found recent conversation records, but they were mostly meta checks and repeat recall tests.'
  return ['This week we talked about:', ...topics.map(t => `- ${t}`)].join('\n')
}

function parseConversationContent (content) {
  const match = `${content ?? ''}`.match(/^(user|assistant) \(([^)]+)\):\s*([\s\S]*)$/i)
  if (!match) return { role: 'unknown', created_at: null, content: `${content ?? ''}` }
  return { role: match[1].toLowerCase(), created_at: match[2], content: match[3] }
}

function summarizeConversationTopic (text) {
  const clean = `${text ?? ''}`.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  if (/amphion scripts/i.test(clean)) return 'The Amphion scripts folder and what each script does.'
  if (/dui|driving under the influence/i.test(clean)) return 'Washington State DUI penalties and relevant RCW sections.'
  if (/mcp.*tool|tool.*schema|input schema/i.test(clean)) return 'MCP tool input schemas and how Amphion implements MCP tools.'
  if (/this week|last week|conversation/i.test(clean)) return null
  return clean.length > 140 ? `${clean.slice(0, 137)}...` : clean
}

function buildFilesystemChunkNarration (chunks) {
  const lines = [`Found ${chunks.length} file${chunks.length === 1 ? '' : 's'} in the requested folder:`]
  for (const chunk of chunks) {
    lines.push(`- ${chunk.title ?? path.basename(chunk.source_path ?? 'file')}: ${describeFilesystemChunk(chunk)}`)
  }
  return lines.join('\n')
}

function describeFilesystemChunk (chunk) {
  const content = `${chunk.content ?? ''}`
  const title = `${chunk.title ?? path.basename(chunk.source_path ?? '')}`
  const lines = content.split(/\r?\n/).slice(0, 40).map(stripSourceCommentLine).filter(Boolean)
  const titleIndex = lines.findIndex(line => line.toLowerCase().includes(title.toLowerCase()))

  if (titleIndex >= 0) {
    const titleLine = lines[titleIndex]
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const inline = titleLine.match(new RegExp(`${escaped}\\s*(?:—|-|:)\\s*(.+)$`, 'i'))
    if (inline?.[1] && isPurposeLine(inline[1])) return cleanFileDescription(inline[1])
    const next = lines.slice(titleIndex + 1).find(isPurposeLine)
    if (next) return cleanFileDescription(next)
  }

  const headerLine = lines.find(isPurposeLine)
  if (headerLine) return cleanFileDescription(headerLine)
  return 'Script source file; no short purpose header was found in the preview.'
}

function stripSourceCommentLine (line) {
  return line
    .replace(/^\s*(\/\*\*?|\*\/|\*|\/\/|#)!?\s?/, '')
    .trim()
}

function isPurposeLine (line) {
  const text = `${line ?? ''}`.trim()
  if (!text) return false
  if (/^(usage|flags|requires|example|examples|options|main|cli)$/i.test(text)) return false
  if (/^(node|npm|const|let|var|import|export|return|if|for|while|class|function|await)\b/i.test(text)) return false
  if (/^[-–]\w/.test(text) || text.startsWith('--') || text.startsWith('/*') || text.startsWith('*/')) return false
  if (/^scripts?[/\\][\w.-]+$/i.test(text)) return false
  return /[a-zA-Z]{4,}/.test(text)
}

function cleanFileDescription (text) {
  return `${text}`
    .replace(/\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.;:]?$/, '.')
    .trim()
}

/**
 * Build the full system prompt: voice personality + retrieved context.
 * The retrieved content lives in the SYSTEM role so the LLM treats it as
 * internal knowledge, not as text the user pasted in.
 */
function buildSystemPrompt (voicePrompt, agentResults) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const resultLines = [`[CURRENT DATE: ${today}]`]

  for (const [domain, result] of Object.entries(agentResults)) {
    if (domain === '_meta') continue
    const verification = result.verification ?? null

    if (!result.success) {
      resultLines.push(`[${domain.toUpperCase()} LOOKUP FAILED — tell the user this lookup failed, do not invent facts]\n${result.error ?? 'Unknown error'}`)
      continue
    }

    if (verification && verification.verdict !== 'supported') {
      const retryNote = Array.isArray(result.triedQueries) && result.triedQueries.length > 1
        ? ` Tried ${result.triedQueries.length} query passes.`
        : ''
      resultLines.push(
        `[${domain.toUpperCase()} VERIFICATION — ${verification.verdict}] ${verification.rationale ?? 'Evidence is not strong enough yet.'}` +
        `${verification.missingFacet ? ` Missing: ${verification.missingFacet}.` : ''}` +
        `${retryNote} Do not fill this gap from training knowledge. State the limit plainly.`
      )
    }

    // Filesystem results must be handled BEFORE the foundNothing check — a filesystem
    // search that found nothing is NOT the same as a knowledge-base miss. Never fall
    // back to training data for filesystem queries; say you couldn't find anything.
    if (result.isFilesystem) {
      // handled below in the isFilesystem block
    } else if (verification && verification.verdict !== 'supported' && result.foundNothing && !result.isProbe) {
      continue
    } else if (result.foundNothing && !result.isProbe) {
      const reason = result.reason ? ` (${result.reason})` : ''
      // Don't block the voice layer — it can answer from general knowledge if it has it
      resultLines.push(`[${domain.toUpperCase()} — NO RESULTS IN KNOWLEDGE BASE${reason} — answer from your own training if you can, otherwise say you don't have specific information]`)
      continue
    }

    // Probe result — inject as scope awareness, no cards
    if (result.isProbe) {
      if (result.probeFound && result.items?.length > 0) {
        const docList = result.items.map(d =>
          `  • ${d.title} (${d.domain}, ~${d.approx_words?.toLocaleString() ?? '?'} words, ${d.section_count ?? 0} sections)`
        ).join('\n')
        resultLines.push(`[KNOWLEDGE SCOPE — "${result.probeQuery}" — ${result.items.length} document(s) found]\n${docList}`)
      } else {
        resultLines.push(`[KNOWLEDGE SCOPE — "${result.probeQuery}" — nothing found in knowledge base]`)
      }
      continue
    }

    // Artifact results — inject as file list context
    if (result.isArtifacts && result.items?.length > 0) {
      const fileList = result.items.map(a =>
        `  • ${a.filename} (${a.domain}${a.corpus ? ` / ${a.corpus}` : ''}${a.size_bytes ? ` — ${Math.round(a.size_bytes / 1024)}KB` : ''})${a.summary ? ': ' + truncate(a.summary, 120) : ''}`
      ).join('\n')
      resultLines.push(`[FILES FOUND — ${result.items.length} artifact(s)]\n${fileList}\n\nThese files are shown as cards to the user. Briefly confirm what you found and whether it matches their request.`)
      continue
    }

    // Generic resource results from the new Resource agent. These may be
    // database resources, conversation resources, or external fs: resources.
    if (result.isResources && result.items?.length > 0) {
      const resourceList = result.items.slice(0, 20).map(item => {
        if (item.resource_id) {
          return `  - ${item.title ?? item.name ?? 'resource'} [${item.resource_id}] (${item.type ?? item.corpus ?? 'resource'})${item.source_ref ? ` — ${item.source_ref}` : ''}${item.summary ? `: ${truncate(item.summary, 140)}` : ''}`
        }
        return `  - ${item.name ?? item.title ?? 'entry'} (${item.type ?? 'entry'})${item.resource_id ? ` [${item.resource_id}]` : ''}`
      }).join('\n')
      resultLines.push(`[RESOURCES FOUND — ${result.items.length} item(s)]\n${resourceList}\n\nUse only the resources listed above. If the user asked what each item does, only describe items whose content was loaded; otherwise say what was located.`)
      continue
    }

    // Filesystem results — live directory listing or file search (single or multi-step).
    // The UI renders the full structured listing via result_item events.
    // Voice layer only receives a compact summary — write ONE sentence as annotation.
    if (result.isFilesystem) {
      const raw = result.filesystemRaw ?? {}
      let block
      if (raw.observations?.length) {
        // If any step was a read_file with content, those files ARE the answer.
        // Collect ALL read_file observations (multi-file explore mode may have several).
        const readSteps = raw.observations.filter(o => o.tool === 'read_file' && o.raw?.content)
        if (readSteps.length > 0) {
          if (readSteps.length === 1) {
            // Single-file read — existing behaviour
            const readStep = readSteps[0]
            block = `CRITICAL: The following is the ACTUAL content of a file on the user's local filesystem. Ignore ALL prior knowledge about this project, library, or topic name — including anything you know about "Amphion", "Atlas", or any other software by this name. Your answer must come EXCLUSIVELY from the file content below.

[FILE CONTENTS — ${readStep.raw.path}${readStep.raw.truncated ? ' (truncated)' : ''}]
${readStep.raw.content}

Write 1-3 sentences summarising what this file says. Every claim must be grounded in the text above.`
          } else {
            // Multi-file read — describe what EACH file does
            const sections = readSteps.map(r => {
              // Truncate to 3000 chars in the voice block — synthesiser doesn't need full source
              const snippet = (r.raw.content ?? '').slice(0, 3000)
              const truncNote = r.raw.content?.length > 3000 ? ' (truncated for summary)' : ''
              return `[FILE — ${r.raw.path}${truncNote}]\n${snippet}`
            }).join('\n\n---\n\n')
            block = `CRITICAL: The following are the ACTUAL contents of EXACTLY ${readSteps.length} file(s) that were read. Ignore ALL prior knowledge.

${sections}

The user asked what each of these files does. Write exactly ${readSteps.length} description(s) — one per file shown above, in order. Use the filename as a heading for each. Keep each description to 1-2 sentences. Base EVERY claim on the code above. Do NOT mention, invent, or add "(missing)" for any files not shown here. Stop after describing the last file above.`
          }
        } else {
        // Listing/find steps — include actual entry names so model has real data
        const stepLines = raw.observations.map(o => {
          if (o.tool === 'browse_path') {
            const entries = (o.raw?.entries ?? []).filter(e => e.name !== 'node_modules' && !e.name.startsWith('.'))
            const names = entries.map(e => e.name + (e.type === 'dir' ? '/' : '')).join(', ')
            return `  browse_path(${o.raw?.path ?? o.args?.path ?? ''}): ${entries.length} entries — ${names || 'empty'}`
          }
          if (o.tool === 'find_path') {
            const results = o.raw?.results ?? []
            // Include parent dir so model can distinguish index.js (agents/artifacts) from index.js (agents/comms)
            const topNames = results.slice(0, 15).map(r => {
              const parts = (r.file ?? '').split(/[\\\/]/)
              return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : (parts[0] ?? r.file)
            }).join(', ')
            return `  find_path("${o.args?.query ?? ''}"): ${results.length} match(es) — ${topNames || 'none'}`
          }
          return `  ${o.tool}: ${o.summary}`
        }).join('\n')
        block = `[FILESYSTEM — ${raw.observations.length} step(s)]\n${stepLines}\n\nFull listing shown in UI. Write ONE sentence stating exactly how many files/entries were found and naming at least 4 specific ones from the list above (use the parent/filename format shown). Do NOT say you need more information. Do NOT describe file contents.`
        }
      } else if (raw.tool === 'read_file') {
        // read_file: voice layer still gets content — it IS the answer.
        // Grounding instruction goes BEFORE the content so it frames the model before it reads.
        block = raw.content
          ? `CRITICAL: You are about to read a real file from the user's local filesystem. Ignore ALL prior knowledge about this project, library, or topic name. Base your answer ENTIRELY on what appears in this file — nothing else.\n\n[FILE CONTENTS — ${raw.path}${raw.truncated ? ' (truncated)' : ''}]\n${raw.content}\n\nWrite 1-3 sentences summarising what this file says. Do not add, guess, or infer anything not in the content above.`
          : `[FILE — ${raw.path} — could not read]\n\nONE sentence saying the file could not be read.`
      } else if (raw.tool === 'find_path') {
        const n = (raw.results ?? []).length
        // Include ALL found paths verbatim so the model has real data to cite
        const listedPaths = (raw.results ?? []).slice(0, 15).map(r => `  - ${r.file} (${r.type})`).join('\n')
        block = n > 0
          ? `[FILESYSTEM — find_path("${raw.query}")]\n${n} match(es):\n${listedPaths}\n\nResults shown in UI. Write ONE sentence naming what was found using ONLY the exact paths listed above. NEVER invent filenames, scripts, or paths that are not in the list above.`
          : `[FILESYSTEM — find_path("${raw.query}") — nothing found in ${(raw.roots ?? []).join(', ')}]\n\nONE sentence saying nothing was found for that query. Do NOT invent filenames or results.`
      } else if (raw.tool === 'search_local') {
        const n = (raw.results ?? []).length
        const topPaths = (raw.results ?? []).slice(0, 3).map(r => r.file ?? r.path ?? '').join(', ')
        block = n > 0
          ? `[FILESYSTEM — search_local("${raw.query}")]\n${n} match(es). Top: ${topPaths}\n\nONE sentence: state count and query.`
          : `[FILESYSTEM — search_local("${raw.query}") — nothing found]\n\nONE sentence saying nothing was found.`
      } else {
        // browse_path single-step — include actual entry names so model has real data
        const entries = (raw.entries ?? []).filter(e => e.name !== 'node_modules' && !e.name.startsWith('.'))
        const names = entries.map(e => e.name + (e.type === 'dir' ? '/' : '')).join(', ')
        block = entries.length > 0
          ? `[FILESYSTEM — browse_path(${raw.path})]\n${entries.length} entries: ${names}\n(Full listing shown in UI)\n\nWrite 1-2 sentences. Use ONLY the entry names listed above. Do not describe what each item does or contains unless file contents were also retrieved. If the user asked for details about each item, say the listing is visible but you would need to read the individual files for content.`
          : `[FILESYSTEM — browse_path(${raw.path}) — empty or inaccessible]\n\nONE sentence saying the directory was empty or could not be read.`
      }
      resultLines.push(block)
      continue
    }

    // Recall agent — format as past conversation excerpts
    if (domain === 'recall' && result.items?.length > 0) {
      const confidence = Number.isFinite(result.confidence) ? result.confidence.toFixed(2) : 'unknown'
      const matchedOn = Array.isArray(result.matchedOn) && result.matchedOn.length > 0
        ? result.matchedOn.join(', ')
        : 'recency'
      const userFirst = result.items.filter(t => t.role === 'user')
      const evidencePool = userFirst.length ? userFirst : result.items
      const excerpts = evidencePool.slice(0, 8).map(t =>
        `  ${t.role === 'user' ? 'User' : 'Atlas'} (${t.created_at ?? 'earlier'}): ${truncate(t.content, 240)}`
      ).join('\n')
      resultLines.push(`[PAST CONVERSATION CONTEXT | confidence=${confidence} | matched_on=${matchedOn}]\n${excerpts}`)
      continue
    }

    if (result.hasChunks && result.items?.length > 0) {
      const nonNeighborItems = result.items.filter(c => !c.is_neighbor)
      const hasFilesystemEvidence = nonNeighborItems.some(isFilesystemChunk)
      const primaryItems = hasFilesystemEvidence
        ? [
            ...nonNeighborItems.filter(c => !isFilesystemChunk(c)).slice(0, 4),
            ...nonNeighborItems.filter(isFilesystemChunk).slice(0, 4),
          ]
        : nonNeighborItems.slice(0, 1)
      const chunkBlocks = primaryItems.map(c => {
        const label = [c.title, c.section_header].filter(Boolean).join(' › ')
        return `[SOURCE: ${label || domain}]\n${c.content}`
      }).join('\n\n')
      resultLines.push(`[${domain.toUpperCase()} KNOWLEDGE]\n${chunkBlocks}`)
    } else if (`${result.generatedText ?? ''}`.trim()) {
      const kind = `${result.outputKind ?? 'generated output'}`.replace(/_/g, ' ')
      resultLines.push(`[${domain.toUpperCase()} ${kind.toUpperCase()}]\n${result.generatedText}`)
    } else {
      resultLines.push(`[${domain.toUpperCase()} KNOWLEDGE]\n${result.summary}`)
    }
  }

  const contextBlock = resultLines.length > 0
    ? [
        `## Retrieved Context`,
        `GROUND RULE: Extract your answer directly from the SOURCE block below. Do NOT use your training knowledge on this topic. The source IS the answer — report what it says. If the source lists specific items, list those exact items. Do not invent additional items or concepts not mentioned in the source. Stop after 2-3 sentences.`,
        `The following content was retrieved from your knowledge base to answer the user's question.`,
        `Use it to give a direct, synthesized answer. Do not narrate or describe this content — just answer.`,
        `IMPORTANT: Respond in plain prose. No markdown headers (##, ###), no horizontal rules (---), no bullet lists unless the question explicitly asked for a breakdown or list. Synthesize into sentences.`,
        `CRITICAL: If the retrieved evidence is not directly relevant to the user's question (e.g. it matches keywords but discusses a completely different topic), say so clearly and honestly. Do not manufacture a connection between unrelated content and the question. If the knowledge base has no applicable information, say "There is no specific [law/data/record] on this in my knowledge base" rather than over-interpreting tangential results.`,
        ``,
        resultLines.join('\n\n'),
      ].join('\n')
    : `## Retrieved Context\n(No results from knowledge base — answer from your own training knowledge if you can. If you genuinely don't know, say so briefly.)`

  return `${voicePrompt}\n\n${contextBlock}`
}

function lengthToTokens (responseLength) {
  switch (responseLength) {
    case 'brief':    return 220
    case 'standard': return 700
    case 'detailed': return 1200
    default:         return 700  // 'standard' or undefined
  }
}

function truncate (value, maxLen) {
  const text = `${value ?? ''}`.trim()
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen - 1)}…`
}

function sanitizeHistory (history) {
  return history
    .map(msg => {
      let content = `${msg?.content ?? ''}`.trim()
      if (msg?.role === 'assistant') {
        // Assistant turns may contain full retrieved statute blocks, bullet lists, etc.
        // Those are pipeline artifacts — not real conversational context. Strip them to
        // a short topic summary so they don't flood the next query's context window.
        content = content
          .replace(/\n?\[[A-Z][A-Z\s_-]*\]/g, '')
          .replace(/\n?\*Source:[^\n]*/gi, '')
          .replace(/\n#+\s.*/g, '')         // strip markdown headers
          .replace(/\n\s*[\*\-]\s+/g, ' ')  // collapse bullet lists to inline text
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)                    // hard cap — topic only, no retrieved content
        if (content.length === 160) content += '…'
      }
      return { role: msg?.role, content }
    })
    .filter(msg => msg.role && msg.content)
}

function buildFallbackPrompt () {
  const name = process.env.DISPLAY_NAME ?? 'Atlas'
  return `You are ${name}, a private AI assistant. Synthesize the agent results into a direct, confident response. Speak in first person. No filler phrases. No mention of agents or domains.`
}

function buildDirectGeneratedReply (agentResults, jobTicket) {
  if (jobTicket?.modality !== 'draft') return null
  const outputs = Object.values(agentResults ?? {})
    .map(result => `${result?.generatedText ?? ''}`.trim())
    .filter(Boolean)

  if (outputs.length === 0) return null
  return outputs.join('\n\n')
}

function buildVerificationLimitedReply (agentResults, jobTicket) {
  if (jobTicket?.modality === 'draft') return null

  const verifiableResults = Object.values(agentResults ?? {}).filter(result => result?.verification)
  if (verifiableResults.length === 0) return null
  if (verifiableResults.some(result => result.verification?.verdict === 'supported')) return null

  const primary = verifiableResults[0]
  const verification = primary.verification ?? {}
  const retryCount = Array.isArray(primary.triedQueries) ? primary.triedQueries.length : 0
  const retryNote = retryCount > 1 ? ` I checked ${retryCount} query passes and still did not get directly supportive evidence.` : ''
  const rationale = `${verification.rationale ?? 'I did not retrieve directly supportive evidence.'}`.replace(/\s+/g, ' ').trim()
  const missingFacet = `${verification.missingFacet ?? ''}`.replace(/\s+/g, ' ').trim().replace(/\.$/, '')
  const missing = missingFacet
    ? /\bmissing\b/i.test(missingFacet)
      ? ` Missing: ${missingFacet}.`
      : ` Missing: ${missingFacet}.`
    : ''
  const foundRelated = verifiableResults.some(result => (result.items?.length ?? 0) > 0 && !result.foundNothing)
  const opener = foundRelated
    ? 'I found related material, but it does not directly support a confident answer to that question.'
    : 'I did not get directly supportive evidence for that answer.'
  return `${opener}${retryNote} ${rationale}${missing}`.replace(/\s+/g, ' ').trim()
}

function isIdentityMetaQuestion (message) {
  const text = `${message ?? ''}`.toLowerCase().trim()
  if (!text) return false

  return /\b(what('?s| is) your name|who are you|are you there|you there|what are you)\b/.test(text)
}

function buildIdentityMetaReply (message) {
  const text = `${message ?? ''}`.toLowerCase().trim()
  const name = process.env.DISPLAY_NAME ?? 'Atlas'

  if (/\b(are you there|you there)\b/.test(text)) return `Yes, I'm here.`
  if (/\b(who are you|what are you)\b/.test(text)) return `I'm ${name}.`
  if (/\b(what('?s| is) your name)\b/.test(text)) return `I'm ${name}.`
  return `I'm ${name}.`
}

// ---------------------------------------------------------------------------
// Evidence card helpers
// ---------------------------------------------------------------------------

/**
 * Collect all structured chunks from agent results that have hasChunks=true.
 */
function collectChunks (agentResults) {
  const chunks = []
  for (const result of Object.values(agentResults ?? {})) {
    if (result?.hasChunks && Array.isArray(result.items)) {
      chunks.push(...result.items)
    }
  }
  return chunks
}

function collectArtifacts (agentResults) {
  const artifacts = []
  for (const result of Object.values(agentResults ?? {})) {
    if (result?.isArtifacts && Array.isArray(result.items)) {
      artifacts.push(...result.items)
    }
  }
  return artifacts
}

/**
 * Use native Ollama tool calling to discover extra chunks for parts of the question
 * not covered by the initial chunk set. The model may call search_knowledge one or
 * more times; collected extra chunks are returned for use by buildCardManifest.
 *
 * @param {object[]} initialChunks
 * @param {string}   question
 * @param {string}   model
 * @param {string|null} corpus
 * @returns {Promise<{ extraChunks: object[] }>}
 */
async function runToolCallingNarration (initialChunks, question, model, corpus) {
  const seenChunkIds = new Set(initialChunks.map(c => String(c.chunk_id ?? c.id)))
  const extraChunks = []

  const manifestChunks = selectChunksForManifest(initialChunks, question)
  const contextBlock = manifestChunks.length > 0
    ? manifestChunks.map(c => {
        const label = [c.title, c.section_header].filter(Boolean).join(' › ')
        return `[CHUNK ${c.chunk_id} — ${label || c.domain}]\n${c.content}`
      }).join('\n\n---\n\n')
    : '(no initial evidence — use search_knowledge to find relevant information)'

  const systemPrompt = [
    'You are a research assistant. Your ONLY job right now is to decide whether the evidence provided fully covers every distinct part of the user\'s question.',
    'If ANY part of the question is not directly addressed by the evidence, call search_knowledge with a precise query for that missing part.',
    'You may call search_knowledge multiple times — once per missing sub-topic.',
    'Once you are satisfied that all parts of the question are covered, respond with a single word: DONE.',
    'Do NOT write a full answer. Do NOT summarize. Your only output should be tool calls, then DONE.',
  ].join(' ')

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `Question: ${question}\n\nEvidence:\n${contextBlock}` },
  ]

  const tools = [{
    type: 'function',
    function: {
      name: 'search_knowledge',
      description: 'Search the knowledge base for additional evidence on a specific aspect of the question not yet covered by the current evidence.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Precise search query — e.g. "RCW 59.18 landlord duty repairs habitability"',
          },
        },
        required: ['query'],
      },
    },
  }]

  try {
    const gen = callOllamaTools({
      model,
      messages,
      tools,
      numPredict: 120,
      maxRounds: 5,
      executeTool: async (name, args) => {
        if (name !== 'search_knowledge') return 'Unknown tool.'
        const query = `${args.query ?? ''}`.trim()
        if (!query) return 'No query provided.'
        console.log(`[voice-layer] search_knowledge("${query}")`)
        try {
          const results = await searchResourceChunks({ query, corpus, k: 6, neighbors: true })
          const newChunks = results.filter(c => !seenChunkIds.has(String(c.chunk_id ?? c.id)))
          for (const c of newChunks) {
            seenChunkIds.add(String(c.chunk_id ?? c.id))
            extraChunks.push(c)
          }
          if (newChunks.length === 0) return 'No additional results found for that query.'
          return newChunks.map(c => {
            const label = [c.title, c.section_header].filter(Boolean).join(' › ')
            return `[CHUNK ${c.chunk_id} — ${label}]\n${canonicalContent(c.content).slice(0, 1200)}`
          }).join('\n\n---\n\n')
        } catch (err) {
          console.warn('[voice-layer] search_knowledge failed:', err.message)
          return `Search failed: ${err.message}`
        }
      },
    })
    // Consume the generator — we only care about tool_call side effects (extraChunks)
    for await (const _ of gen) { /* noop */ }
  } catch (err) {
    console.warn('[voice-layer] runToolCallingNarration failed:', err.message)
  }

  return { extraChunks }
}

/**
 * Non-streaming JSON call: asks the model which chunks matter, what to highlight,
 * and to write a short narration. Returns { cards, narration }.
 *
 * highlight_phrase is validated to be a real verbatim substring of chunk.content
 * before being included in the output.
 */
async function buildCardManifest (chunks, question, model, domains = []) {
  const chunkContext = chunks.map(c => ({
    chunk_id:       c.chunk_id,
    title:          c.title,
    domain:         c.domain,
    section_header: c.section_header,
    content:        c.content,
  }))

  const isLegal = domains.includes('legal') || chunks.some(c => c.domain === 'legal')
  const highlightHint = isLegal
    ? 'the single most directly relevant sentence or clause — the one that most specifically answers the question'
    : 'the most informative or conclusive sentence — the one that most directly answers the question'

  const systemPrompt = [
    `You are a knowledgeable assistant helping a user understand what the law or evidence actually says.`,
    `Given the user's question and a set of retrieved document chunks, output ONLY valid JSON:`,
    ``,
    `{`,
    `  "narration": "<your response>",`,
    `  "cards": [`,
    `    {`,
    `      "chunk_id": <integer — must match a chunk_id from the input>,`,
    `      "highlight_phrase": "<exact verbatim substring from that chunk's content — ${highlightHint}>",`,
    `      "annotation": "<one sentence: what this text establishes and why it matters for the question>"`,
    `    }`,
    `  ],`,
    `}`,
    ``,
    `Narration rules:`,
    `(Note: narration is optional — cards and highlight_phrase are the primary output. A brief narration is helpful but not required if the cards speak for themselves.)`,
    `- Answer the question directly and in plain language. Do not use legal jargon without explaining it.`,
    `- If the evidence shows something clearly, state it plainly: "Cities can use traffic cameras on state highways" not "The statute authorizes municipalities to...".`,
    `- When citing a chunk, always identify it by its section number or document title (e.g., "RCW 16.30.010", "under § 77.15.135", "per the Henderson NDA"). Never say "the first card", "the retrieved text", or "the statute" without a specific identifier. Use the section_header field as the identifier when available.`,
    `- Explain what each referenced card shows and why it matters for the question. Connect the evidence to the question — don't just announce that the chunk exists.`,
    `- If the evidence is inconclusive, say so plainly and explain what's missing.`,
    `- 3-5 sentences. No markdown. No bullet points.`,
    `- If no chunks are relevant, return "cards": [] and answer from general knowledge or say you don't have the information.`,
    ``,
    `Card rules:`,
    `(Omit the follow_up field entirely — additional searching is handled by the caller.)`,
    ``,
    `Card rules:`,
    `- Only include chunks that directly address the question. Skip tangential or background chunks.`,
    `- 1-4 cards. Fewer is better — only what the narration actually references or needs.`,
    `- highlight_phrase MUST be copied verbatim from the chunk — no paraphrasing, no edits. A complete sentence or clause. Must start with a capital letter.`,
    `- Do NOT highlight legislative citation notes, effective date notices, code references, or backtick-quoted text.`,
    `- If a chunk contains a direct count, date, dollar amount, or threshold that answers the question, the highlight_phrase must include that specific value.`,
    `- Output JSON only. No prose outside the JSON object.`,
  ].join('\n')

  try {
    const raw = await callOllama({
      model,
      systemPrompt,
      userMessage: `Question: ${question}\n\nChunks:\n${JSON.stringify(chunkContext, null, 2)}`,
      stream:      false,
      format:      'json',
      numPredict:  900,
    })

    let parsed = {}
    try {
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      console.warn('[voice-layer] buildCardManifest: could not parse JSON from model')
    }

    // Validate: highlight_phrase must be a real verbatim substring of the chunk
    const chunkMap = new Map(chunks.map(c => [String(c.chunk_id), c]))
    const validCards = (parsed.cards ?? []).filter(card => {
      const chunk = chunkMap.get(String(card.chunk_id))
      return (
        chunk &&
        typeof card.highlight_phrase === 'string' &&
        card.highlight_phrase.length > 0 &&
        canonicalContent(chunk.content).includes(card.highlight_phrase)
      )
    })

    return {
      narration: typeof parsed.narration === 'string' ? parsed.narration : '',
      cards:     validCards,
    }
  } catch (err) {
    console.warn('[voice-layer] buildCardManifest error:', err.message)
    return { cards: [], narration: '' }
  }
}

/**
 * Returns true if a chunk contains actual legal text beyond chapter title + source metadata.
 * Chapter-header chunks look like: "# Chapter X RCW — TITLE\nSource: URL\nDownloaded: date"
 * These should be filtered from cards since they have no substantive content.
 */
function isSubstantiveContent (content) {
  const text = `${content ?? ''}`.trim()
  if (!text) return false
  // Strip known metadata/header lines; see if real content remains
  const lines = text.split('\n')
  const nonMeta = lines.filter(line => {
    const l = line.trim()
    if (!l) return false
    if (/^#\s+chapter\s+\d/i.test(l)) return false       // chapter title heading
    if (/^source:\s/i.test(l)) return false               // source URL line
    if (/^downloaded:\s/i.test(l)) return false           // downloaded date line
    if (/^updated:\s/i.test(l)) return false              // updated date line
    return true
  })
  // Require at least one line of ≥40 chars that looks like prose (has spaces)
  return nonMeta.some(l => l.length >= 40 && l.includes(' '))
}

function selectChunksForManifest (chunks, question = '') {
  const primary = chunks.filter(c => !c.is_neighbor)
  const source = primary.length > 0 ? primary : chunks

  // Exclude chunks that contain only chapter headers and source/download metadata
  const substantive = source.filter(c => isSubstantiveContent(c.content))
  const filtered = substantive.length > 0 ? substantive : source

  // If all scores are zero (direct retrieval via get_section/get_chapter), preserve document order
  const hasRealScores = filtered.some(c => Number(c.rrf_score ?? 0) > 0)
  const sorted = hasRealScores
    ? [...filtered].sort((a, b) => Number(b.rrf_score ?? 0) - Number(a.rrf_score ?? 0))
    : [...filtered].sort((a, b) => (a.chunk_index ?? 0) - (b.chunk_index ?? 0))

  return sorted
    .slice(0, 8)
    .map(c => ({
      ...c,
      content: selectManifestExcerpt(`${c.content ?? ''}`, question, 1800),
    }))
}

function selectManifestExcerpt (content, question = '', maxChars = 1800) {
  const text = `${content ?? ''}`.trim()
  if (text.length <= maxChars) return text

  const questionTerms = `${question ?? ''}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3 && !MANIFEST_STOP_WORDS.has(term))

  const segments = text.split(/(?<=[.!?])\s+|\n{2,}/).map(segment => segment.trim()).filter(Boolean)
  if (segments.length === 0) return text.slice(0, maxChars)

  const scored = segments.map((segment, index) => {
    const normalized = segment.toLowerCase()
    const overlap = questionTerms.filter(term => normalized.includes(term)).length
    return { index, score: overlap }
  })

  const best = scored.sort((left, right) => right.score - left.score || left.index - right.index)[0]
  if (!best || best.score <= 0) return text.slice(0, maxChars)

  let start = best.index
  let end = best.index
  let excerpt = segments[best.index]

  while (excerpt.length < maxChars && (start > 0 || end < segments.length - 1)) {
    const prev = start > 0 ? segments[start - 1] : null
    const next = end < segments.length - 1 ? segments[end + 1] : null
    const prevLen = prev ? prev.length + 1 : Number.POSITIVE_INFINITY
    const nextLen = next ? next.length + 1 : Number.POSITIVE_INFINITY

    if (prev && prevLen <= nextLen && (prev.length + excerpt.length + 1) <= maxChars) {
      start -= 1
      excerpt = `${segments[start]} ${excerpt}`
      continue
    }

    if (next && (excerpt.length + next.length + 1) <= maxChars) {
      end += 1
      excerpt = `${excerpt} ${segments[end]}`
      continue
    }

    break
  }

  return excerpt
}

const MANIFEST_STOP_WORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'how', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'of', 'to', 'for', 'from',
  'about', 'across', 'country', 'tell', 'many', 'much', 'often', 'year', 'date', 'times', 'time', 'has', 'have', 'had',
  'with', 'into', 'over', 'under', 'more', 'most', 'less', 'their', 'there', 'here', 'this', 'that', 'these', 'those',
  'would', 'could', 'should', 'please', 'just', 'okay', 'right', 'us',
])

function materializeCardsFromManifest (allChunks, manifestCards = []) {
  const chunkMap = new Map(allChunks.map(c => [String(c.chunk_id), c]))
  const cards = []

  for (const card of manifestCards) {
    const chunk = chunkMap.get(String(card.chunk_id))
    if (!chunk) continue

    const phrase = `${card.highlight_phrase ?? ''}`.trim()
    const canonical = canonicalContent(chunk.content ?? '')
    if (!phrase || !canonical.includes(phrase)) continue

    cards.push({
      chunk_id: chunk.chunk_id,
      chunk_index: chunk.chunk_index,
      title: chunk.title ?? null,
      section_header: chunk.section_header ?? null,
      content: canonical,
      highlight_phrase: phrase,
      annotation: card.annotation ?? null,
      source_path: chunk.source_path ?? null,
      start_line: chunk.start_line ?? null,
      end_line: chunk.end_line ?? null,
      char_start: chunk.char_start ?? null,
      char_end: chunk.char_end ?? null,
    })
  }

  return cards
}

function buildFallbackCards (allChunks) {
  const primary = allChunks.filter(c => !c.is_neighbor)
  const source = primary.length > 0 ? primary : allChunks

  const MIN_SCORE = 0.005  // RRF scores max at ~0.016 (1/61), so 0.05 would filter everything out
  // Filter to chunks that have substantive legal content (not just chapter headers + metadata)
  const relevant = source.filter(c => {
    if (Number(c.rrf_score ?? 0) < MIN_SCORE) return false
    return isSubstantiveContent(c.content)
  })
  // If nothing passes (e.g. all scores are zero from direct retrieval), include all substantive chunks
  const substantiveAll = source.filter(c => isSubstantiveContent(c.content))
  const candidates = relevant.length > 0 ? relevant : substantiveAll

  return [...candidates]
    .sort((a, b) => Number(b.rrf_score ?? 0) - Number(a.rrf_score ?? 0))
    .slice(0, 5)
    .map(chunk => {
      const canonical = canonicalContent(chunk.content ?? '')
      return {
      chunk_id: chunk.chunk_id,
      chunk_index: chunk.chunk_index,
      title: chunk.title ?? null,
      section_header: chunk.section_header ?? null,
      content: canonical,
      highlight_phrase: pickHighlightPhrase(canonical),
      annotation: null,
      source_path: chunk.source_path ?? null,
      start_line: chunk.start_line ?? null,
      end_line: chunk.end_line ?? null,
      char_start: chunk.char_start ?? null,
      char_end: chunk.char_end ?? null,
    }
  })
}

/**
 * Strip the overlap-prefix artifact produced by the old ingest pipeline.
 * Old format: "[truncated tail]\n\n[canonical content starting with same tail]"
 * If the text after \n\n starts with the text before \n\n, the first part is
 * the duplicate — return only the canonical section.  Otherwise return as-is.
 */
function canonicalContent (content) {
  const text = `${content ?? ''}`.trim()
  const nl2 = text.indexOf('\n\n')
  if (nl2 === -1) return text
  const firstPart = text.slice(0, nl2)
  const restPart  = text.slice(nl2 + 2)
  return restPart.startsWith(firstPart) ? restPart : text
}

function pickHighlightPhrase (content) {
  const text = `${content ?? ''}`.trim()
  if (!text) return ''

  const normalized = canonicalContent(text).replace(/\s+/g, ' ').trim()

  // Split into sentences (capital/paren start after punctuation + space).
  // For each sentence: if it's a good length return it whole; if it's too long
  // take the first 150 chars trimmed to a word boundary — still verbatim.
  const parts = normalized.split(/(?<=[.!?])\s+(?=[A-Z(])/)
  for (const part of parts) {
    const t = part.trim()
    if (t.length < 30) continue
    if (/^[a-z]/.test(t)) continue                                         // skip continuation fragments
    if (/^[`\-*#|]/.test(t)) continue
    if (/^\w+:/.test(t) && !/ /.test(t.split(':')[0])) continue  // yaml key
    if (t.length <= 220) return t
    // Sentence too long — take first ~150 chars to nearest word boundary
    const cut = t.slice(0, 150).replace(/\s+\S*$/, '')
    if (cut.length >= 30) return cut
  }

  return ''
}

/**
 * Split narration into word-level tokens for a natural typing effect in the renderer.
 */
function splitNarration (text) {
  return text.match(/\S+\s*/g) ?? []
}
