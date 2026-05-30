const WORD_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' })
const SENTENCE_SEGMENTER = new Intl.Segmenter('en', { granularity: 'sentence' })

export const CHUNKING_VERSION = 'shape-router-v1'

export const CHUNK_SHAPES = Object.freeze({
  ATOMIC:     'atomic_shortform',
  SECTIONED:  'sectioned_document',
  NARRATIVE:  'narrative_prose',
  REFERENCE:  'reference_enumerated',
  TRANSCRIPT: 'transcript_dialogue',
  LOG:        'dated_entry_stream',
  LIST:       'list_table_form',
  FAQ:        'faq_qa',
  TECHNICAL:  'technical_mixed',
})

const SHAPE_CONFIG = {
  [CHUNK_SHAPES.ATOMIC]:     { targetTokens: 220, maxTokens: 260, minTokens: 1, overlapSentences: 0 },
  [CHUNK_SHAPES.SECTIONED]:  { targetTokens: 320, maxTokens: 420, minTokens: 120, overlapSentences: 1 },
  [CHUNK_SHAPES.NARRATIVE]:  { targetTokens: 300, maxTokens: 380, minTokens: 160, overlapSentences: 1 },
  [CHUNK_SHAPES.REFERENCE]:  { targetTokens: 260, maxTokens: 340, minTokens: 100, overlapSentences: 1 },
  [CHUNK_SHAPES.TRANSCRIPT]: { targetTokens: 300, maxTokens: 380, minTokens: 120, overlapSentences: 1 },
  [CHUNK_SHAPES.LOG]:        { targetTokens: 240, maxTokens: 320, minTokens: 120, overlapSentences: 1 },
  [CHUNK_SHAPES.LIST]:       { targetTokens: 220, maxTokens: 300, minTokens: 100, overlapSentences: 0 },
  [CHUNK_SHAPES.FAQ]:        { targetTokens: 220, maxTokens: 320, minTokens: 100, overlapSentences: 0 },
  [CHUNK_SHAPES.TECHNICAL]:  { targetTokens: 300, maxTokens: 380, minTokens: 120, overlapSentences: 1 },
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/
const CODE_FENCE_RE = /^\s*```/
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const TABLE_ROW_RE = /^\s*\|.+\|\s*$/
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*$/
const KEY_VALUE_RE = /^\s*[A-Za-z][A-Za-z0-9 _/()#.&'-]{1,40}:\s+\S+/
const QA_QUESTION_RE = /^\s*(?:Q(?:uestion)?|FAQ)\s*[:.-]\s+/
const QA_ANSWER_RE = /^\s*A(?:nswer)?\s*[:.-]\s+/
const DATE_ENTRY_RE = /^\s*(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/i
const SPEAKER_TURN_RE = /^\s*(?:\[(?<timestamp>[0-9:\-., TZ]+)\]\s*)?(?<speaker>(?:User|Assistant|System|Speaker\s+\d+|[A-Z][\w.'& -]{1,40}))\s*:\s+(?<body>\S.*)$/
const REFERENCE_ID_RE = /^(?:#{1,6}\s+)?(?<id>(?:RCW\s+)?\d+(?:\.\d+){1,4}[A-Za-z]?|(?:Section|Sec\.?|Article|Clause|Chapter|Requirement|Req\.?|Rule)\s+[A-Za-z0-9_.:-]+|[A-Z]{2,10}-\d{1,6}|(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+)/i
const GENERIC_REFERENCE_RE = /\b(?:RCW\s+\d+(?:\.\d+){1,4}[A-Za-z]?|\d+(?:\.\d+){1,4}[A-Za-z]?|Section\s+[A-Za-z0-9_.:-]+|Article\s+[A-Za-z0-9_.:-]+|Clause\s+[A-Za-z0-9_.:-]+|[A-Z]{2,10}-\d{1,6}|(?:GET|POST|PUT|PATCH|DELETE)\s+\/\S+)\b/i
const ISSUE_KEY_RE = /\b[A-Z]{2,10}-\d{1,6}\b/
const NON_SPEAKER_KEYS = new Set(['source', 'title', 'date', 'downloaded', 'retrieved', 'author', 'summary', 'intent', 'topic'])
const ALLOWED_UPPER_SPEAKERS = new Set(['USER', 'ASSISTANT', 'SYSTEM'])
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'by', 'is', 'are', 'was', 'were', 'be', 'this', 'that', 'these', 'those', 'it', 'its', 'at', 'from'])

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round (value, digits = 4) {
  return Number(value.toFixed(digits))
}

function normalizeText (text) {
  return `${text ?? ''}`
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim()
}

function trimContent (text) {
  return `${text ?? ''}`
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanHeading (text) {
  return `${text ?? ''}`.replace(/^#{1,6}\s+/, '').trim()
}

function tokenizeWords (text) {
  const tokens = []
  for (const segment of WORD_SEGMENTER.segment(`${text ?? ''}`)) {
    if (segment.isWordLike) tokens.push(segment.segment.toLowerCase())
  }
  return tokens
}

function countTokens (text) {
  return tokenizeWords(text).length
}

function splitSentences (text) {
  const sentences = []
  for (const segment of SENTENCE_SEGMENTER.segment(`${text ?? ''}`)) {
    const sentence = segment.segment.trim()
    if (sentence) sentences.push(sentence)
  }
  return sentences
}

function contentTerms (text) {
  return new Set(tokenizeWords(text).filter(token => token.length > 2 && !STOP_WORDS.has(token)))
}

function similarity (left, right) {
  const a = contentTerms(left)
  const b = contentTerms(right)
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const token of a) if (b.has(token)) overlap += 1
  return overlap / Math.sqrt(a.size * b.size)
}

function commonPrefix (paths) {
  if (!Array.isArray(paths) || paths.length === 0) return []
  const first = paths[0] ?? []
  const prefix = []
  for (let index = 0; index < first.length; index += 1) {
    const part = first[index]
    if (paths.every(path => path[index] === part)) prefix.push(part)
    else break
  }
  return prefix
}

function uniqueKey (value) {
  if (Array.isArray(value)) return value.join(' > ')
  return `${value ?? ''}`
}

function isDivider (text) {
  return /^-{3,}$/.test(text) || /^={3,}$/.test(text)
}

function isDateEntryHeader (text) {
  return text.length <= 90 && (DATE_ENTRY_RE.test(text) || ISSUE_KEY_RE.test(text))
}

function isCapitalizedNameWord (word) {
  return /^[A-Z][a-z]+(?:['.-][A-Za-z]+)?$/.test(word)
}

function looksLikePlainHeading (text) {
  const trimmed = `${text ?? ''}`.trim()
  if (!trimmed || trimmed.length > 100 || /[.:;?!]$/.test(trimmed) || KEY_VALUE_RE.test(trimmed)) return false
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length === 0 || words.length > 10) return false
  const letters = [...trimmed].filter(char => /[A-Za-z]/.test(char))
  const uppercase = letters.filter(char => /[A-Z]/.test(char)).length
  const uppercaseRatio = letters.length > 0 ? uppercase / letters.length : 0
  const titleLike = words.every(word => /^[A-Z0-9]/.test(word) || ['—', '-', '&'].includes(word))
  return uppercaseRatio > 0.45 || titleLike
}

function detectSpeakerTurn (text) {
  const match = text.match(SPEAKER_TURN_RE)
  if (!match) return null
  const speaker = match.groups?.speaker?.trim() ?? null
  if (!speaker || NON_SPEAKER_KEYS.has(speaker.toLowerCase())) return null
  const timestamp = match.groups?.timestamp?.trim() ?? null
  const words = speaker.split(/\s+/).filter(Boolean)
  if (words.length > 3) return null
  if (/^[A-Z][A-Z ]+$/.test(speaker) && !ALLOWED_UPPER_SPEAKERS.has(speaker) && !/^Speaker\s+\d+$/i.test(speaker)) return null
  if (ALLOWED_UPPER_SPEAKERS.has(speaker) || /^Speaker\s+\d+$/i.test(speaker)) return { speaker, timestamp }
  if (timestamp && words.every(isCapitalizedNameWord)) return { speaker, timestamp }
  if (words.length >= 2 && words.every(isCapitalizedNameWord)) return { speaker, timestamp }
  return null
}

function extractReferenceIdentifier (text) {
  const exact = `${text ?? ''}`.trim().match(REFERENCE_ID_RE)
  if (exact?.groups?.id) return exact.groups.id.trim()
  const loose = `${text ?? ''}`.match(GENERIC_REFERENCE_RE)
  return loose?.[0]?.trim() ?? null
}

function compactLabel (text) {
  return cleanHeading(`${text ?? ''}`).replace(/\s+/g, ' ').trim()
}

function buildEmbeddingText ({ title = null, sectionPath = [], locator = null, content }) {
  const context = []
  if (`${title ?? ''}`.trim()) context.push(`Title: ${`${title}`.trim()}`)
  if (sectionPath.length > 0) context.push(`Section: ${sectionPath.join(' > ')}`)
  else if (`${locator ?? ''}`.trim()) context.push(`Locator: ${`${locator}`.trim()}`)
  return context.length > 0 ? `${context.join('\n')}\n\n${content}` : content
}

function createChunk ({ title, shape, content, sectionPath = [], sectionHeader = null, locator = null }) {
  const trimmed = trimContent(content)
  const cleanedPath = Array.isArray(sectionPath) ? sectionPath.filter(Boolean).map(part => compactLabel(part)) : []
  const header = sectionHeader ?? null
  return {
    content: trimmed,
    sectionPath: cleanedPath,
    sectionHeader: header,
    locator: locator ?? cleanedPath.at(-1) ?? null,
    tokenCount: countTokens(trimmed),
    embeddingText: buildEmbeddingText({ title, sectionPath: cleanedPath, locator, content: trimmed }),
    shape,
  }
}

function createUnit ({ text, sectionPath = [], sectionHeader = null, locator = null, preserve = false, groupKey = null, kind = 'unit', turnCount = 1 }) {
  const content = trimContent(text)
  return {
    content,
    sectionPath: sectionPath.filter(Boolean).map(part => compactLabel(part)),
    sectionHeader,
    locator: locator ?? null,
    preserve,
    groupKey: groupKey ?? uniqueKey(sectionPath),
    kind,
    turnCount,
    tokenCount: countTokens(content),
  }
}

function mergeUnitPair (left, right) {
  const prefix = commonPrefix([left.sectionPath, right.sectionPath])
  const leftLabel = left.sectionPath.length > prefix.length ? left.sectionPath.slice(prefix.length).join(' > ') : (left.locator ?? null)
  const rightLabel = right.sectionPath.length > prefix.length ? right.sectionPath.slice(prefix.length).join(' > ') : (right.locator ?? null)
  const leftContent = leftLabel && !left.content.toLowerCase().startsWith(leftLabel.toLowerCase()) ? `${leftLabel}\n\n${left.content}` : left.content
  const rightContent = rightLabel && !right.content.toLowerCase().startsWith(rightLabel.toLowerCase()) ? `${rightLabel}\n\n${right.content}` : right.content
  const sharedHeader = prefix.length > 0 ? prefix.at(-1) : (left.sectionHeader ?? right.sectionHeader ?? null)
  return createUnit({
    text: `${leftContent}\n\n${rightContent}`,
    sectionPath: prefix,
    sectionHeader: sharedHeader,
    locator: left.locator ?? right.locator ?? null,
    preserve: left.preserve || right.preserve,
    groupKey: prefix.length > 0 ? uniqueKey(prefix) : `${left.groupKey}|${right.groupKey}`,
    kind: left.kind,
    turnCount: (left.turnCount ?? 1) + (right.turnCount ?? 1),
  })
}

function splitWordsFallback (text, maxTokens, overlapTokens) {
  const words = `${text ?? ''}`.split(/\s+/).filter(Boolean)
  const chunks = []
  if (words.length === 0) return chunks
  let index = 0
  while (index < words.length) {
    const slice = words.slice(index, index + maxTokens).join(' ')
    if (slice) chunks.push(slice)
    if (index + maxTokens >= words.length) break
    index += Math.max(1, maxTokens - overlapTokens)
  }
  return chunks
}

function splitOversizedUnit (unit, config, overlapSentences = config.overlapSentences ?? 0) {
  const sentences = splitSentences(unit.content)
  const parts = []
  let overlapTokens = 0

  if (sentences.length <= 1) {
    const fallback = splitWordsFallback(unit.content, config.maxTokens, Math.min(30, Math.floor(config.maxTokens * 0.12)))
    const derived = fallback.map(text => createUnit({
      text,
      sectionPath: unit.sectionPath,
      sectionHeader: unit.sectionHeader,
      locator: unit.locator,
      preserve: unit.preserve,
      groupKey: unit.groupKey,
      kind: unit.kind,
      turnCount: unit.turnCount,
    }))
    if (derived.length > 1) overlapTokens = (derived.length - 1) * Math.min(30, Math.floor(config.maxTokens * 0.12))
    return { units: derived, overlapTokens, brokenStructures: unit.preserve && derived.length > 1 ? 1 : 0 }
  }

  let current = []
  let currentTokens = 0
  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence)
    if (sentenceTokens > config.maxTokens) {
      const wordParts = splitWordsFallback(sentence, config.maxTokens, Math.min(30, Math.floor(config.maxTokens * 0.12)))
      if (current.length > 0) {
        parts.push(current.join(' '))
        current = []
        currentTokens = 0
      }
      parts.push(...wordParts)
      if (wordParts.length > 1) overlapTokens += (wordParts.length - 1) * Math.min(30, Math.floor(config.maxTokens * 0.12))
      continue
    }
    if (currentTokens > 0 && currentTokens + sentenceTokens > config.maxTokens) {
      parts.push(current.join(' '))
      const overlap = overlapSentences > 0 ? current.slice(-overlapSentences) : []
      overlapTokens += overlap.reduce((sum, part) => sum + countTokens(part), 0)
      current = [...overlap, sentence]
      currentTokens = countTokens(current.join(' '))
      continue
    }
    current.push(sentence)
    currentTokens += sentenceTokens
  }
  if (current.length > 0) parts.push(current.join(' '))

  const derived = parts.map(text => createUnit({
    text,
    sectionPath: unit.sectionPath,
    sectionHeader: unit.sectionHeader,
    locator: unit.locator,
    preserve: unit.preserve,
    groupKey: unit.groupKey,
    kind: unit.kind,
    turnCount: unit.turnCount,
  }))

  return {
    units: derived,
    overlapTokens,
    brokenStructures: unit.preserve && derived.length > 1 ? 1 : 0,
  }
}

function parseBlocks (text) {
  const normalized = normalizeText(text)
  if (!normalized) return []

  const lines = normalized.split('\n')
  const blocks = []
  const sectionStack = []
  let paragraphLines = []

  function currentSectionPath () {
    return sectionStack.map(item => item.clean)
  }

  function currentSectionHeader () {
    return sectionStack.at(-1)?.raw ?? null
  }

  function pushParagraph () {
    const textValue = trimContent(paragraphLines.join('\n'))
    paragraphLines = []
    if (!textValue) return
    blocks.push({
      type: 'paragraph',
      text: textValue,
      sectionPath: currentSectionPath(),
      sectionHeader: currentSectionHeader(),
      locator: extractReferenceIdentifier(textValue),
      tokenCount: countTokens(textValue),
    })
  }

  let index = 0
  while (index < lines.length) {
    const rawLine = lines[index]
    const trimmed = rawLine.trim()
    const nextTrimmed = lines[index + 1]?.trim() ?? ''

    if (!trimmed) {
      pushParagraph()
      index += 1
      continue
    }

    if (CODE_FENCE_RE.test(trimmed)) {
      pushParagraph()
      const codeLines = [rawLine]
      index += 1
      while (index < lines.length) {
        codeLines.push(lines[index])
        if (CODE_FENCE_RE.test(lines[index].trim())) {
          index += 1
          break
        }
        index += 1
      }
      const code = codeLines.join('\n').trimEnd()
      blocks.push({
        type: 'code_block',
        text: code,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: countTokens(code),
      })
      continue
    }

    const headingMatch = rawLine.match(HEADING_RE)
    if (headingMatch) {
      pushParagraph()
      const level = headingMatch[1].length
      const clean = compactLabel(headingMatch[2])
      sectionStack.splice(level - 1)
      sectionStack[level - 1] = { raw: rawLine.trim(), clean }
      blocks.push({
        type: 'heading',
        text: clean,
        raw: rawLine.trim(),
        level,
        sectionPath: currentSectionPath(),
        sectionHeader: rawLine.trim(),
        locator: extractReferenceIdentifier(rawLine.trim()),
        tokenCount: countTokens(clean),
      })
      index += 1
      continue
    }

    if (looksLikePlainHeading(trimmed) && isDivider(nextTrimmed)) {
      pushParagraph()
      const level = nextTrimmed.startsWith('=') ? 1 : 2
      const clean = compactLabel(trimmed)
      sectionStack.splice(level - 1)
      sectionStack[level - 1] = { raw: trimmed, clean }
      blocks.push({
        type: 'heading',
        text: clean,
        raw: trimmed,
        level,
        sectionPath: currentSectionPath(),
        sectionHeader: trimmed,
        locator: extractReferenceIdentifier(trimmed),
        tokenCount: countTokens(clean),
      })
      index += 2
      continue
    }

    if (isDivider(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'divider',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: 0,
      })
      index += 1
      continue
    }

    if (TABLE_ROW_RE.test(trimmed) || TABLE_SEPARATOR_RE.test(trimmed)) {
      pushParagraph()
      const tableLines = [rawLine]
      index += 1
      while (index < lines.length) {
        const next = lines[index].trim()
        if (!next || (!TABLE_ROW_RE.test(next) && !TABLE_SEPARATOR_RE.test(next))) break
        tableLines.push(lines[index])
        index += 1
      }
      const table = tableLines.join('\n').trimEnd()
      blocks.push({
        type: 'table_block',
        text: table,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: countTokens(table),
      })
      continue
    }

    if (QA_QUESTION_RE.test(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'qa_question',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    if (QA_ANSWER_RE.test(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'qa_answer',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    if (isDateEntryHeader(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'date_entry',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: ISSUE_KEY_RE.test(trimmed) ? trimmed.match(ISSUE_KEY_RE)?.[0] ?? trimmed : trimmed,
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    const speaker = detectSpeakerTurn(trimmed)
    if (speaker) {
      pushParagraph()
      blocks.push({
        type: 'speaker_turn',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: speaker.speaker,
        speaker: speaker.speaker,
        timestamp: speaker.timestamp,
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    if (LIST_ITEM_RE.test(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'list_item',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: extractReferenceIdentifier(trimmed),
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    if (KEY_VALUE_RE.test(trimmed)) {
      pushParagraph()
      blocks.push({
        type: 'key_value',
        text: trimmed,
        sectionPath: currentSectionPath(),
        sectionHeader: currentSectionHeader(),
        locator: null,
        tokenCount: countTokens(trimmed),
      })
      index += 1
      continue
    }

    paragraphLines.push(rawLine)
    index += 1
  }

  pushParagraph()
  return blocks
}

function extractFeatures (text, blocks) {
  const contentBlocks = blocks.filter(block => !['heading', 'divider'].includes(block.type))
  const headingBlocks = blocks.filter(block => block.type === 'heading')
  const paragraphBlocks = blocks.filter(block => block.type === 'paragraph')
  const speakerBlocks = blocks.filter(block => block.type === 'speaker_turn')
  const referenceBlocks = blocks.filter(block => block.locator || (block.type === 'heading' && extractReferenceIdentifier(block.raw ?? block.text)))
  const listBlocks = blocks.filter(block => block.type === 'list_item')
  const tableBlocks = blocks.filter(block => block.type === 'table_block')
  const keyValueBlocks = blocks.filter(block => block.type === 'key_value')
  const dateBlocks = blocks.filter(block => block.type === 'date_entry')
  const qaQuestionBlocks = blocks.filter(block => block.type === 'qa_question')
  const qaAnswerBlocks = blocks.filter(block => block.type === 'qa_answer')
  const codeBlocks = blocks.filter(block => block.type === 'code_block')
  const uniqueSpeakerCount = new Set(speakerBlocks.map(block => block.speaker)).size
  const repeatedSpeakerCount = speakerBlocks.length - uniqueSpeakerCount

  const totalBlocks = Math.max(1, blocks.length)
  const totalTokens = Math.max(1, countTokens(text))
  const avgParagraphTokens = paragraphBlocks.length > 0
    ? paragraphBlocks.reduce((sum, block) => sum + block.tokenCount, 0) / paragraphBlocks.length
    : 0

  let alternations = 0
  for (let index = 1; index < speakerBlocks.length; index += 1) {
    if (speakerBlocks[index].speaker !== speakerBlocks[index - 1].speaker) alternations += 1
  }
  const turnAlternation = speakerBlocks.length > 1 ? alternations / (speakerBlocks.length - 1) : 0

  let questionLikePairs = 0
  for (let index = 0; index < paragraphBlocks.length - 1; index += 1) {
    if (paragraphBlocks[index].text.trim().endsWith('?')) questionLikePairs += 1
  }

  const headingLevels = new Set(headingBlocks.map(block => block.level))
  const faqHeadingCount = headingBlocks.filter(block => /\b(faq|q\s*&\s*a|questions?)\b/i.test(block.text)).length
  const referenceHeadingCount = headingBlocks.filter(block => extractReferenceIdentifier(block.raw ?? block.text)).length

  const repeatedPrefixCounts = new Map()
  for (const block of contentBlocks) {
    const prefix = tokenizeWords(block.text).slice(0, 4).map(token => token.replace(/\d+/g, '#')).join(' ')
    if (!prefix) continue
    repeatedPrefixCounts.set(prefix, (repeatedPrefixCounts.get(prefix) ?? 0) + 1)
  }
  const repeatedPrefixMax = [...repeatedPrefixCounts.values()].reduce((max, count) => Math.max(max, count), 0)
  const repeatedTemplateScore = contentBlocks.length > 0 ? repeatedPrefixMax / contentBlocks.length : 0

  const structureDensity = (
    headingBlocks.length + listBlocks.length + tableBlocks.length + keyValueBlocks.length + speakerBlocks.length +
    dateBlocks.length + qaQuestionBlocks.length + qaAnswerBlocks.length + codeBlocks.length + referenceBlocks.length
  ) / totalBlocks

  return {
    totalTokens,
    totalBlocks,
    contentBlockCount: contentBlocks.length,
    headingCount: headingBlocks.length,
    headingDensity: headingBlocks.length / totalBlocks,
    hierarchicalHeadings: headingLevels.size >= 2,
    paragraphCount: paragraphBlocks.length,
    avgParagraphTokens,
    referenceCount: referenceBlocks.length,
    referenceDensity: referenceBlocks.length / totalBlocks,
    referenceHeadingCount,
    listCount: listBlocks.length,
    listDensity: listBlocks.length / totalBlocks,
    tableBlockCount: tableBlocks.length,
    tableDensity: tableBlocks.length / totalBlocks,
    keyValueCount: keyValueBlocks.length,
    keyValueDensity: keyValueBlocks.length / totalBlocks,
    speakerTurnCount: speakerBlocks.length,
    speakerTurnDensity: speakerBlocks.length / totalBlocks,
    uniqueSpeakerCount,
    repeatedSpeakerCount,
    timestampCount: speakerBlocks.filter(block => block.timestamp).length,
    turnAlternation,
    dateEntryCount: dateBlocks.length,
    dateEntryDensity: dateBlocks.length / totalBlocks,
    qaQuestionCount: qaQuestionBlocks.length,
    qaAnswerCount: qaAnswerBlocks.length,
    qaPairCount: Math.min(qaQuestionBlocks.length, qaAnswerBlocks.length),
    questionLikePairs,
    faqHeadingCount,
    codeBlockCount: codeBlocks.length,
    codeDensity: codeBlocks.length / totalBlocks,
    repeatedTemplateScore,
    structureDensity,
  }
}

function scoreShapes (features) {
  const scores = new Map()

  scores.set(CHUNK_SHAPES.ATOMIC,
    (features.totalTokens <= 220 ? 10 : features.totalTokens <= 320 ? 4 : -4) +
    (features.structureDensity < 0.18 ? 3 : 0) +
    (features.headingCount === 0 ? 1 : -1) +
    (features.speakerTurnCount + features.qaPairCount + features.referenceCount > 1 ? -4 : 0))

  scores.set(CHUNK_SHAPES.SECTIONED,
    (features.headingCount >= 2 ? 8 : features.headingCount === 1 ? 3 : 0) +
    (features.hierarchicalHeadings ? 3 : 0) +
    (features.headingDensity > 0.12 ? 2 : 0) +
    (features.referenceHeadingCount >= 1 ? 1 : 0) +
    (features.speakerTurnCount > 0 ? -3 : 0))

  scores.set(CHUNK_SHAPES.NARRATIVE,
    (features.paragraphCount >= 2 ? 4 : 0) +
    (features.avgParagraphTokens > 45 ? 3 : features.avgParagraphTokens > 25 ? 1 : 0) +
    (features.structureDensity < 0.18 ? 4 : 0) +
    (features.headingCount <= 1 ? 2 : 0) +
    (features.listDensity > 0.2 || features.codeDensity > 0.08 || features.referenceDensity > 0.12 ? -3 : 0))

  scores.set(CHUNK_SHAPES.REFERENCE,
    (features.referenceCount >= 2 ? 8 : features.referenceCount === 1 ? 3 : 0) +
    (features.referenceHeadingCount >= 1 ? 3 : 0) +
    (features.headingDensity > 0.12 ? 1 : 0) +
    (features.qaPairCount > 0 || features.speakerTurnCount > 0 ? -2 : 0))

  scores.set(CHUNK_SHAPES.TRANSCRIPT,
    (features.speakerTurnCount >= 3 ? 6 : features.speakerTurnCount === 2 ? 2 : 0) +
    (features.repeatedSpeakerCount >= 1 ? 3 : -3) +
    (features.uniqueSpeakerCount > 0 && features.uniqueSpeakerCount <= 4 ? 1 : -2) +
    (features.turnAlternation > 0.45 ? 2 : 0) +
    (features.timestampCount > 0 ? 2 : 0) +
    (features.keyValueDensity > 0.2 ? -3 : 0))

  scores.set(CHUNK_SHAPES.LOG,
    (features.dateEntryCount >= 2 ? 8 : features.dateEntryCount === 1 ? 3 : 0) +
    (features.repeatedTemplateScore > 0.2 ? 2 : 0) +
    (features.referenceCount > 0 && features.headingCount === 0 ? 1 : 0) +
    (features.speakerTurnCount > 0 ? -2 : 0))

  scores.set(CHUNK_SHAPES.LIST,
    ((features.listDensity > 0.2 || features.tableDensity > 0.12 || features.keyValueDensity > 0.15) ? 6 : 0) +
    (features.tableBlockCount > 0 ? 2 : 0) +
    (features.keyValueCount >= 3 ? 2 : 0) +
    (features.avgParagraphTokens < 25 ? 1 : 0))

  scores.set(CHUNK_SHAPES.FAQ,
    (features.qaPairCount >= 2 ? 10 : features.qaPairCount === 1 ? 4 : 0) +
    (features.questionLikePairs >= 1 ? 3 : 0) +
    (features.faqHeadingCount > 0 ? 2 : 0) +
    (features.codeBlockCount > 0 ? -2 : 0))

  scores.set(CHUNK_SHAPES.TECHNICAL,
    (features.codeBlockCount > 0 ? 8 : 0) +
    (features.codeDensity > 0.08 ? 2 : 0) +
    (features.headingCount > 0 ? 2 : 0) +
    (features.referenceCount > 0 && features.codeBlockCount === 0 ? -1 : 0))

  return [...scores.entries()]
    .map(([shape, score]) => ({ shape, score: round(score, 3) }))
    .sort((left, right) => right.score - left.score)
}

function mergeSmallNeighbors (units, config, canMerge) {
  const merged = []
  let index = 0
  while (index < units.length) {
    let current = units[index]
    while (
      current.tokenCount < config.minTokens &&
      index + 1 < units.length &&
      canMerge(current, units[index + 1]) &&
      current.tokenCount + units[index + 1].tokenCount <= config.targetTokens
    ) {
      current = mergeUnitPair(current, units[index + 1])
      index += 1
    }
    merged.push(current)
    index += 1
  }
  return merged
}

function packUnits (units, config, options = {}) {
  const chunks = []
  let overlapTokens = 0
  let brokenStructures = 0
  let preservedUnits = 0
  const maxUnitsPerChunk = options.maxUnitsPerChunk ?? Number.POSITIVE_INFINITY
  const minUnitsToFlush = options.minUnitsToFlush ?? 1
  const respectGroupBoundary = Boolean(options.respectGroupBoundary)

  let current = []
  let currentTokens = 0

  function flush () {
    if (current.length === 0) return
    const sectionPaths = current.map(unit => unit.sectionPath)
    const prefix = commonPrefix(sectionPaths)
    const distinctPaths = new Set(sectionPaths.map(path => uniqueKey(path)))
    const content = current
      .map(unit => {
        if (distinctPaths.size === 1) return unit.content
        const label = unit.sectionPath.length > prefix.length
          ? unit.sectionPath.slice(prefix.length).join(' > ')
          : (unit.locator ?? null)
        if (!label || unit.content.toLowerCase().startsWith(label.toLowerCase())) return unit.content
        return `${label}\n\n${unit.content}`
      })
      .join('\n\n')
    const sectionPath = distinctPaths.size === 1 ? current[0].sectionPath : prefix
    const sectionHeader = distinctPaths.size === 1
      ? current[0].sectionHeader
      : (sectionPath.length > 0 ? sectionPath.at(-1) : current[0].sectionHeader ?? null)
    chunks.push({
      content,
      sectionPath,
      sectionHeader,
      locator: current[0].locator ?? null,
    })
    current = []
    currentTokens = 0
  }

  for (const unit of units) {
    if (unit.preserve) preservedUnits += 1

    if (unit.tokenCount > config.maxTokens) {
      flush()
      const split = splitOversizedUnit(unit, config, options.overlapSentences ?? config.overlapSentences)
      overlapTokens += split.overlapTokens
      brokenStructures += split.brokenStructures
      for (const derived of split.units) {
        chunks.push({
          content: derived.content,
          sectionPath: derived.sectionPath,
          sectionHeader: derived.sectionHeader,
          locator: derived.locator,
        })
      }
      continue
    }

    const exceedsTokenTarget = currentTokens > 0 && currentTokens + unit.tokenCount > config.targetTokens
    const exceedsUnitCount = current.length >= maxUnitsPerChunk
    const changesGroup = respectGroupBoundary && current.length > 0 && unit.groupKey !== current[0].groupKey

    if ((exceedsTokenTarget || exceedsUnitCount || changesGroup) && (current.length >= minUnitsToFlush || currentTokens >= config.minTokens)) {
      flush()
    }

    current.push(unit)
    currentTokens += unit.tokenCount
  }

  flush()

  return {
    chunks,
    stats: { overlapTokens, brokenStructures, preservedUnits },
  }
}

function buildSectionUnits (blocks) {
  const units = []
  const contentBlocks = blocks.filter(block => !['heading', 'divider'].includes(block.type))
  let current = []
  let currentKey = null

  function flush () {
    if (current.length === 0) return
    const first = current[0]
    units.push(createUnit({
      text: current.map(block => block.text).join('\n\n'),
      sectionPath: first.sectionPath,
      sectionHeader: first.sectionHeader,
      locator: first.locator ?? first.sectionPath.at(-1) ?? null,
      preserve: first.sectionPath.length > 0,
      groupKey: currentKey,
      kind: 'section',
    }))
    current = []
    currentKey = null
  }

  for (const block of contentBlocks) {
    const key = uniqueKey(block.sectionPath)
    if (current.length > 0 && key !== currentKey) flush()
    current.push(block)
    currentKey = key
  }
  flush()
  return units
}

function buildReferenceUnits (blocks) {
  const sectionUnits = buildSectionUnits(blocks)
  const headingReferenceUnits = sectionUnits.filter(unit => extractReferenceIdentifier(unit.sectionHeader ?? unit.sectionPath.at(-1) ?? '') != null)
  if (headingReferenceUnits.length >= 2) {
    return headingReferenceUnits.map(unit => createUnit({
      text: unit.content,
      sectionPath: unit.sectionPath,
      sectionHeader: unit.sectionHeader,
      locator: extractReferenceIdentifier(unit.sectionHeader ?? unit.sectionPath.at(-1) ?? '') ?? unit.locator,
      preserve: true,
      groupKey: uniqueKey(unit.sectionPath.slice(0, -1)),
      kind: 'reference',
    }))
  }

  const units = []
  let current = null
  for (const block of blocks.filter(candidate => !['heading', 'divider'].includes(candidate.type))) {
    const locator = block.locator ?? extractReferenceIdentifier(block.text)
    if (!current || locator) {
      if (current) units.push(current)
      current = createUnit({
        text: block.text,
        sectionPath: locator ? [...block.sectionPath, compactLabel(locator)] : block.sectionPath,
        sectionHeader: locator ?? block.sectionHeader,
        locator: locator ?? null,
        preserve: locator != null,
        groupKey: uniqueKey(block.sectionPath),
        kind: 'reference',
      })
      continue
    }
    current = createUnit({
      text: `${current.content}\n\n${block.text}`,
      sectionPath: current.sectionPath,
      sectionHeader: current.sectionHeader,
      locator: current.locator,
      preserve: current.preserve,
      groupKey: current.groupKey,
      kind: 'reference',
    })
  }
  if (current) units.push(current)
  return units
}

function buildNarrativeUnits (blocks) {
  const narrativeBlocks = blocks.filter(block => ['paragraph', 'list_item', 'key_value'].includes(block.type))
  return narrativeBlocks.map(block => createUnit({
    text: block.text,
    sectionPath: block.sectionPath,
    sectionHeader: block.sectionHeader,
    locator: block.locator,
    preserve: false,
    groupKey: uniqueKey(block.sectionPath),
    kind: block.type,
  }))
}

function buildTranscriptUnits (blocks) {
  return blocks
    .filter(block => block.type === 'speaker_turn')
    .map(block => createUnit({
      text: block.text,
      sectionPath: block.sectionPath,
      sectionHeader: block.sectionHeader,
      locator: block.speaker,
      preserve: true,
      groupKey: uniqueKey(block.sectionPath),
      kind: 'speaker_turn',
      turnCount: 1,
    }))
}

function buildLogUnits (blocks) {
  const units = []
  let current = null
  for (const block of blocks.filter(candidate => !['heading', 'divider'].includes(candidate.type))) {
    if (block.type === 'date_entry') {
      if (current) units.push(current)
      current = createUnit({
        text: block.text,
        sectionPath: [...block.sectionPath, compactLabel(block.text)],
        sectionHeader: block.text,
        locator: block.locator ?? block.text,
        preserve: true,
        groupKey: uniqueKey(block.sectionPath),
        kind: 'log_entry',
      })
      continue
    }
    if (!current) {
      current = createUnit({
        text: block.text,
        sectionPath: block.sectionPath,
        sectionHeader: block.sectionHeader,
        locator: block.locator,
        preserve: false,
        groupKey: uniqueKey(block.sectionPath),
        kind: 'log_entry',
      })
      continue
    }
    current = createUnit({
      text: `${current.content}\n\n${block.text}`,
      sectionPath: current.sectionPath,
      sectionHeader: current.sectionHeader,
      locator: current.locator,
      preserve: current.preserve,
      groupKey: current.groupKey,
      kind: 'log_entry',
    })
  }
  if (current) units.push(current)
  return units
}

function buildListUnits (blocks) {
  const units = []
  const candidates = blocks.filter(block => ['list_item', 'table_block', 'key_value'].includes(block.type))
  let keyValueBuffer = []

  function flushKeyValues () {
    if (keyValueBuffer.length === 0) return
    const first = keyValueBuffer[0]
    units.push(createUnit({
      text: keyValueBuffer.map(block => block.text).join('\n'),
      sectionPath: first.sectionPath,
      sectionHeader: first.sectionHeader,
      locator: first.sectionPath.at(-1) ?? null,
      preserve: true,
      groupKey: uniqueKey(first.sectionPath),
      kind: 'key_value_group',
    }))
    keyValueBuffer = []
  }

  for (const block of candidates) {
    if (block.type === 'key_value') {
      keyValueBuffer.push(block)
      continue
    }
    flushKeyValues()
    units.push(createUnit({
      text: block.text,
      sectionPath: block.sectionPath,
      sectionHeader: block.sectionHeader,
      locator: block.locator,
      preserve: block.type === 'table_block',
      groupKey: uniqueKey(block.sectionPath),
      kind: block.type,
    }))
  }
  flushKeyValues()
  return units
}

function buildFaqUnits (blocks) {
  const units = []
  let index = 0
  while (index < blocks.length) {
    const block = blocks[index]
    if (block.type === 'qa_question') {
      const answer = blocks[index + 1]?.type === 'qa_answer' ? blocks[index + 1] : null
      units.push(createUnit({
        text: answer ? `${block.text}\n\n${answer.text}` : block.text,
        sectionPath: block.sectionPath,
        sectionHeader: block.sectionHeader,
        locator: block.sectionPath.at(-1) ?? 'Q&A',
        preserve: true,
        groupKey: uniqueKey(block.sectionPath),
        kind: 'qa_pair',
      }))
      index += answer ? 2 : 1
      continue
    }
    if (block.type === 'paragraph' && block.text.trim().endsWith('?') && blocks[index + 1]?.type === 'paragraph') {
      units.push(createUnit({
        text: `${block.text}\n\n${blocks[index + 1].text}`,
        sectionPath: block.sectionPath,
        sectionHeader: block.sectionHeader,
        locator: block.sectionPath.at(-1) ?? 'Q&A',
        preserve: true,
        groupKey: uniqueKey(block.sectionPath),
        kind: 'qa_pair',
      }))
      index += 2
      continue
    }
    index += 1
  }
  return units
}

function buildTechnicalUnits (blocks) {
  const contentBlocks = blocks.filter(block => !['heading', 'divider'].includes(block.type))
  const units = []
  let current = []
  let currentKey = null
  let currentTokens = 0
  const config = SHAPE_CONFIG[CHUNK_SHAPES.TECHNICAL]

  function flush () {
    if (current.length === 0) return
    const first = current[0]
    units.push(createUnit({
      text: current.map(block => block.text).join('\n\n'),
      sectionPath: first.sectionPath,
      sectionHeader: first.sectionHeader,
      locator: first.sectionPath.at(-1) ?? first.locator,
      preserve: current.some(block => block.type === 'code_block'),
      groupKey: currentKey,
      kind: 'technical_group',
    }))
    current = []
    currentKey = null
    currentTokens = 0
  }

  for (const block of contentBlocks) {
    const key = uniqueKey(block.sectionPath)
    const blockTokens = block.tokenCount
    if (current.length > 0 && (key !== currentKey || (currentTokens >= config.minTokens && block.type === 'code_block'))) flush()
    current.push(block)
    currentKey = key
    currentTokens += blockTokens
    if (currentTokens >= config.targetTokens && block.type !== 'code_block') flush()
  }
  flush()
  return units
}

function buildAtomicChunks (context) {
  return {
    chunks: [createChunk({ title: context.title, shape: CHUNK_SHAPES.ATOMIC, content: context.text })],
    stats: { overlapTokens: 0, brokenStructures: 0, preservedUnits: 0 },
  }
}

function buildSectionChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.SECTIONED]
  const units = mergeSmallNeighbors(buildSectionUnits(context.blocks), config, (left, right) => uniqueKey(left.sectionPath.slice(0, -1)) === uniqueKey(right.sectionPath.slice(0, -1)))
  const packed = packUnits(units, config, { respectGroupBoundary: true, overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.SECTIONED, context.title, packed)
}

function buildNarrativeChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.NARRATIVE]
  const packed = packUnits(buildNarrativeUnits(context.blocks), config, { overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.NARRATIVE, context.title, packed)
}

function buildReferenceChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.REFERENCE]
  const units = mergeSmallNeighbors(buildReferenceUnits(context.blocks), config, (left, right) => left.groupKey === right.groupKey)
  const packed = packUnits(units, config, { respectGroupBoundary: true, overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.REFERENCE, context.title, packed)
}

function buildTranscriptChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.TRANSCRIPT]
  const packed = packUnits(buildTranscriptUnits(context.blocks), config, { maxUnitsPerChunk: 8, minUnitsToFlush: 3, overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.TRANSCRIPT, context.title, packed)
}

function buildLogChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.LOG]
  const units = mergeSmallNeighbors(buildLogUnits(context.blocks), config, (left, right) => left.groupKey === right.groupKey)
  const packed = packUnits(units, config, { respectGroupBoundary: true, overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.LOG, context.title, packed)
}

function buildListChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.LIST]
  const packed = packUnits(buildListUnits(context.blocks), config, { overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.LIST, context.title, packed)
}

function buildFaqChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.FAQ]
  const units = mergeSmallNeighbors(buildFaqUnits(context.blocks), config, (left, right) => left.groupKey === right.groupKey)
  const packed = packUnits(units, config, { overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.FAQ, context.title, packed)
}

function buildTechnicalChunks (context) {
  const config = SHAPE_CONFIG[CHUNK_SHAPES.TECHNICAL]
  const packed = packUnits(buildTechnicalUnits(context.blocks), config, { respectGroupBoundary: true, overlapSentences: config.overlapSentences })
  return finalizePacked(CHUNK_SHAPES.TECHNICAL, context.title, packed)
}

function finalizePacked (shape, title, packed) {
  return {
    chunks: packed.chunks.map(chunk => createChunk({
      title,
      shape,
      content: chunk.content,
      sectionPath: chunk.sectionPath,
      sectionHeader: chunk.sectionHeader,
      locator: chunk.locator,
    })),
    stats: packed.stats,
  }
}

function buildChunksForShape (shape, context) {
  switch (shape) {
    case CHUNK_SHAPES.ATOMIC:     return buildAtomicChunks(context)
    case CHUNK_SHAPES.SECTIONED:  return buildSectionChunks(context)
    case CHUNK_SHAPES.NARRATIVE:  return buildNarrativeChunks(context)
    case CHUNK_SHAPES.REFERENCE:  return buildReferenceChunks(context)
    case CHUNK_SHAPES.TRANSCRIPT: return buildTranscriptChunks(context)
    case CHUNK_SHAPES.LOG:        return buildLogChunks(context)
    case CHUNK_SHAPES.LIST:       return buildListChunks(context)
    case CHUNK_SHAPES.FAQ:        return buildFaqChunks(context)
    case CHUNK_SHAPES.TECHNICAL:  return buildTechnicalChunks(context)
    default:                      return buildNarrativeChunks(context)
  }
}

function chunkCohesion (content) {
  const sentences = splitSentences(content)
  if (sentences.length <= 1) return 0.85
  let sum = 0
  for (let index = 1; index < sentences.length; index += 1) {
    sum += similarity(sentences[index - 1], sentences[index])
  }
  return clamp(sum / (sentences.length - 1), 0, 1)
}

function boundaryContrast (chunks) {
  if (chunks.length <= 1) return 0.6
  let sum = 0
  let count = 0
  for (let index = 1; index < chunks.length; index += 1) {
    const left = splitSentences(chunks[index - 1].content).at(-1) ?? chunks[index - 1].content
    const right = splitSentences(chunks[index].content)[0] ?? chunks[index].content
    sum += 1 - similarity(left, right)
    count += 1
  }
  return count > 0 ? clamp(sum / count, 0, 1) : 0.6
}

function sizeFit (chunks, config) {
  if (chunks.length === 0) return 0
  const scores = chunks.map(chunk => {
    const tokens = chunk.tokenCount
    if (tokens >= config.minTokens && tokens <= config.maxTokens) return 1
    if (tokens < config.minTokens) return clamp(tokens / Math.max(1, config.minTokens), 0, 1)
    return clamp(1 - ((tokens - config.maxTokens) / Math.max(1, config.maxTokens)), 0, 1)
  })
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

function evaluateCandidate (shape, candidate) {
  const config = SHAPE_CONFIG[shape]
  const cohesion = candidate.chunks.length > 0
    ? candidate.chunks.reduce((sum, chunk) => sum + chunkCohesion(chunk.content), 0) / candidate.chunks.length
    : 0
  const contrast = boundaryContrast(candidate.chunks)
  const preserved = candidate.stats.preservedUnits > 0
    ? 1 - (candidate.stats.brokenStructures / candidate.stats.preservedUnits)
    : 1
  const fit = sizeFit(candidate.chunks, config)
  const redundancy = clamp(candidate.stats.overlapTokens / Math.max(1, candidate.chunks.reduce((sum, chunk) => sum + chunk.tokenCount, 0) + candidate.stats.overlapTokens), 0, 1)
  return {
    cohesion: round(cohesion),
    boundary_contrast: round(contrast),
    structure_preservation: round(preserved),
    size_fit: round(fit),
    redundancy: round(redundancy),
    score: round((0.35 * cohesion) + (0.25 * contrast) + (0.20 * preserved) + (0.10 * fit) - (0.10 * redundancy)),
  }
}

function chooseShape (context) {
  const ranked = scoreShapes(context.features)
  const winner = ranked[0] ?? { shape: CHUNK_SHAPES.NARRATIVE, score: 0 }
  const runnerUp = ranked[1] ?? { shape: winner.shape, score: winner.score }
  const confidence = round(clamp((winner.score - runnerUp.score + 2) / 10, 0, 1))
  let shape = winner.shape
  let tieBreak = null

  if (context.features.totalTokens > 220 && (winner.score - runnerUp.score) <= 2.5 && winner.shape !== runnerUp.shape) {
    const candidates = [winner.shape, runnerUp.shape].map(candidateShape => {
      const candidate = buildChunksForShape(candidateShape, context)
      return {
        shape: candidateShape,
        metrics: evaluateCandidate(candidateShape, candidate),
        chunks: candidate,
      }
    })
    candidates.sort((left, right) => right.metrics.score - left.metrics.score)
    shape = candidates[0].shape
    tieBreak = {
      winner: shape,
      candidates: candidates.map(candidate => ({ shape: candidate.shape, ...candidate.metrics })),
    }
  }

  return {
    shape,
    confidence,
    scores: ranked,
    tieBreak,
  }
}

export function chunkDocument (text, { title = null } = {}) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return {
      chunks: [],
      router: {
        version: CHUNKING_VERSION,
        shape: CHUNK_SHAPES.ATOMIC,
        confidence: 1,
        scores: [{ shape: CHUNK_SHAPES.ATOMIC, score: 0 }],
        signals: { total_tokens: 0, total_blocks: 0 },
        tie_break: null,
      },
    }
  }

  const blocks = parseBlocks(normalized)
  const features = extractFeatures(normalized, blocks)
  const route = chooseShape({ text: normalized, title, blocks, features })
  const chunked = buildChunksForShape(route.shape, { text: normalized, title, blocks, features })

  return {
    chunks: chunked.chunks,
    router: {
      version: CHUNKING_VERSION,
      shape: route.shape,
      confidence: route.confidence,
      scores: route.scores,
      tie_break: route.tieBreak,
      signals: {
        total_tokens: features.totalTokens,
        total_blocks: features.totalBlocks,
        heading_density: round(features.headingDensity),
        reference_density: round(features.referenceDensity),
        speaker_turn_density: round(features.speakerTurnDensity),
        list_density: round(features.listDensity),
        table_density: round(features.tableDensity),
        key_value_density: round(features.keyValueDensity),
        code_density: round(features.codeDensity),
        date_entry_density: round(features.dateEntryDensity),
        structure_density: round(features.structureDensity),
        avg_paragraph_tokens: round(features.avgParagraphTokens, 2),
      },
    },
  }
}

export function chunkText (text, options = {}) {
  return chunkDocument(text, options).chunks
}