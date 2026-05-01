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
   * @param {(event: object) => void} onEvent  — called for each SSE event
   */
  query: (message, sessionId, onEvent) => {
    // Subscribe to streaming events for this session
    const handler = (_e, event) => onEvent(event)
    ipcRenderer.on('broker:event', handler)

    return ipcRenderer.invoke('broker:query', { message, sessionId })
      .finally(() => ipcRenderer.removeListener('broker:event', handler))
  },

  /**
   * Cancel an in-flight query.
   */
  cancel: (sessionId) => {
    ipcRenderer.emit(`broker:cancel:${sessionId}`)
  },

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
