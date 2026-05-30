/**
 * agents/research/index.js — Research Agent (v2)
 *
 * Three-tool retrieval strategy over the two-tier documents + chunks schema:
 *
 *   search_documents — doc-level semantic search on summary_embedding + BM25 on title/summary.
 *                      Answers "what documents exist about X?" and broad topic questions.
 *
 *   search_hybrid    — chunk-level hybrid search: semantic (vector cosine) + keyword (tsvector BM25),
 *                      merged by RRF (Reciprocal Rank Fusion). Returns chunks WITH section_header
 *                      context and ±1 neighbor chunks for continuity. Best for precise factual queries.
 *
 *   get_document     — fetch full document by id or title match, including all chunks in order.
 *                      For "show me the whole spec" type requests.
 *
 *   list_domains     — counts by domain (unchanged).
 */

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { execFile } from 'child_process'
import { BaseAgent } from '../_base/index.js'
import {
  loadResourceRecord,
  listCorpusStats,
  searchResourceChunks,
  searchResourceSummaries,
} from '../_shared/resource-retrieval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export class ResearchAgent extends BaseAgent {
  get name ()        { return 'research' }
  get description () { return 'Semantic and hybrid search over the Amphion knowledge base (documents + chunks)' }

  get tools () {
    return [
      {
        name: 'find_path',
        description: 'Find files or directories by name on this machine. Use when the user asks WHERE something is, asks for a root directory, asks to locate a project folder, or wants to find a file by name without knowing its location. Returns absolute paths.',
        inputSchema: {
          type: 'object',
          properties: {
            query:       { type: 'string',  description: 'Name or partial name to search for (e.g. "amphion", "config.json")' },
            type:        { type: 'string',  enum: ['any', 'file', 'dir'], description: 'Filter to "file", "dir", or "any" (default "any")' },
            max_results: { type: 'integer', description: 'Max results (default 20)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_local',
        description: 'Search FILE CONTENTS on this machine using ripgrep. Use when the user wants to find text or code inside files — "find files that mention X", "search my notes for Y". NOT for locating files or folders by name (use find_path for that). NOT for the knowledge base (use search_hybrid for that).',
        inputSchema: {
          type: 'object',
          properties: {
            query:       { type: 'string',  description: 'Text to search for in file contents, or a filename fragment when names_only=true' },
            path:        { type: 'string',  description: 'Optional: restrict to a specific directory. Omit to search all default locations.' },
            names_only:  { type: 'boolean', description: 'Search filenames only — no content reading. Fast. Use when looking for a file by name.' },
            glob:        { type: 'string',  description: 'Optional file type filter (e.g. "*.md", "*.js"). Only applies to content search.' },
            max_results: { type: 'integer', description: 'Max results (default 20, max 100)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'browse_path',
        description: 'Reads the live filesystem directly. The right tool whenever a question asks what files or folders exist at a disk path — "what\'s in X", "list directory", "show me the folder", "what files are here". The knowledge base never contains live directory listings; use this instead.',
        inputSchema: {
          type: 'object',
          properties: {
            path:  { type: 'string',  description: 'Absolute directory path to list' },
            depth: { type: 'integer', description: 'Levels deep to list (default 1, max 3)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'read_file',
        description: 'Read the text contents of a file on disk. Use when you know a file\'s absolute path and want to read what it actually says — especially README.md, package.json, or any config/doc file found via find_path or browse_path. Essential for answering questions about what a project does, what it contains, or how it is configured.',
        inputSchema: {
          type: 'object',
          properties: {
            path:      { type: 'string',  description: 'Absolute path to the file to read' },
            max_chars: { type: 'integer', description: 'Max characters to return (default 8000, max 20000)' },
          },
          required: ['path'],
        },
      },
      {
        name: 'search_hybrid',
        description: 'Searches the indexed knowledge base — documents that have been ingested into Amphion. Hybrid chunk-level search combining vector semantic similarity and BM25 keyword matching via RRF. Best for precise factual questions about ingested content. Does not access the live filesystem.',
        inputSchema: {
          type: 'object',
          properties: {
            query:     { type: 'string',  description: 'Natural language search query' },
            domain:    { type: 'string',  description: 'Optional domain filter' },
            k:         { type: 'integer', description: 'Number of final chunks to return (default 6, max 20)' },
            neighbors: { type: 'boolean', description: 'Include ±1 neighboring chunks for context (default true)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_documents',
        description: 'Searches the indexed knowledge base — only documents that have been ingested into Amphion. Finds which documents are relevant to a topic using semantic similarity on summaries and keyword matching on titles. Does not access the live filesystem.',
        inputSchema: {
          type: 'object',
          properties: {
            query:  { type: 'string',  description: 'Natural language search query' },
            domain: { type: 'string',  description: 'Optional domain filter: research|finance|legal|comms|proposals' },
            k:      { type: 'integer', description: 'Number of documents to return (default 5, max 15)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_document',
        description: 'Retrieve a full document from the knowledge base by its ID or by title keyword match. Returns all chunks in order with section headers. Only works for ingested documents, not live files on disk.',
        inputSchema: {
          type: 'object',
          properties: {
            document_id: { type: 'integer', description: 'Exact document ID (use if known)' },
            title:       { type: 'string',  description: 'Title keyword to match (case-insensitive, partial match)' },
            domain:      { type: 'string',  description: 'Optional domain filter to narrow title match' },
          },
        },
      },
      {
        name: 'list_domains',
        description: 'List all domains in the knowledge base with document and chunk counts. Only reflects ingested content, not live filesystem.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]
  }

  async callTool (toolName, args) {
    switch (toolName) {
      case 'search_documents': return this._searchDocuments(args)
      case 'search_hybrid':    return this._searchHybrid(args)
      case 'get_document':     return this._getDocument(args)
      case 'list_domains':     return this._listDomains()
      case 'find_path':        return this._findPath(args)
      case 'search_local':     return this._searchLocal(args)
      case 'browse_path':      return this._browsePath(args)
      case 'read_file':        return this._readFile(args)
      // Legacy fallback
      case 'search_knowledge': return this._searchHybrid({ query: args.query, domain: args.domain, k: args.k })
      default: throw new Error(`Unknown tool: ${toolName}`)
    }
  }

  // ---------------------------------------------------------------------------
  // search_documents — summary-level semantic + title keyword
  // ---------------------------------------------------------------------------
  async _searchDocuments ({ query, domain, k = 5 }) {
    k = Math.min(Math.max(1, k ?? 5), 15)
    this.log(`search_documents: "${query.slice(0, 60)}" domain=${domain ?? 'all'} k=${k}`)

    const merged = await searchResourceSummaries({ query, corpus: domain, k })

    if (!merged.length) {
      return JSON.stringify({ documents: [], message: 'No documents found.' })
    }

    return JSON.stringify({
      documents: merged.map(r => ({
        doc_id:      r.doc_id,
        resource_id: r.resource_id,
        title:       r.title,
        domain:      r.domain,
        corpus:      r.corpus,
        doc_type:    r.doc_type,
        chunk_count: r.chunk_count,
        rrf_score:   r.rrf_score,
        summary:     r.summary ?? '(no summary)',
        source_path: r.source_path,
        metadata:    r.metadata,
      })),
    })
  }

  // Domains excluded from unscoped searches — too high keyword density
  // for common terms to be useful outside their explicit context.
  static RESTRICTED_DOMAINS = ['legal']

  // ---------------------------------------------------------------------------
  // search_hybrid — chunk-level semantic + BM25, merged via RRF, with neighbors
  // ---------------------------------------------------------------------------
  async _searchHybrid ({ query, domain, k = 6, neighbors = true }) {
    k = Math.min(Math.max(1, k ?? 6), 20)
    this.log(`search_hybrid: "${query.slice(0, 60)}" domain=${domain ?? 'all (excl. restricted)'} k=${k}`)

    let merged = []
    if (domain) {
      merged = await searchResourceChunks({ query, corpus: domain, k, neighbors })
    } else {
      const resourceResults = await searchResourceChunks({ query, k: k * 2, neighbors })
      merged = resourceResults
        .filter(row => !ResearchAgent.RESTRICTED_DOMAINS.includes(row.domain))
        .slice(0, k)
    }

    if (!merged.length) {
      return JSON.stringify({ results: [], message: 'No matching chunks found.' })
    }

    return JSON.stringify({
      results: merged.map(r => ({
        doc_id:         r.doc_id,
        resource_id:    r.resource_id,
        chunk_id:       r.chunk_id,
        chunk_index:    r.chunk_index,
        title:          r.title,
        domain:         r.domain,
        corpus:         r.corpus,
        section_header: r.section_header ?? null,
        rrf_score:      r.rrf_score,
        is_neighbor:    r.is_neighbor ?? false,
        content:        r.content,
        start_line:     r.start_line ?? null,
        end_line:       r.end_line ?? null,
        char_start:     r.char_start ?? null,
        char_end:       r.char_end ?? null,
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // get_document — full doc by id or title match
  // ---------------------------------------------------------------------------
  async _getDocument ({ document_id, title, domain }) {
    const loaded = await loadResourceRecord({ resourceId: document_id, title, corpus: domain })

    if (!loaded) {
      return JSON.stringify({ error: 'Document not found', document_id, title })
    }

    const { resource, chunks } = loaded
    this.log(`get_document: id=${resource.resource_id} "${resource.title}" (${chunks.length} chunks)`)

    return JSON.stringify({
      document: {
        id:          resource.resource_id,
        resource_id: resource.resource_id,
        title:       resource.title,
        domain:      resource.domain,
        corpus:      resource.corpus,
        doc_type:    resource.doc_type,
        summary:     resource.summary,
        source_path: resource.source_path,
        chunk_count: resource.chunk_count,
        metadata:    resource.metadata,
        created_at:  resource.created_at,
      },
      chunks: chunks.map(c => ({
        chunk_index:    c.chunk_index,
        section_header: c.section_header,
        content:        c.content,
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // list_domains
  // ---------------------------------------------------------------------------
  async _listDomains () {
    const rows = await listCorpusStats()
    return JSON.stringify({
      domains: rows.map(row => ({
        domain:    row.domain,
        corpus:    row.corpus,
        resources: row.resources,
        documents: row.resources,
        chunks:    row.chunks,
      })),
    })
  }

  // ---------------------------------------------------------------------------
  // find_path — locate files or directories by name across SEARCH_ROOTS
  // ---------------------------------------------------------------------------
  async _findPath ({ query, type = 'any', max_results: maxResults = 20 }) {
    maxResults = Math.min(Math.max(1, maxResults ?? 20), 100)
    if (!query) return JSON.stringify({ error: 'query is required' })

    const configuredRoots = (process.env.SEARCH_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const roots = configuredRoots.length ? configuredRoots : ['C:\\MySoftwareFolder', 'C:\\Users\\dawso\\Documents']
    const validRoots = roots.filter(r => fs.existsSync(r))
    if (!validRoots.length) return JSON.stringify({ error: 'No valid search roots', tried: roots })

    // Normalize glob-style queries (e.g. "*.ts *.js" → [".ts", ".js"])
    // Split on spaces/commas, strip leading "*", then OR-match any term.
    const rawTerms = query.split(/[\s,]+/).map(t => t.replace(/^\*+/, '').trim()).filter(Boolean)
    const terms = rawTerms.length > 1 ? rawTerms : [query]
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = terms.length > 1
      ? new RegExp(terms.map(escape).join('|'), 'i')
      : new RegExp(escape(terms[0]), 'i')

    this.log(`find_path: "${query}" → terms=[${terms.join(',')}] type=${type} roots=${validRoots.join(', ')}`)

    const results = []

    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (results.length >= maxResults) return
        const isDir = e.isDirectory()
        // Skip noise dirs but still recurse into them if they could contain matches
        const skip = e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')
        const full = path.join(dir, e.name)
        if (!skip) {
          const matchesType = type === 'any' || (type === 'dir' && isDir) || (type === 'file' && !isDir)
          if (pattern.test(e.name) && matchesType) {
            results.push({ file: full, type: isDir ? 'dir' : 'file' })
          }
        }
        if (isDir && !skip) walk(full)
      }
    }

    for (const root of validRoots) walk(root)
    return JSON.stringify({ result_type: 'filesystem', tool: 'find_path', query, type, roots: validRoots, count: results.length, results })
  }

  // search_local — search across SEARCH_ROOTS with no path required
  // ---------------------------------------------------------------------------
  async _searchLocal ({ query, path: searchPath, names_only: namesOnly = false, glob, max_results: maxResults = 20 }) {
    maxResults = Math.min(Math.max(1, maxResults ?? 20), 100)
    if (!query) return JSON.stringify({ error: 'query is required' })

    const configuredRoots = (process.env.SEARCH_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const roots = searchPath ? [searchPath] : (configuredRoots.length ? configuredRoots : ['C:\\'])
    const validRoots = roots.filter(r => fs.existsSync(r))
    if (!validRoots.length) return JSON.stringify({ error: 'No valid search roots found', tried: roots })

    this.log(`search_local: "${query.slice(0, 60)}" names_only=${namesOnly} roots=${validRoots.join(', ')}`)

    if (namesOnly) {
      const results = []
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      const walk = (dir) => {
        if (results.length >= maxResults) return
        let entries
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const e of entries) {
          if (results.length >= maxResults) return
          if (e.name.startsWith('.') || e.name === 'node_modules') continue
          const full = path.join(dir, e.name)
          if (pattern.test(e.name)) results.push({ file: full, type: e.isDirectory() ? 'dir' : 'file' })
          if (e.isDirectory()) walk(full)
        }
      }
      for (const root of validRoots) walk(root)
      return JSON.stringify({ result_type: 'filesystem', tool: 'search_local', query, roots: validRoots, names_only: true, count: results.length, results })
    }

    // Content search across all roots
    const allResults = []
    for (const root of validRoots) {
      if (allResults.length >= maxResults) break
      const remaining = maxResults - allResults.length
      try {
        const raw = await this._rgSearch(query, root, glob, remaining, false)
        const parsed = JSON.parse(raw)
        if (parsed.results) allResults.push(...parsed.results)
      } catch (err) {
        if (err.code === 'ENOENT') {
          const raw = await this._nodeSearch(query, root, remaining, false)
          const parsed = JSON.parse(raw)
          if (parsed.results) allResults.push(...parsed.results)
        }
      }
    }
    return JSON.stringify({ result_type: 'filesystem', tool: 'search_local', query, roots: validRoots, count: allResults.length, results: allResults.slice(0, maxResults) })
  }

  async _rgSearch (query, searchPath, glob, maxResults, isRegex) {
    const args = ['--json', '--max-count', '3', '--max-filesize', '5M']
    if (glob) args.push('--glob', glob)
    if (!isRegex) args.push('--fixed-strings')
    args.push('--', query, searchPath)
    const stdout = await new Promise((resolve, reject) => {
      execFile('rg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
        if (err && err.code !== 1) reject(err)  // exit code 1 = no matches (not an error)
        else resolve(out ?? '')
      })
    })
    const results = []
    for (const line of stdout.split('\n').filter(Boolean)) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'match' && results.length < maxResults) {
          results.push({ file: obj.data.path.text, line: obj.data.line_number, text: obj.data.lines.text.trimEnd() })
        }
      } catch { /* malformed json line */ }
    }
    return JSON.stringify({ tool: 'search_files', query, path: searchPath, engine: 'ripgrep', count: results.length, results })
  }

  async _nodeSearch (query, searchPath, maxResults, isRegex) {
    const VALID = new Set(['.md', '.txt', '.js', '.ts', '.py', '.json', '.html', '.htm', '.css', '.sh', '.yaml', '.yml', '.toml', '.csv'])
    const pattern = isRegex ? new RegExp(query, 'i') : null
    const results = []
    const walk = (dir) => {
      if (results.length >= maxResults) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (results.length >= maxResults) return
        const full = path.join(dir, e.name)
        if (e.isDirectory()) {
          if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(full)
        } else if (VALID.has(path.extname(e.name).toLowerCase())) {
          try {
            const lines = fs.readFileSync(full, 'utf8').split('\n')
            for (let i = 0; i < lines.length && results.length < maxResults; i++) {
              const hit = pattern ? pattern.test(lines[i]) : lines[i].toLowerCase().includes(query.toLowerCase())
              if (hit) results.push({ file: full, line: i + 1, text: lines[i].trimEnd() })
            }
          } catch { /* unreadable file */ }
        }
      }
    }
    walk(searchPath)
    return JSON.stringify({ tool: 'search_files', query, path: searchPath, engine: 'node-fallback', count: results.length, results })
  }

  // ---------------------------------------------------------------------------
  // read_file — read text contents of a file on disk
  // ---------------------------------------------------------------------------
  async _readFile ({ path: filePath, max_chars: maxChars = 8000 }) {
    maxChars = Math.min(Math.max(100, maxChars ?? 8000), 20000)
    if (!filePath) return JSON.stringify({ error: 'path is required' })

    // Security: only allow reads within configured search roots
    const configuredRoots = (process.env.SEARCH_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const roots = configuredRoots.length ? configuredRoots : ['C:\\MySoftwareFolder', 'C:\\Users\\dawso\\Documents']
    const resolvedRoots = roots.map(r => path.resolve(r))

    // Resolve the path: if relative or nonexistent, try joining with each search root
    let normalizedPath = path.resolve(filePath)
    if (!fs.existsSync(normalizedPath) && !path.isAbsolute(filePath)) {
      for (const root of resolvedRoots) {
        const candidate = path.join(root, filePath)
        if (fs.existsSync(candidate)) { normalizedPath = candidate; break }
      }
    }

    const allowed = resolvedRoots.some(r => normalizedPath.toLowerCase().startsWith(r.toLowerCase()))
    if (!allowed) return JSON.stringify({ error: 'Access denied: path is not within allowed search roots' })

    if (!fs.existsSync(normalizedPath)) return JSON.stringify({ error: `File not found: ${filePath}` })
    const stat = fs.statSync(normalizedPath)
    if (stat.isDirectory()) return JSON.stringify({ error: 'Path is a directory — use browse_path to list its contents' })

    try {
      const raw = fs.readFileSync(normalizedPath, 'utf8')
      const truncated = raw.length > maxChars
      const content = truncated ? raw.slice(0, maxChars) + '\n…[truncated]' : raw
      this.log(`read_file: ${normalizedPath} (${content.length} chars${truncated ? ', truncated' : ''})`)
      return JSON.stringify({ result_type: 'filesystem', tool: 'read_file', path: normalizedPath, content, truncated, size: stat.size })
    } catch (err) {
      return JSON.stringify({ error: `Could not read file: ${err.message}` })
    }
  }

  // browse_path — list directory tree
  // ---------------------------------------------------------------------------
  async _browsePath ({ path: dirPath, depth = 1 }) {
    depth = Math.min(Math.max(1, depth ?? 1), 3)
    if (!dirPath) return JSON.stringify({ error: 'path is required' })

    // Resolve relative paths against SEARCH_ROOTS (e.g. 'amphion/' → 'C:\MySoftwareFolder\amphion')
    const configuredRoots = (process.env.SEARCH_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
    const roots = configuredRoots.length ? configuredRoots : ['C:\\MySoftwareFolder', 'C:\\Users\\dawso\\Documents']
    let resolved = path.resolve(dirPath)
    if (!fs.existsSync(resolved) && !path.isAbsolute(dirPath)) {
      for (const root of roots) {
        const candidate = path.join(path.resolve(root), dirPath.replace(/[\/\\]+$/, ''))
        if (fs.existsSync(candidate)) { resolved = candidate; break }
      }
    }
    if (!fs.existsSync(resolved)) return JSON.stringify({ error: `Path not found: ${dirPath}` })
    this.log(`browse_path: ${resolved} depth=${depth}`)
    const walk = (dir, currentDepth) => {
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (err) {
        return [{ error: err.message }]
      }
      return entries.slice(0, 200).map(e => {
        const item = { name: e.name, type: e.isDirectory() ? 'dir' : 'file' }
        if (e.isDirectory() && currentDepth < depth) {
          item.children = walk(path.join(dir, e.name), currentDepth + 1)
        }
        return item
      })
    }
    return JSON.stringify({ result_type: 'filesystem', path: resolved, depth, entries: walk(resolved, 1) })
  }
}

// Auto-run when spawned as a standalone process
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { (await import('dotenv/config')) } catch {}
  new ResearchAgent().run()
}
