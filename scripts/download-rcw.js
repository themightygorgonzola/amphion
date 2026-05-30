/**
 * scripts/download-rcw.js
 *
 * Downloads the Washington State Revised Code of Washington (RCW) from
 * apps.leg.wa.gov and saves one Markdown file per chapter to data/rcw/.
 *
 * Files are formatted with ## headings per section so the section-aware
 * chunker in ingest.js picks up each statute as a named chunk.
 *
 * Usage:
 *   node scripts/download-rcw.js                       # All titles
 *   node scripts/download-rcw.js --titles 9A,10,26,59  # Specific titles only
 *   node scripts/download-rcw.js --concurrency 8       # Parallel section fetches (default 6)
 *   node scripts/download-rcw.js --no-resume           # Re-download even if file exists
 */

import fs   from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT      = path.resolve(__dirname, '..')
const OUT_DIR   = path.join(ROOT, 'data', 'rcw')
const BASE_URL  = 'https://apps.leg.wa.gov/rcw/default.aspx'

// All WA RCW title identifiers
const ALL_TITLES = [
  '1','2','3','4','5','6','7','8','9','9A',
  '10','11','12','13','14','15','16','17','18','19',
  '20','21','22','23','23B','24','25','26','27','28',
  '28A','28B','28C','29A','30A','31','32','33','34','35',
  '35A','36','37','38','39','40','41','42','43','44',
  '45','46','47','48','49','50','51','52','53','54',
  '55','56','57','58','59','60','61','62A','63','64',
  '65','66','67','68','69','70','70A','71','71A','72',
  '73','74','75','76','77','78','79','79A','80','81',
  '82','84','85','86','87','88','89','90',
]

// Pad title to consistent directory name: "9A" → "09A", "28A" → "28A", "1" → "01"
function padTitle (t) {
  return t.replace(/^(\d+)/, n => n.padStart(2, '0'))
}

// ---------------------------------------------------------------------------
// Simple concurrency limiter (no npm deps)
// ---------------------------------------------------------------------------
class Limiter {
  constructor (max) { this.max = max; this.running = 0; this.q = [] }
  run (fn) {
    return new Promise((resolve, reject) => {
      const exec = () => {
        this.running++
        Promise.resolve().then(() => fn()).then(v => { resolve(v); this._next() }, e => { reject(e); this._next() })
      }
      if (this.running < this.max) exec()
      else this.q.push(exec)
    })
  }
  _next () { this.running--; if (this.q.length) this.q.shift()() }
}

// ---------------------------------------------------------------------------
// HTTP fetch with retry
// ---------------------------------------------------------------------------
async function fetchText (url, attempt = 1) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } catch (err) {
    if (attempt >= 3) throw err
    await delay(1500 * attempt)
    return fetchText(url, attempt + 1)
  }
}

function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

// ---------------------------------------------------------------------------
// HTML parsers
// ---------------------------------------------------------------------------
function decodeEntities (s) {
  return s
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&[a-z]+;/g, ' ')
}

function htmlToPlain (html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// Extract chapter list from a title page
// The title page may only have section-level cites (e.g. cite=9A.04.010).
// We extract the chapter prefix (first two dot-segments) from any matching cite.
function extractChapters (html, titleNum) {
  const titleUp = titleNum.toUpperCase()
  // Match any cite that starts with this title number
  const esc = titleNum.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/[A-Za-z]/g, c => `[${c.toUpperCase()}${c.toLowerCase()}]`)
  const re  = new RegExp(`cite=(${esc}\\.[\\dA-Za-z]+(?:\\.[\\dA-Za-z]+)*)`, 'g')
  const chapters = new Set()
  for (const m of html.matchAll(re)) {
    const parts = m[1].toUpperCase().split('.')
    // parts[0] = title (e.g. "9A"), parts[1] = chapter number (e.g. "04"), parts[2] = section (optional)
    if (parts.length >= 2 && /^\d+[A-Z]?$/.test(parts[1])) {
      chapters.add(parts.slice(0, 2).join('.'))
    }
  }
  return [...chapters].sort()
}

// Extract section list from a chapter page + chapter name
function extractChapterMeta (html, chapterCite) {
  // Chapter name: the <title> tag is often blank; look in the breadcrumb or heading text
  // Pattern: "Chapter 9A.36 RCW: Assaults" in body text or h1/h2
  let chapterName = ''
  const headingMatch = html.match(/<h[12][^>]*>([^<]*(?:RCW|rcw)[^<]*)<\/h[12]>/i)
  if (headingMatch) {
    const m = headingMatch[1].replace(/<[^>]+>/g, ' ').trim()
      .match(/(?:Chapter\s+)?[\dA-Z.]+\s+RCW:?\s*(.+)/i)
    if (m?.[1]) chapterName = m[1].trim()
  }
  if (!chapterName) {
    // Try finding it in plain text: "Chapter 9A.36 RCW: Some Name" in the body
    const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    const m = plain.match(new RegExp(
      chapterCite.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/[A-Za-z]/g, c => `[${c.toUpperCase()}${c.toLowerCase()}]`) +
      '\\s+RCW:?\\s+([A-Z][^.]{4,80})'
    ))
    if (m?.[1]) chapterName = m[1].trim().replace(/\s+/g, ' ')
      // Trim trailing nav boilerplate: "Complete chapter HTML PDF..." etc.
      .replace(/\s+(Complete\s+chapter|HTML\s+PDF|Sections\s+HTML|RCW\s+dispositions).*$/i, '')
  }

  // Match section cites: chapterCite + "." + 3-digit number (maybe letter suffix)
  const chapterUp = chapterCite.toUpperCase()
  const esc = chapterCite.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/[A-Za-z]/g, c => `[${c.toUpperCase()}${c.toLowerCase()}]`)
  const sectionRe = new RegExp(`cite=(${esc}\\.\\d{3}[A-Za-z]?)`, 'g')
  const sections  = [...html.matchAll(sectionRe)].map(m => m[1].toUpperCase())
  return { chapterName, sections: [...new Set(sections)] }
}

// Extract statute text from a section page
function extractSectionText (html, cite) {
  const plain = htmlToPlain(html)

  // Anchor on "PDF RCW {cite}" which appears immediately before the statute title.
  // This skips the entire site navigation block that precedes it.
  const pdfMarker = `PDF RCW ${cite}`
  let idx = plain.indexOf(pdfMarker)
  if (idx >= 0) {
    // Start right after "PDF ", keeping "RCW {cite} Title..."
    idx = plain.indexOf(`RCW ${cite}`, idx)
  } else {
    // Fallback: last occurrence of "RCW {cite}" (more likely to be statute text than nav)
    let lastIdx = -1, pos = 0
    const marker = `RCW ${cite}`
    while ((pos = plain.indexOf(marker, pos)) >= 0) { lastIdx = pos; pos++ }
    idx = lastIdx >= 0 ? lastIdx : plain.indexOf(cite)
    if (idx < 0) return null
  }

  let text = plain.slice(idx).replace(/\s+/g, ' ')

  // Trim trailing boilerplate
  for (const stop of [
    'Legislative questions or comments',
    'Call the Legislative Hotline',
    'TTY for deaf',
    'Accessibility Jobs Public records',
    'Learn more about the Legislative',
  ]) {
    const si = text.indexOf(stop)
    if (si > 0) { text = text.slice(0, si); break }
  }

  return text.trim()
}

// ---------------------------------------------------------------------------
// Build a single chapter Markdown file from all its sections
// ---------------------------------------------------------------------------
async function buildChapterFile (chapterCite, chapterName, sectionCites, limiter) {
  const sectionTexts = await Promise.all(
    sectionCites.map(cite =>
      limiter.run(async () => {
        const url  = `${BASE_URL}?cite=${cite}`
        const html = await fetchText(url)
        const text = extractSectionText(html, cite)
        return { cite, text }
      }),
    ),
  )

  const header    = `# Chapter ${chapterCite} RCW${chapterName ? ' — ' + chapterName : ''}\n\n`
  const titleLine = `Source: Washington State Legislature (apps.leg.wa.gov/rcw)\nDownloaded: ${new Date().toISOString().slice(0, 10)}\n\n`

  const body = sectionTexts
    .filter(s => s.text)
    .map(s => `## ${s.cite}\n\n${s.text}`)
    .join('\n\n---\n\n')

  return header + titleLine + body
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main () {
  const args   = process.argv.slice(2)
  const getArg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }

  const titlesArg   = getArg('--titles')
  const concurrency = parseInt(getArg('--concurrency') ?? '6', 10)
  const noResume    = args.includes('--no-resume')

  const titles = titlesArg
    ? titlesArg.split(',').map(t => t.trim().toUpperCase())
    : ALL_TITLES

  console.log(`[rcw-download] ${titles.length} titles  concurrency=${concurrency}  resume=${!noResume}`)
  console.log(`[rcw-download] output: ${OUT_DIR}`)

  const limiter = new Limiter(concurrency)
  let chapterCount = 0, sectionCount = 0, skipCount = 0, errorCount = 0

  for (const titleNum of titles) {
    const titleDir = path.join(OUT_DIR, `title_${padTitle(titleNum)}`)
    fs.mkdirSync(titleDir, { recursive: true })

    process.stdout.write(`\n[Title ${titleNum}] fetching chapter list...`)
    let chapters
    try {
      const titleHtml = await fetchText(`${BASE_URL}?cite=${titleNum}`)
      chapters = extractChapters(titleHtml, titleNum)
      process.stdout.write(` ${chapters.length} chapters\n`)
    } catch (err) {
      process.stdout.write(` ERROR: ${err.message}\n`)
      errorCount++
      continue
    }

    if (!chapters.length) {
      process.stdout.write(`  (no chapters found — skipping)\n`)
      continue
    }

    for (const chapterCite of chapters) {
      const safeName  = chapterCite.replace(/\./g, '_')
      const outFile   = path.join(titleDir, `chapter_${safeName}.md`)

      if (!noResume && fs.existsSync(outFile)) {
        process.stdout.write(`  [skip] ${chapterCite}\n`)
        skipCount++
        continue
      }

      process.stdout.write(`  [${chapterCite}] fetching sections...`)
      try {
        const chapHtml  = await fetchText(`${BASE_URL}?cite=${chapterCite}`)
        const { chapterName, sections } = extractChapterMeta(chapHtml, chapterCite)

        if (!sections.length) {
          process.stdout.write(` (0 sections — skip)\n`)
          continue
        }

        process.stdout.write(` ${sections.length} sections → "${chapterName}"...`)
        const content = await buildChapterFile(chapterCite, chapterName, sections, limiter)
        fs.writeFileSync(outFile, content, 'utf8')
        chapterCount++
        sectionCount += sections.length
        process.stdout.write(` saved\n`)

        // Polite delay between chapters
        await delay(200)
      } catch (err) {
        process.stdout.write(` ERROR: ${err.message}\n`)
        errorCount++
      }
    }
  }

  console.log(`\n[rcw-download] done`)
  console.log(`  chapters: ${chapterCount}  sections: ${sectionCount}  skipped: ${skipCount}  errors: ${errorCount}`)
  console.log(`  output:   ${OUT_DIR}`)
  console.log(`\nNext: node scripts/ingest.js --dir data/rcw --domain legal --no-summary`)
}

main().catch(err => {
  console.error('[rcw-download] fatal:', err.message)
  process.exit(1)
})
