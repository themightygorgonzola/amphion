/**
 * apps/desktop/src/preload.js — Electron preload script
 *
 * Runs in the renderer's context with Node access, but exposes only
 * a tight, explicitly-typed API to the renderer via contextBridge.
 * Nothing from Node or Electron leaks directly into the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('amphion', {
  /**
   * Send a message to the broker and receive streamed SSE events.
   * Returns { ok, error? } when the stream completes.
   *
   * @param {string} message
   * @param {string} sessionId
   * @param {string} [userId]
   * @param {string|null} [workspaceId]
   * @param {(event: object) => void} onEvent  — called for each SSE event
   */
  query: (message, sessionId, requestId, onEvent, userId = 'default', workspaceId = null) => {
    let streamDone = false
    const handler = (_e, event) => {
      if (event?.requestId !== requestId) return
      onEvent(event)
      // Remove listener as soon as the terminal event arrives
      if (event.type === 'done' || event.type === 'error') {
        streamDone = true
        ipcRenderer.removeListener('broker:event', handler)
      }
    }
    ipcRenderer.on('broker:event', handler)

    return ipcRenderer.invoke('broker:query', { message, sessionId, requestId, userId, workspaceId })
      .finally(() => {
        // Safety net: if done/error never fired, clean up after a short delay
        if (!streamDone) {
          setTimeout(() => ipcRenderer.removeListener('broker:event', handler), 3000)
        }
      })
  },

  /**
   * Cancel an in-flight query.
   */
  cancel: (requestId) => {
    ipcRenderer.emit(`broker:cancel:${requestId}`)
  },

  /**
   * Clear stored conversation turns for the current session.
   */
  clearConversation: (sessionId) => ipcRenderer.invoke('broker:clearConvo', { sessionId }),

  /**
   * Clear ALL stored conversation turns for the current user (full memory wipe).
   */
  clearAllConversations: (userId) => ipcRenderer.invoke('broker:clearAllConvos', { userId }),

  /**
   * Check if the broker is running.
   */
  health: () => ipcRenderer.invoke('broker:health'),

  /**
   * Listen for a one-time event from main process.
   */
  on: (channel, fn) => {
    const allowed = ['broker:event', 'app:ready']
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args))
    }
  },
})

contextBridge.exposeInMainWorld('atlasApp', {
  /** Whether Amphion is registered to start at Windows login. */
  getLoginItem: () => ipcRenderer.invoke('app:getLoginItem'),

  /** Enable or disable start-on-login. */
  setLoginItem: (enabled) => ipcRenderer.invoke('app:setLoginItem', { enabled }),

  /** Bring the window to the front. */
  showWindow: () => ipcRenderer.invoke('app:showWindow'),

  /** Reveal a local file in Explorer when a chronicle ref points to stored source content. */
  showPath: (filePath) => ipcRenderer.invoke('app:showPath', { filePath }),

  /** Quit the app entirely (same as tray → Quit Atlas). */
  quit: () => ipcRenderer.invoke('app:quit'),

  /** Open native file picker and stage selected files. */
  stageFilePicker: (corpus) => ipcRenderer.invoke('app:stageFilePicker', { corpus }),

  /** Stage a file by its local path (from drag-and-drop). */
  stageLocalPath: (filePath, corpus) => ipcRenderer.invoke('app:stageLocalPath', { filePath, corpus }),

  /** Stage a URL — broker fetches the page and queues it. */
  stageUrl: (url, corpus) => ipcRenderer.invoke('app:stageUrl', { url, corpus }),

  /** Run one inline learn batch with direct URLs or local files. */
  learnPlanRun: (payload) => ipcRenderer.invoke('app:learnPlanRun', payload),

  /** Choose local files or folders for a learn batch. */
  learnFilePicker: (request, corpus, title = null) => ipcRenderer.invoke('app:learnFilePicker', { request, corpus, title }),

  /** List active learn batches for review. */
  learnPlans: (status = 'pending,draft', limit = 12, userId = null) => ipcRenderer.invoke('app:learnPlans', { status, limit, userId }),

  /** Approve or reject a learn batch. */
  learnPlanDecide: (learnPlanId, decision, decisionNotes = '') => ipcRenderer.invoke('app:learnPlanDecide', { learnPlanId, decision, decisionNotes }),
})
