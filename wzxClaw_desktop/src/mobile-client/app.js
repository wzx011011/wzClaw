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
  let activeWorkspaceId = null

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
      requestWorkspaceList()
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

      case 'workspace:list:response':
        renderWorkspaceList(msg.data.workspaces)
        break

      case 'workspace:create:response':
      case 'workspace:update:response':
      case 'workspace:delete:response':
      case 'workspace:add-project:response':
      case 'workspace:remove-project:response':
        // Refresh workspace list after any mutation
        requestWorkspaceList()
        break

      case 'workspace:get:response':
        if (msg.data.workspace) renderWorkspaceDetail(msg.data.workspace)
        break

      case 'workspace:error':
        console.error('[Workspace Error]', msg.data?.error)
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
    if (activeWorkspaceId) payload.activeWorkspaceId = activeWorkspaceId
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

  // Workspace management functions
  function requestWorkspaceList() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'workspace:list:request', data: { requestId: Date.now().toString() } }))
  }

  function renderWorkspaceList(workspaces) {
    var panel = document.getElementById('workspacePanel')
    if (!panel) {
      panel = document.createElement('div')
      panel.id = 'workspacePanel'
      panel.className = 'workspace-panel'
      var header = document.querySelector('.header')
      if (header) header.parentNode.insertBefore(panel, header.nextSibling)
    }
    if (!workspaces || workspaces.length === 0) {
      panel.innerHTML = '<div class="workspace-panel-header">工作区 <button class="workspace-panel-btn" onclick="window._wzxCreateWorkspace()">+</button></div><div class="workspace-empty">无工作区</div>'
      return
    }
    var html = '<div class="workspace-panel-header">工作区 (' + workspaces.length + ') <button class="workspace-panel-btn" onclick="window._wzxCreateWorkspace()">+</button></div>'
    html += '<ul class="workspace-list">'
    workspaces.forEach(function (w) {
      var safeId = escapeHtml(w.id)
      var isActive = activeWorkspaceId === w.id
      html += '<li class="workspace-item' + (isActive ? ' workspace-active' : '') + '" data-id="' + safeId + '">'
      html += '<span class="workspace-name" onclick="window._wzxOpenWorkspace(\'' + safeId + '\')">' + (isActive ? '▶ ' : '') + escapeHtml(w.title) + '</span>'
      if (w.progressSummary) {
        html += '<div class="workspace-progress">📊 ' + escapeHtml(w.progressSummary) + '</div>'
      }
      if (w.projects.length > 0) {
        html += '<div class="workspace-folders">'
        w.projects.forEach(function (p) {
          html += '<div class="workspace-folder-row">📁 <b>' + escapeHtml(p.name) + '</b> <span class="workspace-folder-path">' + escapeHtml(p.path) + '</span></div>'
        })
        html += '</div>'
      } else {
        html += '<span class="workspace-meta">无绑定文件夹</span>'
      }
      html += '<button class="workspace-action-btn" onclick="window._wzxArchiveWorkspace(\'' + safeId + '\')" title="归档">📦</button>'
      html += '<button class="workspace-action-btn" onclick="window._wzxDeleteWorkspace(\'' + safeId + '\')" title="删除">🗑</button>'
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

  // Expose create workspace to inline onclick
  window._wzxCreateWorkspace = function () {
    var title = prompt('工作区名称:')
    if (title && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ event: 'workspace:create:request', data: { requestId: Date.now().toString(), title: title } }))
    }
  }

  window._wzxOpenWorkspace = function (workspaceId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'workspace:get:request', data: { requestId: Date.now().toString(), workspaceId: workspaceId } }))
  }

  window._wzxArchiveWorkspace = function (workspaceId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'workspace:update:request', data: { requestId: Date.now().toString(), workspaceId: workspaceId, updates: { archived: true } } }))
  }

  window._wzxDeleteWorkspace = function (workspaceId) {
    if (!confirm('确定删除此工作区？')) return
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ event: 'workspace:delete:request', data: { requestId: Date.now().toString(), workspaceId: workspaceId } }))
  }

  window._wzxSwitchWorkspace = function (workspaceId) {
    activeWorkspaceId = workspaceId
    // Re-render workspace list to show active state
    requestWorkspaceList()
    // Also re-fetch workspace detail to update button
    ws.send(JSON.stringify({ event: 'workspace:get:request', data: { requestId: Date.now().toString(), workspaceId: workspaceId } }))
  }

  function renderWorkspaceDetail(workspace) {
    var panel = document.getElementById('workspacePanel')
    if (!panel) return
    var html = '<div class="workspace-panel-header"><button class="workspace-panel-btn" onclick="requestWorkspaceList()">←</button> ' + escapeHtml(workspace.title) + '</div>'
    if (workspace.description) {
      html += '<div class="workspace-description">' + escapeHtml(workspace.description) + '</div>'
    }
    if (workspace.progressSummary) {
      html += '<div class="workspace-progress" style="margin-bottom:8px">📊 ' + escapeHtml(workspace.progressSummary) + '</div>'
    }
    var isActive = activeWorkspaceId === workspace.id
    html += '<button class="workspace-switch-btn' + (isActive ? ' active' : '') + '" onclick="window._wzxSwitchWorkspace(\'' + escapeHtml(workspace.id) + '\')">' + (isActive ? '✓ 当前工作区' : '切换到此工作区') + '</button>'
    if (workspace.projects && workspace.projects.length > 0) {
      html += '<div class="workspace-projects-title">项目:</div><ul class="workspace-list">'
      workspace.projects.forEach(function (p) {
        html += '<li class="workspace-item"><span class="workspace-name">' + escapeHtml(p.name) + '</span><span class="workspace-meta">' + escapeHtml(p.path) + '</span></li>'
      })
      html += '</ul>'
    } else {
      html += '<div class="workspace-empty">无挂载项目</div>'
    }
    panel.innerHTML = html
  }

  // Expose requestWorkspaceList for back button
  window.requestWorkspaceList = requestWorkspaceList

  // Start connection
  connect()
})()
