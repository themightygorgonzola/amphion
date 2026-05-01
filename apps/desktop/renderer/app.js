/**
 * apps/desktop/renderer/app.js — UI logic
 *
 * Handles:
 *   - Chat session management (new/switch)
 *   - Sending queries to the broker via window.amphion.query()
 *   - Rendering SSE events (status, ticket, response tokens, done)
 *   - Auto-growing textarea, Enter-to-send, history sidebar
 */

;(async () => {

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionId     = newSessionId()
let isStreaming   = false
let currentBubble = null  // the agent message bubble being built

const sessions = new Map()  // sessionId → [messages]

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const messagesEl   = document.getElementById('messages')
const inputEl      = document.getElementById('message-input')
const formEl       = document.getElementById('input-form')
const sendBtn      = document.getElementById('send-btn')
const statusBar    = document.getElementById('status-bar')
const brandStatus  = document.getElementById('brand-status')
const historyList  = document.getElementById('history-list')
const newChatBtn   = document.getElementById('new-chat-btn')
const brandName    = document.getElementById('brand-name')

// ---------------------------------------------------------------------------
// Broker health check
// ---------------------------------------------------------------------------

async function checkHealth () {
  try {
    const h = await window.amphion.health()
    if (h?.ok) {
      brandStatus.className = 'status-dot online'
      brandStatus.title = 'Broker online'
      if (h.system?.displayName) brandName.textContent = h.system.displayName
    } else {
      brandStatus.className = 'status-dot offline'
      brandStatus.title = 'Broker offline — run: npm run broker'
    }
  } catch {
    brandStatus.className = 'status-dot offline'
  }
}

checkHealth()
setInterval(checkHealth, 15_000)

// ---------------------------------------------------------------------------
// New chat
// ---------------------------------------------------------------------------

newChatBtn.addEventListener('click', () => {
  if (isStreaming) return
  saveSession()
  sessionId = newSessionId()
  sessions.set(sessionId, [])
  messagesEl.innerHTML = ''
  renderEmptyState()
  renderHistorySidebar()
})

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

formEl.addEventListener('submit', async (e) => {
  e.preventDefault()
  const message = inputEl.value.trim()
  if (!message || isStreaming) return

  inputEl.value = ''
  inputEl.style.height = 'auto'
  setStreaming(true)

  // Ensure session is tracked
  if (!sessions.has(sessionId)) sessions.set(sessionId, [])

  appendUserMessage(message)
  saveSession()

  // Placeholder agent bubble
  currentBubble = appendAgentMessage('')

  const result = await window.amphion.query(message, sessionId, handleEvent)

  if (!result.ok && !result.cancelled) {
    updateBubble(currentBubble, `Error: ${result.error}`)
  }

  finishStreaming()
})

// Enter = send (Shift+Enter = newline)
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    formEl.dispatchEvent(new Event('submit'))
  }
})

// ---------------------------------------------------------------------------
// SSE event handler
// ---------------------------------------------------------------------------

function handleEvent (event) {
  switch (event.type) {
    case 'status':
      setStatus(event.message)
      updateBubble(currentBubble, '', event.message)
      break

    case 'ticket':
      // Pipeline job ticket — show domains in status
      if (event.data?.domains) {
        setStatus(`Routing to: ${event.data.domains.join(', ')}`)
      }
      break

    case 'token':
      // Streaming token from voice layer
      appendToken(currentBubble, event.token)
      break

    case 'response':
      // Full response (non-streaming fallback)
      updateBubble(currentBubble, event.content)
      break

    case 'done':
      setStatus('')
      break
  }
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function appendUserMessage (content) {
  const msg = sessions.get(sessionId)
  msg?.push({ role: 'user', content })

  const el = createMessageEl('user', content)
  messagesEl.appendChild(el)

  // Remove empty state if present
  const empty = messagesEl.querySelector('#empty-state')
  if (empty) empty.remove()

  scrollToBottom()
  return el
}

function appendAgentMessage (content) {
  const el = createMessageEl('agent', content)
  el.querySelector('.message-bubble').classList.add('typing-cursor')
  messagesEl.appendChild(el)
  scrollToBottom()
  return el
}

function updateBubble (el, content, statusMsg) {
  if (!el) return
  const bubble = el.querySelector('.message-bubble')

  if (statusMsg) {
    // Show pipeline status inside the bubble while streaming
    const existing = bubble.querySelector('.pipeline-status')
    if (existing) {
      existing.querySelector('span').textContent = statusMsg
    } else if (!bubble.textContent.trim()) {
      bubble.innerHTML = `
        <div class="pipeline-status">
          <div class="spinner"></div>
          <span>${statusMsg}</span>
        </div>`
    }
    return
  }

  if (content) {
    bubble.innerHTML = ''  // clear any pipeline status
    bubble.textContent = content
    bubble.classList.remove('typing-cursor')
    sessions.get(sessionId)?.push({ role: 'assistant', content })
  }

  scrollToBottom()
}

function appendToken (el, token) {
  if (!el) return
  const bubble = el.querySelector('.message-bubble')

  // Clear pipeline status div on first real token
  if (bubble.querySelector('.pipeline-status')) bubble.innerHTML = ''

  bubble.textContent += token
  scrollToBottom()
}

function createMessageEl (role, content) {
  const el = document.createElement('div')
  el.className = `message ${role}`
  el.innerHTML = `
    <div class="message-bubble">${escHtml(content)}</div>
    <div class="message-meta">${role === 'user' ? 'You' : (brandName.textContent ?? 'Atlas')} · ${timeStr()}</div>
  `
  return el
}

function renderEmptyState () {
  const el = document.createElement('div')
  el.id = 'empty-state'
  el.innerHTML = `
    <h2>${brandName.textContent ?? 'Atlas'}</h2>
    <p>Your local AI workspace. Ask anything.</p>
  `
  messagesEl.appendChild(el)
}

// ---------------------------------------------------------------------------
// Sidebar history
// ---------------------------------------------------------------------------

function saveSession () {
  const msgs = sessions.get(sessionId)
  if (!msgs?.length) return
  // Already in map; just re-render
  renderHistorySidebar()
}

function renderHistorySidebar () {
  historyList.innerHTML = ''
  for (const [sid, msgs] of [...sessions.entries()].reverse()) {
    if (!msgs.length) continue
    const item = document.createElement('div')
    item.className = `history-item${sid === sessionId ? ' active' : ''}`
    const firstUser = msgs.find(m => m.role === 'user')
    item.textContent = firstUser?.content?.slice(0, 40) ?? 'New chat'
    item.addEventListener('click', () => switchSession(sid))
    historyList.appendChild(item)
  }
}

function switchSession (sid) {
  if (isStreaming || sid === sessionId) return
  saveSession()
  sessionId = sid
  messagesEl.innerHTML = ''

  const msgs = sessions.get(sid) ?? []
  if (!msgs.length) { renderEmptyState(); return }

  for (const msg of msgs) {
    if (msg.role === 'user') {
      messagesEl.appendChild(createMessageEl('user', msg.content))
    } else {
      messagesEl.appendChild(createMessageEl('agent', msg.content))
    }
  }

  renderHistorySidebar()
  scrollToBottom()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setStreaming (val) {
  isStreaming   = val
  sendBtn.disabled = val
  inputEl.disabled = val
}

function finishStreaming () {
  // Remove typing cursor from current bubble
  currentBubble?.querySelector('.message-bubble')?.classList.remove('typing-cursor')
  currentBubble = null
  setStreaming(false)
  setStatus('')
  saveSession()
  renderHistorySidebar()
}

function setStatus (msg) {
  statusBar.textContent = msg ?? ''
}

function scrollToBottom () {
  messagesEl.scrollTop = messagesEl.scrollHeight
}

function newSessionId () {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function timeStr () {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function escHtml (str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

sessions.set(sessionId, [])
renderEmptyState()
renderHistorySidebar()

})()
