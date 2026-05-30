/**
 * scripts/_scanner.mjs — File-rules scanner for the staging quarantine pipeline
 *
 * Pure functions — no side effects, no database calls, no network calls.
 * Called by stage-watch.js before a file is promoted from inbox/ to approved/.
 *
 * Pluggable hook interface: call registerScanHook(fn) to add antivirus or
 * content-inspection steps without modifying this file. Future examples:
 *   - Windows Defender:   registerScanHook(windowsDefenderCheck)
 *   - ClamAV:             registerScanHook(clamAvCheck)
 *   - Content policy:     registerScanHook(contentPolicyCheck)
 *
 * Each hook receives (filePath) and must return { pass: boolean, reason?: string }.
 * All hooks run in registration order. First failure short-circuits.
 *
 * @example
 *   import { scan, registerScanHook } from './_scanner.mjs'
 *   const result = await scan('/path/to/file.txt')
 *   // { pass: true } or { pass: false, reason: 'blocked extension: .exe' }
 */

import fs   from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Extensions that are allowed into the ingest pipeline. */
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.html', '.htm'])

/**
 * Extensions that are explicitly blocked regardless of MIME or content.
 * This list covers the most common executable / script formats.
 */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib',    // binaries
  '.bat', '.cmd', '.com',             // Windows scripts
  '.ps1', '.psm1', '.psd1',          // PowerShell
  '.sh', '.bash', '.zsh', '.fish',   // shell scripts
  '.msi', '.msix', '.appx',          // Windows installers
  '.vbs', '.vbe', '.wsf', '.wsh',    // VBScript / WSH
  '.js', '.mjs', '.cjs',             // JS (could be malicious when downloaded)
  '.ts', '.tsx',                     // TypeScript
  '.py', '.pyw', '.pyc',             // Python
  '.rb', '.pl', '.php',              // other scripting
  '.jar', '.class',                  // Java
  '.reg',                            // Windows registry
  '.lnk', '.url',                    // Windows shortcuts
  '.iso', '.img', '.dmg',            // disk images
  '.zip', '.tar', '.gz', '.bz2',     // archives (contents unverified)
  '.7z', '.rar', '.cab',
])

/** Maximum file size allowed through staging (50 MB). */
const MAX_SIZE_BYTES = 50 * 1024 * 1024

/** Minimum file size (reject truly empty files). */
const MIN_SIZE_BYTES = 1

// ---------------------------------------------------------------------------
// Hook registry
// ---------------------------------------------------------------------------

/** @type {Array<(filePath: string) => Promise<{ pass: boolean, reason?: string }> | { pass: boolean, reason?: string }>} */
const _hooks = []

/**
 * Register an additional scan hook.
 * Hooks are called in registration order after the built-in rules pass.
 * @param {(filePath: string) => Promise<{pass: boolean, reason?: string}> | {pass: boolean, reason?: string}} fn
 */
export function registerScanHook (fn) {
  if (typeof fn !== 'function') throw new TypeError('registerScanHook: argument must be a function')
  _hooks.push(fn)
}

// ---------------------------------------------------------------------------
// Built-in rules
// ---------------------------------------------------------------------------

function checkExtension (filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (BLOCKED_EXTENSIONS.has(ext)) {
    return { pass: false, reason: `blocked extension: ${ext}` }
  }
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { pass: false, reason: `unsupported extension: ${ext} (allowed: ${[...ALLOWED_EXTENSIONS].join(', ')})` }
  }
  return { pass: true }
}

function checkSize (filePath) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch (err) {
    return { pass: false, reason: `file not readable: ${err.message}` }
  }

  if (stat.size < MIN_SIZE_BYTES) {
    return { pass: false, reason: 'file is empty' }
  }
  if (stat.size > MAX_SIZE_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1)
    return { pass: false, reason: `file too large: ${mb} MB (max ${MAX_SIZE_BYTES / (1024 * 1024)} MB)` }
  }
  return { pass: true }
}

/**
 * Check that the file is valid UTF-8 (for .txt/.md/.html/.htm).
 * Reads only the first 64 KB to avoid loading huge files into memory.
 */
function checkEncoding (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (!['.md', '.txt', '.html', '.htm'].includes(ext)) return { pass: true }

  try {
    const fd = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(65536)
    const bytesRead = fs.readSync(fd, buf, 0, 65536, 0)
    fs.closeSync(fd)
    buf.slice(0, bytesRead).toString('utf8') // throws if invalid UTF-8
    return { pass: true }
  } catch (err) {
    return { pass: false, reason: `file encoding check failed: ${err.message}` }
  }
}

// ---------------------------------------------------------------------------
// Main scan function
// ---------------------------------------------------------------------------

/**
 * Scan a file against all rules and registered hooks.
 * Returns as soon as any rule fails (short-circuits).
 *
 * @param {string} filePath — absolute path to the file to scan
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
export async function scan (filePath) {
  // Built-in rules (sync, fast)
  for (const rule of [checkExtension, checkSize, checkEncoding]) {
    const result = rule(filePath)
    if (!result.pass) return result
  }

  // Registered hooks (may be async)
  for (const hook of _hooks) {
    const result = await hook(filePath)
    if (!result.pass) return result
  }

  return { pass: true }
}
