/**
 * apps/desktop/src/main.js — Electron main process
 *
 * Window management, system tray, startup registration, and broker IPC.
 *
 * Tray behaviour:
 *   - Closing the window hides it to the tray (app stays alive)
 *   - Left-click tray icon  → toggle window visibility
 *   - Right-click tray icon → context menu
 *   - "Quit Atlas" in menu  → actually quits (forceQuit flag)
 *
 * Startup registration (Windows Task Scheduler):
 *   - "Start on Login" tray checkbox registers a scheduled task that
 *     runs `node scripts/start.js` (the full supervisor) at user logon.
 *   - This means the entire Amphion stack (broker + watchers + window)
 *     auto-starts on boot and stays self-healing.
 */

import { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, dialog } from 'electron'
import path    from 'path'
import fs      from 'fs'
import zlib    from 'zlib'
import { fileURLToPath }           from 'url'
import { execFile, execFileSync, spawn } from 'child_process'

const __dirname    = path.dirname(fileURLToPath(import.meta.url))
const AMPHION_ROOT = path.resolve(__dirname, '../../..')
const isDev        = process.argv.includes('--dev')
const BROKER_URL   = process.env.BROKER_URL ?? 'http://localhost:3000'

let mainWindow = null
let tray       = null
let forceQuit  = false

// ---------------------------------------------------------------------------
// Settings  (userData/settings.json — survives app updates)
// ---------------------------------------------------------------------------
function getSettingsPath () {
  return path.join(app.getPath('userData'), 'settings.json')
}

function loadSettings () {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) }
  catch { return {} }
}

function saveSettings (patch) {
  try {
    const merged = { ...loadSettings(), ...patch }
    fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true })
    fs.writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))
  } catch { /* non-critical */ }
}

// ---------------------------------------------------------------------------
// Tray icon — generated at runtime as a PNG (no asset files required)
// White filled circle on transparent background: readable on any taskbar.
// ---------------------------------------------------------------------------
function buildTrayIconBuffer (size = 22) {
  function chunk (type, data) {
    const lenBuf  = Buffer.alloc(4)
    const crcBuf  = Buffer.alloc(4)
    const typeBuf = Buffer.from(type, 'ascii')
    lenBuf.writeUInt32BE(data.length)
    crcBuf.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])) >>> 0)
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
  }

  // IHDR: color type 6 = RGBA
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA

  const cx = size / 2
  const cy = size / 2
  const rows = []
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4)
    row[0] = 0  // filter: None
    for (let x = 0; x < size; x++) {
      const dist  = Math.sqrt((x - cx + 0.5) ** 2 + (y - cy + 0.5) ** 2)
      const alpha = dist < size * 0.42 ? 230 : 0
      const base  = 1 + x * 4
      row[base]     = 255  // R white
      row[base + 1] = 255  // G white
      row[base + 2] = 255  // B white
      row[base + 3] = alpha
    }
    rows.push(row)
  }

  const idat = zlib.deflateSync(Buffer.concat(rows))
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ---------------------------------------------------------------------------
// Windows startup — Task Scheduler (registers `node scripts/start.js`)
// ---------------------------------------------------------------------------
function findNodeExe () {
  try {
    const out = execFileSync('where.exe', ['node'], { encoding: 'utf8' })
    return out.trim().split('\n')[0].trim()
  } catch {
    return 'node.exe'
  }
}

function runPowerShell (script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NonInteractive', '-NoProfile', '-Command', script],
      { windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message))
        else resolve(stdout?.trim() ?? '')
      }
    )
  })
}

// Registry key used for login startup (no admin required — user-space, like Slack/Discord)
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_NAME = 'Amphion'

function setLoginItem (enable) {
  // Use wscript.exe + start-hidden.vbs so no CMD window appears at startup.
  // Registry HKCU\Run requires no elevation and runs in the user session.
  const vbsScript = path.join(AMPHION_ROOT, 'scripts', 'start-hidden.vbs')
  const value     = `wscript.exe "${vbsScript}"`
  try {
    if (enable) {
      execFileSync('reg', [
        'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', RUN_NAME, '/t', 'REG_SZ', '/d', value, '/f',
      ])
    } else {
      execFileSync('reg', [
        'delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
        '/v', RUN_NAME, '/f',
      ], { stdio: 'ignore' })
    }
    saveSettings({ loginItem: enable })
    refreshTrayMenu()
    return { ok: true, enabled: enable }
  } catch (err) {
    console.error('[main] startup registration failed:', err.message)
    return { ok: false, error: err.message }
  }
}

function getLoginItemStatus () {
  const settings = loadSettings()
  if (typeof settings.loginItem === 'boolean') {
    return { enabled: settings.loginItem }
  }
  // Cold start — check registry directly
  try {
    execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
      '/v', RUN_NAME,
    ], { stdio: 'ignore' })
    saveSettings({ loginItem: true })
    return { enabled: true }
  } catch {
    saveSettings({ loginItem: false })
    return { enabled: false }
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function fullSystemRestart () {
  // Spawn a fresh supervisor then quit this Electron process.
  // start.js will relaunch broker, watchers, and a new Electron window.
  const child = spawn('node', ['scripts/start.js'], {
    cwd:         AMPHION_ROOT,
    detached:    true,
    stdio:       'ignore',
    windowsHide: true,
  })
  child.unref()
  forceQuit = true
  app.quit()
}

function buildTrayMenu () {
  const settings = loadSettings()
  return Menu.buildFromTemplate([
    {
      label: 'Show Atlas',
      click: () => { mainWindow?.show(); mainWindow?.focus() },
    },
    { type: 'separator' },
    {
      label: 'Restart All Services',
      click: () => fullSystemRestart(),
    },
    {
      label: 'Check Broker Health',
      click: async () => {
        try {
          const res  = await fetch(`${BROKER_URL}/health`)
          const data = await res.json()
          dialog.showMessageBox(mainWindow, {
            type:    'info',
            title:   'Broker Health',
            message: data.ok ? `✓ Broker is healthy\n${data.displayName ?? ''}` : 'Broker responded but reported not ok',
          })
        } catch (err) {
          dialog.showMessageBox(mainWindow, {
            type:    'error',
            title:   'Broker Health',
            message: `Broker unreachable: ${err.message}`,
          })
        }
      },
    },
    { type: 'separator' },
    {
      label:   'Start on Login',
      type:    'checkbox',
      checked: settings.loginItem ?? false,
      click:   item => setLoginItem(item.checked),
    },
    { type: 'separator' },
    {
      label: 'Quit Atlas',
      click: () => { forceQuit = true; app.quit() },
    },
  ])
}

function refreshTrayMenu () {
  tray?.setContextMenu(buildTrayMenu())
}

function setupTray () {
  const icon = nativeImage.createFromBuffer(buildTrayIconBuffer(22))
  tray = new Tray(icon)

  const displayName = process.env.DISPLAY_NAME ?? 'Atlas'
  tray.setToolTip(displayName)
  tray.setContextMenu(buildTrayMenu())

  // Left-click: toggle window
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow?.isFocused()) {
      mainWindow.hide()
    } else {
      mainWindow?.show()
      mainWindow?.focus()
    }
  })
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width:  1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
    },
    title: process.env.DISPLAY_NAME ?? 'Atlas',
    show: false, // show once ready-to-show fires
  })

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (isDev) mainWindow.webContents.openDevTools()
  })

  // Hide to tray instead of closing
  mainWindow.on('close', e => {
    if (!forceQuit) {
      e.preventDefault()
      mainWindow.hide()
      // One-time balloon tip on first hide (Windows only — no-op elsewhere)
      if (!loadSettings().hideTrayHinted) {
        tray?.displayBalloon?.({ iconType: 'info', title: 'Atlas is still running', content: 'Right-click the tray icon to quit.' })
        saveSettings({ hideTrayHinted: true })
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

// ---------------------------------------------------------------------------
// IPC: renderer → main → broker
// ---------------------------------------------------------------------------

/**
 * Send a query to the broker and stream SSE events back to the renderer.
 * event.reply sends data before sendback; we use a dedicated channel per query.
 */
ipcMain.handle('broker:query', async (event, { message, sessionId, requestId, userId = 'default', workspaceId = null }) => {
  const controller = new AbortController()
  const { signal } = controller
  const reqId = requestId ?? `${sessionId}:${Date.now()}`

  // Allow renderer to cancel
  ipcMain.once(`broker:cancel:${reqId}`, () => controller.abort())

  try {
    const res = await fetch(`${BROKER_URL}/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, sessionId, requestId: reqId, userId, workspaceId }),
      signal,
    })

    if (!res.ok) {
      throw new Error(`Broker HTTP ${res.status}`)
    }

    // Stream SSE events to renderer
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const parsed = JSON.parse(data)
            // Forward SSE event to renderer via webContents.send
            event.sender.send('broker:event', { ...parsed, requestId: reqId })
          } catch { /* ignore malformed lines */ }
        }
      }
    }

    return { ok: true, requestId: reqId }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: true, cancelled: true, requestId: reqId }
    return { ok: false, error: err.message, requestId: reqId }
  }
})

ipcMain.handle('broker:health', async () => {
  try {
    const res = await fetch(`${BROKER_URL}/health`)
    return await res.json()
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('broker:clearConvo', async (_event, { sessionId }) => {
  try {
    const res = await fetch(`${BROKER_URL}/conversation/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    return await res.json()
  } catch {
    return { ok: false }
  }
})

ipcMain.handle('broker:clearAllConvos', async (_event, { userId = 'default' }) => {
  try {
    const res = await fetch(`${BROKER_URL}/conversations/all?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' })
    return await res.json()
  } catch {
    return { ok: false }
  }
})

// App controls exposed to renderer
ipcMain.handle('app:getLoginItem', async ()          => getLoginItemStatus())
ipcMain.handle('app:setLoginItem', async (_e, { enabled }) => setLoginItem(enabled))
ipcMain.handle('app:quit',         ()                => { forceQuit = true; app.quit() })
ipcMain.handle('app:showWindow',   ()                => { mainWindow?.show(); mainWindow?.focus() })
ipcMain.handle('app:showPath', async (_event, { filePath }) => {
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'invalid path' }
  const abs = path.isAbsolute(filePath) ? filePath : path.join(AMPHION_ROOT, filePath)
  if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' }

  const stat = fs.statSync(abs)
  if (stat.isDirectory()) {
    const error = await shell.openPath(abs)
    return error ? { ok: false, error } : { ok: true, filePath: abs, kind: 'directory' }
  }

  shell.showItemInFolder(abs)
  return { ok: true, filePath: abs, kind: 'file' }
})

// ---------------------------------------------------------------------------
// Ingest helpers
// ---------------------------------------------------------------------------

// Walk a directory tree and return paths of all supported text files.
function collectLocalFiles (dir, validExts) {
  const results = []
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(full)
      } else if (validExts.has(path.extname(e.name).toLowerCase())) {
        results.push(full)
      }
    }
  }
  walk(dir)
  return results
}

// POST /stage — for acquired content (URLs, downloads) with no home on disk
async function postStage (body) {
  const res = await fetch(`${BROKER_URL}/stage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(10_000),
  })
  return res.json()
}

// POST /ingest — index a local file in place (noCopy:true — file stays where it is)
async function postIngest ({ filePath, corpus }) {
  const res = await fetch(`${BROKER_URL}/ingest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filePath, corpus, noCopy: true }),
    signal:  AbortSignal.timeout(60_000),  // embedding takes longer than staging
  })
  return res.json()
}

async function postLearn (body) {
  const res = await fetch(`${BROKER_URL}/learn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  })
  return res.json()
}

async function fetchLearnPlans ({ status = 'pending,draft', limit = 12, userId = null } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (userId) params.set('userId', userId)
  params.set('limit', `${limit}`)
  const res = await fetch(`${BROKER_URL}/learn/plans?${params.toString()}`, {
    signal: AbortSignal.timeout(30_000),
  })
  return res.json()
}

async function postLearnPlanDecision ({ learnPlanId, decision, decisionNotes = '' }) {
  const res = await fetch(`${BROKER_URL}/learn/plans/${encodeURIComponent(learnPlanId)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, decisionNotes }),
    signal: AbortSignal.timeout(60_000),
  })
  return res.json()
}

ipcMain.handle('app:stageFilePicker', async (_event, { corpus = 'research', domain = null } = {}) => {
  const targetCorpus = corpus ?? domain ?? 'research'
  const result = await dialog.showOpenDialog(mainWindow, {
    title:       'Add files to Atlas',
    buttonLabel: 'Index with Atlas',
    filters: [
      { name: 'Documents', extensions: ['md', 'txt', 'html', 'htm'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  })
  if (result.canceled || !result.filePaths.length) return { ok: true, cancelled: true }

  const results = []
  for (const filePath of result.filePaths) {
    try {
      const r = await postIngest({ filePath, corpus: targetCorpus })
      results.push({ filePath, ...r })
    } catch (err) {
      results.push({ filePath, ok: false, error: err.message })
    }
  }
  return { ok: true, results }
})

// Stage a file or folder by path (drag-and-drop from renderer)
// Files — indexed in place via POST /ingest. Folders — walked recursively.
ipcMain.handle('app:stageLocalPath', async (_event, { filePath, corpus = 'research', domain = null }) => {
  const targetCorpus = corpus ?? domain ?? 'research'
  if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'invalid path' }
  const abs = path.isAbsolute(filePath) ? filePath : path.join(AMPHION_ROOT, filePath)
  if (!fs.existsSync(abs)) return { ok: false, error: 'file not found' }

  const VALID = new Set(['.md', '.txt', '.html', '.htm'])
  const stat  = fs.statSync(abs)

  if (stat.isDirectory()) {
    const paths = collectLocalFiles(abs, VALID)
    if (!paths.length) return { ok: false, error: 'no supported files found in folder' }
    const results = []
    for (const fp of paths) {
      try {
        const r = await postIngest({ filePath: fp, corpus: targetCorpus })
        results.push({ filePath: fp, ...r })
      } catch (err) {
        results.push({ filePath: fp, ok: false, error: err.message })
      }
    }
    const okCount = results.filter(r => r.ok).length
    return { ok: true, results, message: `${okCount}/${paths.length} files indexed` }
  }

  return postIngest({ filePath: abs, corpus: targetCorpus })
})

// Stage a URL
ipcMain.handle('app:stageUrl', async (_event, { url, corpus = 'research', domain = null }) => {
  const targetCorpus = corpus ?? domain ?? 'research'
  if (!url || typeof url !== 'string') return { ok: false, error: 'invalid url' }
  // Only allow http/https
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'only http/https URLs are supported' }
  return postStage({ url, corpus: targetCorpus })
})

ipcMain.handle('app:learnPlanRun', async (_event, payload = {}) => {
  const request = `${payload?.request ?? ''}`.trim()
  const targetCorpus = payload?.corpus ?? payload?.domain ?? 'research'
  if (!request) return { ok: false, error: 'learn request is required' }

  return postLearn({
    ...payload,
    request,
    corpus: targetCorpus,
    requestedBy: payload?.requestedBy ?? 'desktop',
  })
})

ipcMain.handle('app:learnFilePicker', async (_event, { request, title = null, corpus = 'research', domain = null } = {}) => {
  const learnRequest = `${request ?? ''}`.trim()
  const targetCorpus = corpus ?? domain ?? 'research'
  if (!learnRequest) return { ok: false, error: 'learn request is required' }

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose learn sources',
    buttonLabel: 'Add To Learn Batch',
    filters: [
      { name: 'Documents', extensions: ['md', 'txt', 'html', 'htm'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  })
  if (result.canceled || !result.filePaths.length) return { ok: true, cancelled: true }

  return postLearn({
    request: learnRequest,
    title,
    corpus: targetCorpus,
    filePaths: result.filePaths,
    requestedBy: 'desktop',
  })
})

ipcMain.handle('app:learnPlans', async (_event, { status = 'pending,draft', limit = 12, userId = null } = {}) => {
  return fetchLearnPlans({ status, limit, userId })
})

ipcMain.handle('app:learnPlanDecide', async (_event, { learnPlanId, decision, decisionNotes = '' } = {}) => {
  if (!learnPlanId || typeof learnPlanId !== 'string') return { ok: false, error: 'learn plan id is required' }
  if (!['approve', 'reject'].includes(`${decision ?? ''}`.trim().toLowerCase())) {
    return { ok: false, error: 'decision must be approve or reject' }
  }
  return postLearnPlanDecision({ learnPlanId, decision, decisionNotes })
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  setupTray()
  createWindow()

  // Watch for renderer-reload signal written by broker restart / MCP tool.
  // When the flag file changes, reload the renderer page in-place (no window kill).
  const reloadFlag = path.join(AMPHION_ROOT, 'data', 'reload-renderer.flag')
  try {
    if (!fs.existsSync(reloadFlag)) fs.writeFileSync(reloadFlag, '0')
    fs.watch(reloadFlag, () => {
      mainWindow?.webContents?.reload()
    })
  } catch { /* non-critical */ }
})

// Do NOT quit when all windows are closed — tray keeps us alive.
// Only the tray "Quit Atlas" option (which sets forceQuit) actually exits.
app.on('window-all-closed', () => { /* stay in tray */ })

// Ensure forceQuit is always set before window close event fires
app.on('before-quit', () => { forceQuit = true })

// macOS: re-open when clicking dock icon
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else mainWindow?.show()
})
