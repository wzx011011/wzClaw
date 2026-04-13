// wzxClaw Mobile Remote Client
;(function () {
  'use strict'

  const messagesEl = document.getElementById('messages')
  const emptyState = document.getElementById('emptyState')
  const inputEl = document.getElementById('input')
  const sendBtn = document.getElementById('sendBtn')
  const stopBtn = document.getElementById('stopBtn')
  const statusEl = document.getElementById('status')

  let ws = null
  let isGenerating = false

  // Extract token from URL query params
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token')

  function connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = protocol + '//' + window.location.host + '/?token=' + encodeURIComponent(token || '')

    ws = new WebSocket(wsUrl)

    ws.onopen = function () {
      statusEl.textContent = '已连接'
      statusEl.className = 'status connected'
    }

    ws.onclose = function () {
      statusEl.textContent = '已断开'
      statusEl.className = 'status disconnected'
      // Reconnect after 3 seconds
      setTimeout(connect, 3000)
    }

    ws.onerror = function () {
      statusEl.textContent = '连接错误'
      statusEl.className = 'status disconnected'
    }

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data)
        handleServerMessage(msg)
      } catch (e) {
        // Ignore malformed messages
      }
    }
  }

  function handleServerMessage(msg) {
    switch (msg.event) {
      case 'connected':
        break

      case 'message:user':
        addMessage('user', msg.data.content)
        break

      case 'message:assistant':
        addMessage('assistant', msg.data.content)
        break

      case 'stream:text_delta':
      case 'stream:agent:text':
        appendToLastAssistant(msg.data.content)
        break

      case 'stream:tool_use_start':
      case 'stream:agent:tool_call':
        addToolBadge(msg.data.name || msg.data.toolName)
        break

      case 'stream:agent:tool_result':
        updateToolResult(msg.data.toolName, msg.data.isError)
        break

      case 'stream:agent:turn_end':
        // Finalize current assistant bubble; next turn creates a new one
        finalizeAssistant()
        break

      case 'stream:done':
      case 'stream:agent:done':
        removeThinkingIndicator()
        setGenerating(false)
        assistantFinalized = true
        break

      case 'stream:error':
      case 'stream:agent:error':
        removeThinkingIndicator()
        addMessage('assistant', '错误: ' + (msg.data.error || ''))
        setGenerating(false)
        break

      case 'todo:updated':
        updateTodoPanel(msg.data.todos)
        break

      case 'session:messages':
        // Full session sync
        clearMessages()
        if (msg.data && Array.isArray(msg.data)) {
          msg.data.forEach(function (m) {
            addMessage(m.role, m.content)
          })
        }
        break
    }
  }

  function addMessage(role, content) {
    if (emptyState) emptyState.style.display = 'none'

    var div = document.createElement('div')
    div.className = 'message ' + role

    var roleLabel = document.createElement('div')
    roleLabel.className = 'role'
    roleLabel.textContent = role === 'user' ? '你' : 'AI'
    div.appendChild(roleLabel)

    var body = document.createElement('div')
    body.className = 'msg-body'
    body.textContent = content || ''
    div.appendChild(body)

    messagesEl.appendChild(div)
    scrollToBottom()
  }

  function appendToLastAssistant(content) {
    removeThinkingIndicator()
    var msgs = messagesEl.querySelectorAll('.message.assistant')
    if (msgs.length === 0 || assistantFinalized) {
      assistantFinalized = false
      addMessage('assistant', content)
      setGenerating(true)
      return
    }
    var last = msgs[msgs.length - 1]
    var body = last.querySelector('.msg-body') || last.lastElementChild
    body.textContent += content
    scrollToBottom()
  }

  function addToolBadge(toolName) {
    removeThinkingIndicator()
    var msgs = messagesEl.querySelectorAll('.message.assistant')
    if (msgs.length === 0) {
      addMessage('assistant', '')
      setGenerating(true)
    }
    var last = msgs.length > 0 ? msgs[msgs.length - 1] : messagesEl.lastElementChild
    var badge = document.createElement('span')
    badge.className = 'tool-badge'
    badge.textContent = '🔧 ' + toolName
    badge.setAttribute('data-tool', toolName)
    last.appendChild(badge)
  }

  function updateToolResult(toolName, isError) {
    var msgs = messagesEl.querySelectorAll('.message.assistant')
    if (msgs.length === 0) return
    var last = msgs[msgs.length - 1]
    var badges = last.querySelectorAll('.tool-badge[data-tool="' + toolName + '"]')
    if (badges.length > 0) {
      var badge = badges[badges.length - 1]
      badge.textContent = (isError ? '❌ ' : '✓ ') + toolName
      badge.className = 'tool-badge ' + (isError ? 'error' : 'done')
    }
  }

  // Mark current assistant bubble as finalized so next text creates a new one
  var assistantFinalized = false
  function finalizeAssistant() {
    assistantFinalized = true
    // Show thinking indicator for the next turn
    showThinkingIndicator()
  }

  var thinkingEl = null
  function showThinkingIndicator() {
    removeThinkingIndicator()
    if (emptyState) emptyState.style.display = 'none'
    thinkingEl = document.createElement('div')
    thinkingEl.className = 'message assistant thinking-msg'
    thinkingEl.innerHTML = '<div class="role">AI</div><div class="msg-body"><span class="thinking-dots"><span></span><span></span><span></span></span> Thinking...</div>'
    messagesEl.appendChild(thinkingEl)
    scrollToBottom()
  }
  function removeThinkingIndicator() {
    if (thinkingEl && thinkingEl.parentNode) {
      thinkingEl.parentNode.removeChild(thinkingEl)
    }
    thinkingEl = null
  }

  function updateTodoPanel(todos) {
    var panel = document.getElementById('todoPanel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'todoPanel'
      panel.className = 'todo-panel'
      // Insert before input area
      var inputArea = document.querySelector('.input-area')
      if (inputArea) inputArea.parentNode.insertBefore(panel, inputArea)
    }
    if (!todos || todos.length === 0) {
      panel.style.display = 'none'
      return
    }
    panel.style.display = ''
    var completed = todos.filter(function (t) { return t.status === 'completed' }).length
    var html = '<div class="todo-header">Todos (' + completed + '/' + todos.length + ')</div><ul class="todo-list">'
    todos.forEach(function (t) {
      var icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⟳' : '○'
      var cls = 'todo-' + t.status
      var text = t.status === 'in_progress' ? t.activeForm : t.content
      html += '<li class="' + cls + '"><span class="todo-icon">' + icon + '</span>' + text + '</li>'
    })
    html += '</ul>'
    panel.innerHTML = html
  }

  function clearMessages() {
    messagesEl.innerHTML = ''
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight
  }

  function setGenerating(val) {
    isGenerating = val
    sendBtn.classList.toggle('hidden', val)
    stopBtn.classList.toggle('hidden', !val)
  }

  function sendCommand() {
    var text = inputEl.value.trim()
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({ event: 'command:send', data: { content: text } }))
    addMessage('user', text)
    inputEl.value = ''
    inputEl.style.height = 'auto'
    setGenerating(true)
  }

  function stopCommand() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'command:stop' }))
    setGenerating(false)
  }

  // Auto-resize textarea
  inputEl.addEventListener('input', function () {
    this.style.height = 'auto'
    this.style.height = Math.min(this.scrollHeight, 120) + 'px'
  })

  // Enter to send, Shift+Enter for newline
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendCommand()
    }
  })

  sendBtn.addEventListener('click', sendCommand)
  stopBtn.addEventListener('click', stopCommand)

  // Start connection
  connect()
})()
