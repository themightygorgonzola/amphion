/**
 * apps/desktop/src/main.js — Electron main process
 *
 * Creates the BrowserWindow and manages the lifecycle.
 * Communicates with the broker via HTTP (localhost:3000).
 * The broker runs as a separate process — start it with `npm run broker` first,
 * or use `npm run dev` to start both together.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = process.argv.includes('--dev')

const BROKER_URL = process.env.BROKER_URL ?? 'http://localhost:3000'

let mainWindow = null

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

  // Open external links in the OS browser, not Electron
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
ipcMain.handle('broker:query', async (event, { message, sessionId }) => {
  const controller = new AbortController()
  const { signal } = controller

  // Allow renderer to cancel
  ipcMain.once(`broker:cancel:${sessionId}`, () => controller.abort())

  try {
    const res = await fetch(`${BROKER_URL}/query`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ message, sessionId }),
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
            event.sender.send('broker:event', parsed)
          } catch { /* ignore malformed lines */ }
        }
      }
    }

    return { ok: true }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: true, cancelled: true }
    return { ok: false, error: err.message }
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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
