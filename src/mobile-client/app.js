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
  let activeTaskId = null

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
      // Auto-fetch task list on connect
      requestTaskList()
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

      case 'step:updated':
        updateStepPanel(msg.data.todos)
        break

      case 'task:list:response':
        renderTaskList(msg.data.tasks)
        break

      case 'task:create:response':
      case 'task:update:response':
      case 'task:delete:response':
      case 'task:add-project:response':
      case 'task:remove-project:response':
        // Refresh task list after any mutation
        requestTaskList()
        break

      case 'task:get:response':
        if (msg.data.task) renderTaskDetail(msg.data.task)
        break

      case 'task:error':
        console.error('[Task Error]', msg.data?.error)
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

  function updateStepPanel(todos) {
    var panel = document.getElementById('stepPanel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'stepPanel'
      panel.className = 'step-panel'
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
    var html = '<div class="step-header">Steps (' + completed + '/' + todos.length + ')</div><ul class="step-list">'
    todos.forEach(function (t) {
      var icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '⟳' : '○'
      var cls = 'step-' + t.status
      var text = t.status === 'in_progress' ? t.activeForm : t.content
      html += '<li class="' + cls + '"><span class="step-icon">' + icon + '</span>' + text + '</li>'
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

    var payload = { content: text }
    if (activeTaskId) payload.activeTaskId = activeTaskId
    ws.send(JSON.stringify({ event: 'command:send', data: payload }))
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

  // Task management functions
  function requestTaskList() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'task:list:request', data: { requestId: Date.now().toString() } }))
  }

  function renderTaskList(tasks) {
    var panel = document.getElementById('taskPanel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'taskPanel'
      panel.className = 'task-panel'
      var header = document.querySelector('.header')
      if (header) header.parentNode.insertBefore(panel, header.nextSibling)
    }
    if (!tasks || tasks.length === 0) {
      panel.innerHTML = '<div class="task-panel-header">任务 <button class="task-panel-btn" onclick="window._wzxCreateTask()">+</button></div><div class="task-empty">无任务</div>'
      return
    }
    var html = '<div class="task-panel-header">任务 (' + tasks.length + ') <button class="task-panel-btn" onclick="window._wzxCreateTask()">+</button></div>'
    html += '<ul class="task-list">'
    tasks.forEach(function (t) {
      var safeId = escapeHtml(t.id)
      var isActive = activeTaskId === t.id
      html += '<li class="task-item' + (isActive ? ' task-active' : '') + '" data-id="' + safeId + '">'
      html += '<span class="task-name" onclick="window._wzxOpenTask(\'' + safeId + '\')">' + (isActive ? '▶ ' : '') + escapeHtml(t.title) + '</span>'
      if (t.progressSummary) {
        html += '<div class="task-progress">📊 ' + escapeHtml(t.progressSummary) + '</div>'
      }
      if (t.projects.length > 0) {
        html += '<div class="task-folders">'
        t.projects.forEach(function (p) {
          html += '<div class="task-folder-row">📁 <b>' + escapeHtml(p.name) + '</b> <span class="task-folder-path">' + escapeHtml(p.path) + '</span></div>'
        })
        html += '</div>'
      } else {
        html += '<span class="task-meta">无绑定文件夹</span>'
      }
      html += '<button class="task-action-btn" onclick="window._wzxArchiveTask(\'' + safeId + '\')" title="归档">📦</button>'
      html += '<button class="task-action-btn" onclick="window._wzxDeleteTask(\'' + safeId + '\')" title="删除">🗑</button>'
      html += '</li>'
    })
    html += '</ul>'
    panel.innerHTML = html
  }

  function escapeHtml(str) {
    var div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }

  // Expose create task to inline onclick
  window._wzxCreateTask = function () {
    var title = prompt('任务名称:')
    if (title && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'task:create:request', data: { requestId: Date.now().toString(), title: title } }))
    }
  }

  window._wzxOpenTask = function (taskId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'task:get:request', data: { requestId: Date.now().toString(), taskId: taskId } }))
  }

  window._wzxArchiveTask = function (taskId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'task:update:request', data: { requestId: Date.now().toString(), taskId: taskId, updates: { archived: true } } }))
  }

  window._wzxDeleteTask = function (taskId) {
    if (!confirm('确定删除此任务？')) return
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'task:delete:request', data: { requestId: Date.now().toString(), taskId: taskId } }))
  }

  window._wzxSwitchTask = function (taskId) {
    activeTaskId = taskId
    // Re-render task list to show active state
    requestTaskList()
    // Also re-fetch task detail to update button
    ws.send(JSON.stringify({ event: 'task:get:request', data: { requestId: Date.now().toString(), taskId: taskId } }))
  }

  function renderTaskDetail(task) {
    var panel = document.getElementById('taskPanel')
    if (!panel) return
    var html = '<div class="task-panel-header"><button class="task-panel-btn" onclick="requestTaskList()">←</button> ' + escapeHtml(task.title) + '</div>'
    if (task.description) {
      html += '<div class="task-description">' + escapeHtml(task.description) + '</div>'
    }
    if (task.progressSummary) {
      html += '<div class="task-progress" style="margin-bottom:8px">📊 ' + escapeHtml(task.progressSummary) + '</div>'
    }
    var isActive = activeTaskId === task.id
    html += '<button class="task-switch-btn' + (isActive ? ' active' : '') + '" onclick="window._wzxSwitchTask(\'' + escapeHtml(task.id) + '\')">' + (isActive ? '✓ 当前任务' : '切换到此任务') + '</button>'
    if (task.projects && task.projects.length > 0) {
      html += '<div class="task-projects-title">项目:</div><ul class="task-list">'
      task.projects.forEach(function (p) {
        html += '<li class="task-item"><span class="task-name">' + escapeHtml(p.name) + '</span><span class="task-meta">' + escapeHtml(p.path) + '</span></li>'
      })
      html += '</ul>'
    } else {
      html += '<div class="task-empty">无挂载项目</div>'
    }
    panel.innerHTML = html
  }

  // Expose requestTaskList for back button
  window.requestTaskList = requestTaskList

  // Start connection
  connect()
})()
