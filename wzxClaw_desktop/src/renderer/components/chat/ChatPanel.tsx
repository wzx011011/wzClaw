import React, { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { v4 as uuidv4 } from 'uuid'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useStepStore } from '../../stores/step-store'
import { SLASH_COMMANDS } from '../../commands/slash-commands'
import ChatMessage from './ChatMessage'
import DiffPreview from './DiffPreview'
import MentionPicker from './MentionPicker'
import SlashCommandPicker from './SlashCommandPicker'
import PermissionRequest from './PermissionRequest'
import SettingsModal from './SettingsModal'
import StepPanel from './StepPanel'
import AskUserQuestion from './AskUserQuestion'
import ThinkingIndicator from './ThinkingIndicator'
import { findLastQuestionAboveViewport, extractBubbleText } from './sticky-question-utils'
import type { MentionItem } from '../../../shared/types'

// ============================================================
// Thinking depth + Permission mode definitions
// ============================================================

type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

const THINKING_DEPTHS: { id: 'none' | 'low' | 'medium' | 'high'; label: string; desc: string }[] = [
  { id: 'none', label: '关闭', desc: '不使用扩展思考' },
  { id: 'low', label: '低', desc: '简单推理' },
  { id: 'medium', label: '中', desc: '平衡深度与速度' },
  { id: 'high', label: '高', desc: '深度推理，较慢' },
]

const PERMISSION_MODES: { id: PermissionMode; label: string; desc: string }[] = [
  { id: 'always-ask', label: '总是询问', desc: '每次工具调用都需确认' },
  { id: 'accept-edits', label: '允许编辑', desc: '自动允许文件编辑' },
  { id: 'plan', label: '规划模式', desc: '所有工具都需审批' },
  { id: 'bypass', label: '自动批准', desc: '跳过所有权限检查' },
]

// ============================================================
// ChatPanel — Full chat interface (per D-57, D-58, D-67, D-68)
// Integrates message list, input, model selector, and settings.
// ============================================================

export default function ChatPanel(): JSX.Element {
  // Chat store
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const isWaitingForResponse = useChatStore((s) => s.isWaitingForResponse)
  const streamingMessageId = useChatStore((s) => s.streamingMessageId)
  const error = useChatStore((s) => s.error)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const streamJustEnded = useChatStore((s) => s.streamJustEnded)

  // Settings store
  const model = useSettingsStore((s) => s.model)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Local UI state
  const [inputValue, setInputValue] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [showSlashPicker, setShowSlashPicker] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesContainerRef = useRef<HTMLDivElement>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [stickyQuestion, setStickyQuestion] = useState<string | null>(null)
  const stickyQuestionElRef = useRef<HTMLElement | null>(null)

  // Mention store actions
  const addMention = useChatStore((s) => s.addMention)
  const removeMention = useChatStore((s) => s.removeMention)
  const pendingMentions = useChatStore((s) => s.pendingMentions)

  // Task panel state
  const stepPanelVisible = useStepStore((s) => s.panelVisible)

  // Todo list (from TodoWrite tool)
  const currentTodos = useChatStore((s) => s.currentTodos)
  const todoCollapsed = useChatStore((s) => s.todoCollapsed)

  // Thinking depth — read from persisted settings store
  const thinkingDepth = useSettingsStore((s) => s.thinkingDepth ?? 'none')
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('always-ask')
  const [showThinkingDropdown, setShowThinkingDropdown] = useState(false)
  const [showPermissionDropdown, setShowPermissionDropdown] = useState(false)
  const thinkingRef = useRef<HTMLDivElement>(null)
  const permissionRef = useRef<HTMLDivElement>(null)

  // Plan mode state
  const [planModeActive, setPlanModeActive] = useState(false)
  const [pendingPlan, setPendingPlan] = useState<string | null>(null)

  // AskUserQuestion state — pending interactive questions from agent (Phase 4.2)
  const [pendingAskUserQuestions, setPendingAskUserQuestions] = useState<
    Array<{ questionId: string; question: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>
  >([])

  // Load permission mode from backend on mount
  useEffect(() => {
    window.wzxclaw.getPermissionMode?.().then((result: { mode: string }) => {
      if (result?.mode) {
        setPermissionMode(result.mode as PermissionMode)
      }
    }).catch(() => {})
  }, [])

  // Close dropdowns on outside click
  useEffect(() => {
    if (!showThinkingDropdown && !showPermissionDropdown) return
    const handler = (e: MouseEvent) => {
      if (showThinkingDropdown && thinkingRef.current && !thinkingRef.current.contains(e.target as Node)) {
        setShowThinkingDropdown(false)
      }
      if (showPermissionDropdown && permissionRef.current && !permissionRef.current.contains(e.target as Node)) {
        setShowPermissionDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showThinkingDropdown, showPermissionDropdown])

  const handlePermissionChange = (mode: PermissionMode) => {
    setPermissionMode(mode)
    setShowPermissionDropdown(false)
    window.wzxclaw.setPermissionMode?.({ mode }).catch(() => {})
  }

  const lastMessage = messages[messages.length - 1]
  const lastToolSignature = lastMessage?.toolCalls
    ?.map((toolCall) => `${toolCall.id}:${toolCall.status}:${toolCall.output?.length ?? 0}`)
    .join('|') ?? ''
  const scrollAnchorKey = [
    messages.length,
    lastMessage?.id ?? '',
    lastMessage?.content.length ?? 0,
    lastMessage?.thinkingContent?.length ?? 0,
    lastMessage?.isStreaming ? 1 : 0,
    lastToolSignature,
    isWaitingForResponse ? 1 : 0,
    streamingMessageId ?? ''
  ].join(':')

  // Auto-scroll to bottom when messages change — only if user hasn't scrolled up
  useEffect(() => {
    if (userScrolledUp) return
    const raf = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth', block: 'end' })
    })
    return () => cancelAnimationFrame(raf)
  }, [scrollAnchorKey, userScrolledUp, isStreaming])

  // Force scroll to bottom when stream ends so final results are visible
  useEffect(() => {
    if (streamJustEnded) {
      setUserScrolledUp(false)
      useChatStore.setState({ streamJustEnded: false })
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
      })
    }
  }, [streamJustEnded])

  // Track scroll position to detect user scroll-up, and compute sticky question
  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) return
    const handleScroll = (): void => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      setUserScrolledUp(distanceFromBottom > 100)

      // 找出所有已滚出顶部的用户消息，取最后一条作为 sticky question
      const containerTop = container.getBoundingClientRect().top
      const userBubbles = container.querySelectorAll<HTMLElement>('.chat-message-user')
      const bubbleInfos = Array.from(userBubbles).map((el) => ({
        text: extractBubbleText(el),
        bottom: el.getBoundingClientRect().bottom,
        el,
      })).filter((b) => b.text.length > 0)
      const lastAbove = findLastQuestionAboveViewport(bubbleInfos, containerTop)
      const lastAboveEl = bubbleInfos.findLast?.((b) => b.bottom < containerTop + 8)?.el ?? null
      setStickyQuestion(lastAbove)
      stickyQuestionElRef.current = lastAboveEl
    }
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [])

  // Listen for plan mode events from main process
  useEffect(() => {
    const unsubEntered = window.wzxclaw.onPlanModeEntered?.(() => {
      setPlanModeActive(true)
    }) ?? (() => {})

    const unsubExited = window.wzxclaw.onPlanModeExited?.((payload) => {
      setPlanModeActive(false)
      setPendingPlan(payload.plan)
    }) ?? (() => {})

    return () => {
      unsubEntered()
      unsubExited()
    }
  }, [])

  // Subscribe to AskUserQuestion events from agent (Phase 4.2)
  useEffect(() => {
    const unsub = window.wzxclaw.onAskUserQuestion?.((payload) => {
      setPendingAskUserQuestions((prev) => [...prev, payload])
    }) ?? (() => {})
    return unsub
  }, [])

  const handlePlanDecision = (approved: boolean): void => {
    setPendingPlan(null)
    window.wzxclaw.sendPlanDecision?.({ approved }).catch(() => {})
  }

  // Listen for "Open Settings" from command palette (per CMD-01)
  useEffect(() => {
    const handler = () => setShowSettings(true)
    window.addEventListener('wzxclaw:open-settings', handler)
    return () => window.removeEventListener('wzxclaw:open-settings', handler)
  }, [])

  // Initialize step store — subscribe to IPC events for real-time updates
  useEffect(() => {
    const unsub = useStepStore.getState().init()
    return unsub
  }, [])

  // Auto-resize textarea and detect @-mention and /-slash triggers
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInputValue(value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }

    // Detect / at the very start of input → slash command picker
    if (value.startsWith('/')) {
      const afterSlash = value.slice(1)
      const spaceIdx = afterSlash.indexOf(' ')
      const query = spaceIdx === -1 ? afterSlash : afterSlash.slice(0, spaceIdx)
      setShowSlashPicker(true)
      setSlashQuery(query)
      setShowMentionPicker(false)
      return
    }
    setShowSlashPicker(false)
    setSlashQuery('')

    // Detect @ trigger: find the last @ that is at start or preceded by whitespace
    const cursorPos = e.target.selectionStart
    const textBeforeCursor = value.slice(0, cursorPos)
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')
    if (lastAtIndex !== -1 && (lastAtIndex === 0 || /\s/.test(textBeforeCursor[lastAtIndex - 1]))) {
      // Extract filter text after @
      const filterText = textBeforeCursor.slice(lastAtIndex + 1)
      // Only show picker if no spaces in filter (still typing the filename)
      if (!filterText.includes(' ') && filterText.length < 100) {
        setShowMentionPicker(true)
        setMentionFilter(filterText)
        return
      }
    }
    setShowMentionPicker(false)
  }

  const handleSlashSelect = useCallback((cmd: import('../../../shared/types').SlashCommand) => {
    // Preserve any args the user may have typed after the command name
    const afterSlash = inputValue.slice(1)
    const spaceIdx = afterSlash.indexOf(' ')
    const existingArgs = spaceIdx !== -1 ? afterSlash.slice(spaceIdx + 1) : ''
    setInputValue(`/${cmd.name}${existingArgs ? ' ' + existingArgs : ''}`)
    setShowSlashPicker(false)
    setSlashQuery('')
    textareaRef.current?.focus()
  }, [inputValue])

  const handleMentionSelect = useCallback((mention: MentionItem) => {
    addMention(mention)
    // Remove the @query from the input
    const lastAtIndex = inputValue.lastIndexOf('@')
    if (lastAtIndex !== -1) {
      const before = inputValue.slice(0, lastAtIndex)
      setInputValue(before)
    }
    setShowMentionPicker(false)
    setMentionFilter('')
    textareaRef.current?.focus()
  }, [inputValue, addMention])

  const handleSend = async (): Promise<void> => {
    const trimmed = inputValue.trim()
    if ((!trimmed && pendingMentions.length === 0) || isStreaming) return

    // Handle /help inline — inject a local assistant message listing all commands
    if (trimmed === '/help') {
      const lines = SLASH_COMMANDS.map((c) => `  /${c.name} — ${c.description}`)
      lines.push('  /help — Show this help message')
      const helpContent = `Available slash commands:\n\n${lines.join('\n')}`
      const { messages } = useChatStore.getState()
      useChatStore.setState({
        messages: [
          ...messages,
          {
            id: uuidv4(),
            role: 'assistant' as const,
            content: helpContent,
            timestamp: Date.now()
          }
        ]
      })
      setInputValue('')
      setShowSlashPicker(false)
      setSlashQuery('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      return
    }

    // Handle slash commands from the registry
    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/)
      const cmdName = parts[0].toLowerCase()
      const args = parts.slice(1).join(' ')
      const cmd = SLASH_COMMANDS.find((c) => c.name === cmdName)
      if (cmd) {
        setInputValue('')
        setShowSlashPicker(false)
        setSlashQuery('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        if (cmd.handler.type === 'action') {
          cmd.handler.execute(args)
        } else {
          const workspaceRoot = useWorkspaceStore.getState().rootPath ?? ''
          const prompt = await cmd.handler.getPrompt(args, workspaceRoot)
          // Show just the command name in the user bubble; send the full prompt to the agent
          sendMessage(`/${cmdName}`, prompt)
        }
        return
      }
    }

    // Normal message send
    sendMessage(trimmed || 'See the attached files.')
    setInputValue('')
    setShowMentionPicker(false)
    setMentionFilter('')
    setShowSlashPicker(false)
    setSlashQuery('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // If mention or slash picker is visible, let them handle navigation keys
    if ((showMentionPicker || showSlashPicker) && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
      return // Pickers handle these via window keydown
    }
    if (e.key === 'Enter' && !e.shiftKey && !showMentionPicker && !showSlashPicker) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleModelChange = (newModel: string): void => {
    const preset = DEFAULT_MODELS.find((m) => m.id === newModel)
    if (preset) {
      updateSettings({ model: newModel, provider: preset.provider })
    }
  }

  // Compute context usage percentage
  const tokenUsage = useChatStore((s) => s.currentTokenUsage)
  const preset = DEFAULT_MODELS.find((m) => m.id === model)
  const maxTokens = preset?.contextWindowSize ?? 128000
  const currentTokens = tokenUsage ? tokenUsage.inputTokens + tokenUsage.outputTokens : 0
  const contextPercent = Math.min(Math.round((currentTokens / maxTokens) * 100), 100)

  return (
    <div className="chat-panel">
      {/* Plan mode active badge */}
      {planModeActive && (
        <div className="plan-mode-badge">
          <span className="plan-mode-icon">&#9998;</span>
          Planning Mode — write operations blocked
        </div>
      )}

      {/* Messages */}
      <div className="chat-messages" ref={messagesContainerRef} style={{ position: 'relative' }}>
        {/* Sticky question bar — 滚动读长回复时始终可见原始问题 */}
        {stickyQuestion && (
          <div
            className="sticky-question-bar"
            onClick={() => {
              stickyQuestionElRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
            title="点击定位到原始问题"
          >
            <span className="sticky-question-label">问题</span>
            <span className="sticky-question-text">{stickyQuestion}</span>
            <span className="sticky-question-jump">↑</span>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="chat-empty">
            Start a conversation with the AI agent
          </div>
        ) : (
          messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
        )}
        {isStreaming && isWaitingForResponse && !streamingMessageId && (
          <div className="chat-message chat-message-assistant chat-message-streaming">
            <ThinkingIndicator />
          </div>
        )}
        <div ref={messagesEndRef} />
        <button
          className={`scroll-to-bottom-btn${userScrolledUp ? ' visible' : ''}`}
          onClick={() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
            setUserScrolledUp(false)
          }}
          title="Scroll to bottom"
        >
          ↓
        </button>
      </div>

      {/* Permission requests */}
      <PermissionRequest />

      {/* AskUserQuestion panels — rendered above DiffPreview (Phase 4.2) */}
      {pendingAskUserQuestions.map((q) => (
        <AskUserQuestion
          key={q.questionId}
          questionId={q.questionId}
          question={q.question}
          options={q.options}
          multiSelect={q.multiSelect}
          onDismiss={(id) =>
            setPendingAskUserQuestions((prev) => prev.filter((p) => p.questionId !== id))
          }
        />
      ))}

      {/* Diff preview for pending file changes */}
      <DiffPreview />

      {/* Plan approval panel — shown when ExitPlanMode submits a plan */}
      {pendingPlan && (
        <div className="plan-approval-panel">
          <div className="plan-approval-header">
            <span className="plan-approval-title">&#9998; Agent Plan — Review &amp; Approve</span>
          </div>
          <div className="plan-approval-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{pendingPlan}</ReactMarkdown>
          </div>
          <div className="plan-approval-actions">
            <button
              className="plan-approval-btn plan-approval-btn-approve"
              onClick={() => handlePlanDecision(true)}
            >
              Approve — Proceed
            </button>
            <button
              className="plan-approval-btn plan-approval-btn-reject"
              onClick={() => handlePlanDecision(false)}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Step panel for agent step tracking */}
      {stepPanelVisible && (
        <StepPanel onClose={() => useStepStore.getState().togglePanel()} />
      )}

      {/* TodoWrite panel — shows active session task list (Copilot style) */}
      {currentTodos.length > 0 && (
        <div className="todo-panel">
          <div className="todo-panel-header" onClick={() => useChatStore.setState((s) => ({ todoCollapsed: !s.todoCollapsed }))}>
            <span className={`todo-panel-collapse${todoCollapsed ? ' collapsed' : ''}`}>&#9660;</span>
            <span className="todo-panel-title">Todos ({currentTodos.filter(t => t.status === 'completed').length}/{currentTodos.length})</span>
            <button
              className="todo-panel-clear"
              title="清空列表"
              onClick={(e) => {
                e.stopPropagation()
                useChatStore.setState({ currentTodos: [] })
              }}
            >
              ✕
            </button>
          </div>
          {!todoCollapsed && (
            <ul className="todo-panel-list">
              {currentTodos.map((todo, i) => (
                <li key={i} className={`todo-item todo-item--${todo.status}`}>
                  <button
                    className={`todo-check-btn todo-check-btn--${todo.status}`}
                    title={todo.status === 'completed' ? '标记为待办' : '标记为完成'}
                    onClick={() => {
                      const newTodos = [...currentTodos]
                      newTodos[i] = {
                        ...newTodos[i],
                        status: newTodos[i].status === 'completed' ? 'pending' : 'completed'
                      }
                      useChatStore.setState({ currentTodos: newTodos })
                    }}
                  >
                    {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '⟳' : '○'}
                  </button>
                  <span className="todo-content">
                    {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="chat-error">
          <span>{error}</span>
        </div>
      )}

      {/* Input area — redesigned per reference image */}
      <div className="chat-input-area-wrapper">
        {/* Pending mention badges */}
        {pendingMentions.length > 0 && (
          <div className="mention-badges">
            {pendingMentions.map((m) => (
              <span key={m.path} className={`mention-badge${m.type === 'folder_mention' ? ' mention-badge-folder' : ''}`}>
                @{m.path}{m.type === 'folder_mention' ? ' [dir]' : ''}
                <button
                  className="mention-badge-remove"
                  onClick={() => removeMention(m.path)}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-input-area" style={{ position: 'relative' }}>
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="描述后续调整内容"
            rows={1}
            disabled={isStreaming}
          />
          {/* Mention picker dropdown */}
          <MentionPicker
            visible={showMentionPicker}
            filter={mentionFilter}
            onSelect={handleMentionSelect}
            onClose={() => { setShowMentionPicker(false); setMentionFilter('') }}
          />
          {/* Slash command picker dropdown */}
          <SlashCommandPicker
            visible={showSlashPicker}
            query={slashQuery}
            commands={SLASH_COMMANDS}
            onSelect={handleSlashSelect}
            onClose={() => { setShowSlashPicker(false); setSlashQuery('') }}
          />
        </div>
        {/* Bottom toolbar: icons | context% | permission | model | send/stop */}
        <div className="chat-input-toolbar">
          <div className="chat-toolbar-left">
            {/* Attachment */}
            <button className="chat-toolbar-icon" title="添加附件" onClick={() => { setShowMentionPicker(true); textareaRef.current?.focus() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            {/* @ mention */}
            <button className="chat-toolbar-icon" title="@ 提及文件" onClick={() => { setShowMentionPicker(true); textareaRef.current?.focus() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0V12a10 10 0 1 0-3.92 7.94" />
              </svg>
            </button>
            {/* Thinking depth */}
            <div ref={thinkingRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className={`chat-toolbar-icon${thinkingDepth !== 'none' ? ' active' : ''}`}
                title={`思考深度: ${THINKING_DEPTHS.find(t => t.id === thinkingDepth)?.label}`}
                onClick={() => { setShowThinkingDropdown(!showThinkingDropdown); setShowPermissionDropdown(false) }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                  <line x1="9" y1="21" x2="15" y2="21" />
                </svg>
              </button>
              {showThinkingDropdown && (
                <div className="chat-toolbar-dropdown">
                  <div className="chat-toolbar-dropdown-title">思考深度</div>
                  {THINKING_DEPTHS.map((t) => (
                    <button
                      key={t.id}
                      className={`chat-toolbar-dropdown-item${thinkingDepth === t.id ? ' active' : ''}`}
                      onClick={() => { updateSettings({ thinkingDepth: t.id }); setShowThinkingDropdown(false) }}
                    >
                      <span>{t.label}</span>
                      <span className="chat-toolbar-dropdown-desc">{t.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Web search */}
            <button className="chat-toolbar-icon" title="网络搜索" onClick={() => { setInputValue((v) => v ? v : '搜索网络: '); textareaRef.current?.focus() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
              </svg>
            </button>
            {/* Settings */}
            <button className="chat-toolbar-icon" title="设置" onClick={() => setShowSettings(true)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
              </svg>
            </button>
          </div>
          <div className="chat-toolbar-right">
            {/* Context usage percentage */}
            <span className={`chat-toolbar-context${contextPercent > 80 ? ' danger' : contextPercent > 60 ? ' warning' : ''}`} title={`${currentTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}>
              {contextPercent}%
            </span>
            {/* Permission mode selector */}
            <div ref={permissionRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className="chat-toolbar-select"
                onClick={() => { setShowPermissionDropdown(!showPermissionDropdown); setShowThinkingDropdown(false) }}
              >
                {PERMISSION_MODES.find(p => p.id === permissionMode)?.label ?? '总是询问'}
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {showPermissionDropdown && (
                <div className="chat-toolbar-dropdown right">
                  <div className="chat-toolbar-dropdown-title">权限模式</div>
                  {PERMISSION_MODES.map((p) => (
                    <button
                      key={p.id}
                      className={`chat-toolbar-dropdown-item${permissionMode === p.id ? ' active' : ''}`}
                      onClick={() => handlePermissionChange(p.id)}
                    >
                      <span>{p.label}</span>
                      <span className="chat-toolbar-dropdown-desc">{p.desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Model quick select */}
            <select
              className="chat-toolbar-model-select"
              value={model}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              {DEFAULT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            {/* Send / Stop button */}
            {isStreaming ? (
              <button className="chat-stop-btn" onClick={stopGeneration} title="停止生成">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!inputValue.trim() && pendingMentions.length === 0}
                title="发送 (Enter)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}
