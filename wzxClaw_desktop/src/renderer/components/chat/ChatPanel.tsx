import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useT } from '../../i18n/useT'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** 模块级稳定引用 — 避免 pendingPlan ReactMarkdown 每次渲染重建 unified 处理器 */
const REMARK_PLUGINS_PLAN = [remarkGfm] as const
import { v4 as uuidv4 } from 'uuid'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useStepStore } from '../../stores/step-store'
import { useToastStore } from '../../stores/toast-store'
import { SLASH_COMMANDS, getAllSlashCommandsAsync } from '../../commands/slash-commands'
import MessageList from './MessageList'
import DiffPreview from './DiffPreview'
import MentionPicker from './MentionPicker'
import SlashCommandPicker from './SlashCommandPicker'
import PermissionRequest from './PermissionRequest'
import SettingsPage from '../settings/SettingsPage'
import PluginManager from './PluginManager'
import StepPanel from './StepPanel'
import AskUserQuestion from './AskUserQuestion'
import { registerPluginManagerToggle } from '../../commands/slash-commands'

import type { MentionItem } from '../../../shared/types'

// ============================================================
// Thinking depth + Permission mode definitions
// ============================================================

type PermissionMode = 'always-ask' | 'accept-edits' | 'plan' | 'bypass'

// Thinking depth and permission mode definitions — labels resolved at render time via useMemo
const THINKING_DEPTH_IDS: ('none' | 'low' | 'medium' | 'high')[] = ['none', 'low', 'medium', 'high']
const PERMISSION_MODE_IDS: PermissionMode[] = ['always-ask', 'accept-edits', 'plan', 'bypass']

// I18n key mappings for permission mode labels and descriptions
const PM_LABEL_KEYS: Record<PermissionMode, string> = {
  'always-ask': 'permission.alwaysAsk',
  'accept-edits': 'permission.acceptEdits',
  'plan': 'permission.plan',
  'bypass': 'permission.bypass',
}
const PM_DESC_KEYS: Record<PermissionMode, string> = {
  'always-ask': 'permission.alwaysAskDesc',
  'accept-edits': 'permission.acceptEditsDesc',
  'plan': 'permission.planDesc',
  'bypass': 'permission.bypassDesc',
}

// ============================================================
// ChatPanel — Full chat interface (per D-57, D-58, D-67, D-68)
// Integrates message list, input, model selector, and settings.
// ============================================================

export default function ChatPanel(): JSX.Element {
  const t = useT()

  // Computed i18n arrays for thinking depths and permission modes
  const THINKING_DEPTHS = THINKING_DEPTH_IDS.map(id => {
    const key = `settings.general.thinkingDepth.${id}` as string
    const full = t(key) // e.g. "低 — 简单推理"
    const dashIdx = full.indexOf(' — ')
    return dashIdx !== -1
      ? { id, label: full.slice(0, dashIdx), desc: full.slice(dashIdx + 3) }
      : { id, label: full, desc: '' }
  })

  const PERMISSION_MODES = PERMISSION_MODE_IDS.map(id => ({
    id,
    label: t(PM_LABEL_KEYS[id]),
    desc: t(PM_DESC_KEYS[id]),
  }))

  // Chat store — 仅订阅 ChatPanel 自身需要的字段；
  // messages / streaming 高频更新字段已移至 MessageList，不再引起 ChatPanel 重渲。
  const isStreaming = useChatStore((s) => s.isStreaming)
  const error = useChatStore((s) => s.error)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const activeSessionId = useChatStore((s) => s.activeSessionId)

  // Settings store
  const model = useSettingsStore((s) => s.model)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Local UI state
  const [inputValue, setInputValue] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showPlugins, setShowPlugins] = useState(false)
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [showSlashPicker, setShowSlashPicker] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [allCommands, setAllCommands] = useState(SLASH_COMMANDS)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const previousSessionIdRef = useRef(activeSessionId)

  // Image attachments state
  const [pendingImages, setPendingImages] = useState<Array<{ data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; name?: string }>>([])

  // Input history (up/down arrow)
  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const savedInputRef = useRef('')

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

  // Load dynamic skills from main process on mount
  useEffect(() => {
    getAllSlashCommandsAsync().then(setAllCommands).catch(() => {})
  }, [])

  // Load permission mode from backend on mount — deferred 100ms, not first-frame critical
  useEffect(() => {
    const timer = setTimeout(() => {
      window.wzxclaw.getPermissionMode?.().then((result: { mode: string }) => {
        if (result?.mode) {
          setPermissionMode(result.mode as PermissionMode)
        }
      }).catch(() => {
        useToastStore.getState().show(t('chat.permissionModeLoadFailed'), 'error')
      })
    }, 100)
    return () => clearTimeout(timer)
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
    // When selecting plan mode, activate actual plan mode if not already active
    if (mode === 'plan' && !planModeActive) {
      window.wzxclaw.togglePlanMode?.().then((result) => {
        setPlanModeActive(result.active)
      }).catch(() => {})
    } else if (mode !== 'plan' && planModeActive) {
      // Exiting plan mode via permission dropdown
      window.wzxclaw.togglePlanMode?.().then((result) => {
        setPlanModeActive(result.active)
      }).catch(() => {})
    }
    window.wzxclaw.setPermissionMode?.({ mode }).catch(() => {
      useToastStore.getState().show(t('chat.permissionModeSwitchFailed'), 'error')
    })
  }

  // 会话切换：重置 ChatPanel 自身的 UI 状态（历史窗口/滚动由 MessageList 自行重置）
  useEffect(() => {
    if (previousSessionIdRef.current === activeSessionId) return
    previousSessionIdRef.current = activeSessionId
    setInputValue('')
    setPendingAskUserQuestions([])
    setPlanModeActive(false)
    setPendingPlan(null)
    setShowMentionPicker(false)
    setMentionFilter('')
    setShowSlashPicker(false)
    setSlashQuery('')
    setShowThinkingDropdown(false)
    setShowPermissionDropdown(false)
  }, [activeSessionId])

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
    window.wzxclaw.sendPlanDecision?.({ approved }).catch(() => {
      useToastStore.getState().show(t('chat.planDecisionFailed'), 'error')
    })
  }

  // Listen for "Open Settings" from command palette (per CMD-01)
  useEffect(() => {
    const handler = () => setShowSettings(true)
    window.addEventListener('wzxclaw:open-settings', handler)
    return () => window.removeEventListener('wzxclaw:open-settings', handler)
  }, [])

  // Register plugin manager toggle so /plugin command can open the modal
  useEffect(() => {
    registerPluginManagerToggle((show) => setShowPlugins(show))
  }, [])

  // ============================================================
  // Image handling helpers
  // ============================================================

  const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  const MAX_IMAGE_SIZE = 10 * 1024 * 1024 // 10MB

  const processImageFile = useCallback((file: File): Promise<{ data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; name?: string } | null> => {
    return new Promise((resolve) => {
      if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
        useToastStore.getState().show(t('chat.unsupportedImageFormat', { format: file.type }), 'error')
        resolve(null)
        return
      }
      if (file.size > MAX_IMAGE_SIZE) {
        useToastStore.getState().show(t('chat.imageSizeExceeded'), 'error')
        resolve(null)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // Strip data URL prefix to get raw base64
        const base64 = result.split(',')[1]
        if (!base64) { resolve(null); return }
        resolve({
          data: base64,
          mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          name: file.name,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(file)
    })
  }, [])

  const handleImageFiles = useCallback(async (files: FileList | File[]) => {
    const newImages: typeof pendingImages = []
    for (const file of files) {
      if (SUPPORTED_IMAGE_TYPES.includes(file.type)) {
        const img = await processImageFile(file)
        if (img) newImages.push(img)
      }
    }
    if (newImages.length > 0) {
      setPendingImages(prev => [...prev, ...newImages])
    }
  }, [processImageFile])

  // Paste handler for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (!items) return
    const imageFiles: File[] = []
    for (const item of items) {
      if ((item as DataTransferItem).type.startsWith('image/')) {
        const file = (item as DataTransferItem).getAsFile()
        if (file) imageFiles.push(file)
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault()
      handleImageFiles(imageFiles)
    }
  }, [handleImageFiles])

  // Drag & drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      handleImageFiles(files)
    }
  }, [handleImageFiles])

  // File input click handler
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      handleImageFiles(files)
    }
    // Reset so same file can be selected again
    e.target.value = ''
  }, [handleImageFiles])

  const removePendingImage = useCallback((index: number) => {
    setPendingImages(prev => prev.filter((_, i) => i !== index))
  }, [])

  // ============================================================
  // Input history navigation
  // ============================================================

  const pushToHistory = useCallback((text: string) => {
    if (!text.trim()) return
    const history = inputHistoryRef.current
    // Deduplicate: don't add if same as last entry
    if (history.length > 0 && history[history.length - 1] === text) return
    history.push(text)
    // Keep last 100 entries
    if (history.length > 100) history.shift()
  }, [])

  const navigateHistory = useCallback((direction: 'up' | 'down'): string | null => {
    const history = inputHistoryRef.current
    if (history.length === 0) return null

    if (direction === 'up') {
      if (historyIndexRef.current === -1) {
        // Save current input before navigating
        savedInputRef.current = inputValue
        historyIndexRef.current = history.length - 1
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current--
      }
    } else {
      if (historyIndexRef.current === -1) return null
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current++
      } else {
        // Restore saved input
        historyIndexRef.current = -1
        return savedInputRef.current
      }
    }
    return history[historyIndexRef.current] ?? null
  }, [inputValue])

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
    if ((!trimmed && pendingMentions.length === 0 && pendingImages.length === 0) || isStreaming) return

    // Handle /help inline — inject a local assistant message listing all commands
    if (trimmed === '/help') {
      const lines = allCommands.map((c) => `  /${c.name} — ${c.description}`)
      lines.push('  /help — Show this help message')
      const helpContent = `${t('chat.availableSlashCommands')}\n\n${lines.join('\n')}`
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
      const cmd = allCommands.find((c) => c.name === cmdName)
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
    const imagesToSend = pendingImages.length > 0 ? pendingImages : undefined
    const displayText = trimmed || (pendingImages.length > 0 ? t('chat.viewAttachment') : t('chat.viewFileAttachment'))

    // Push to input history
    if (trimmed) pushToHistory(trimmed)

    sendMessage(displayText, undefined, imagesToSend)
    setInputValue('')
    setPendingImages([])
    setShowMentionPicker(false)
    setMentionFilter('')
    setShowSlashPicker(false)
    setSlashQuery('')
    historyIndexRef.current = -1
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Tab: toggle plan mode
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      window.wzxclaw.togglePlanMode?.().then((result) => {
        setPlanModeActive(result.active)
      }).catch(() => {})
      return
    }
    // If mention or slash picker is visible, let them handle navigation keys
    if ((showMentionPicker || showSlashPicker) && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
      return // Pickers handle these via window keydown
    }
    if (e.key === 'Enter' && !e.shiftKey && !showMentionPicker && !showSlashPicker) {
      e.preventDefault()
      handleSend()
      return
    }
    // Up/Down arrow: navigate input history when cursor is at start/end
    if (e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const target = e.target as HTMLTextAreaElement
      if (target.selectionStart === 0 && target.selectionEnd === 0) {
        e.preventDefault()
        const historical = navigateHistory('up')
        if (historical !== null) {
          setInputValue(historical)
          // Move cursor to end
          requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = historical.length })
        }
      }
    }
    if (e.key === 'ArrowDown' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const target = e.target as HTMLTextAreaElement
      if (target.selectionStart === inputValue.length && target.selectionEnd === inputValue.length) {
        e.preventDefault()
        const historical = navigateHistory('down')
        if (historical !== null) {
          setInputValue(historical)
          requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = historical.length })
        }
      }
    }
    // Ctrl+A: select all text in input
    // Escape: clear input or close pickers
    if (e.key === 'Escape') {
      if (showMentionPicker) { setShowMentionPicker(false); setMentionFilter(''); return }
      if (showSlashPicker) { setShowSlashPicker(false); setSlashQuery(''); return }
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
  // inputTokens includes system prompt + full conversation history — this is the actual context usage
  const currentTokens = tokenUsage ? tokenUsage.inputTokens : 0
  const contextPercent = Math.min(Math.round((currentTokens / maxTokens) * 100), 100)

  return (
    <div className="chat-panel">
      {/* Plan mode active badge */}
      {planModeActive && (
        <div className="plan-mode-badge">
          <span className="plan-mode-icon">&#9998;</span>
          {t('chat.planModeBadge')}
        </div>
      )}

      {/* Messages — 消息列表已独立为 MessageList 组件，
          ChatPanel 不再订阅 messages 数组，流式输出期间不参与重渲 */}
      <MessageList />

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
            <span className="plan-approval-title">{t('chat.planApproval')}</span>
          </div>
          <div className="plan-approval-content">
            <ReactMarkdown remarkPlugins={REMARK_PLUGINS_PLAN}>{pendingPlan}</ReactMarkdown>
          </div>
          <div className="plan-approval-actions">
            <button
              className="plan-approval-btn plan-approval-btn-approve"
              onClick={() => handlePlanDecision(true)}
            >
              {t('chat.planApprove')}
            </button>
            <button
              className="plan-approval-btn plan-approval-btn-reject"
              onClick={() => handlePlanDecision(false)}
            >
              {t('chat.planReject')}
            </button>
          </div>
        </div>
      )}

      {/* Step panel for agent step tracking */}
      {stepPanelVisible && (
        <StepPanel onClose={() => useStepStore.getState().togglePanel()} />
      )}

      {/* TodoWrite panel — shows active session task list (Copilot style) */}
      {currentTodos.length > 0 && !currentTodos.every(t => t.status === 'completed') && (
        <div className="todo-panel">
          <div
            className="todo-panel-header"
            role="button"
            tabIndex={0}
            onClick={() => useChatStore.setState((s) => ({ todoCollapsed: !s.todoCollapsed }))}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); useChatStore.setState((s) => ({ todoCollapsed: !s.todoCollapsed })) } }}
          >
            <span className={`todo-panel-collapse${todoCollapsed ? ' collapsed' : ''}`}>&#9660;</span>
            <span className="todo-panel-title">Todos ({currentTodos.filter(t => t.status === 'completed').length}/{currentTodos.length})</span>
            <button
              className="todo-panel-clear"
              title={t('chat.clearTodos')}
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
                    title={todo.status === 'completed' ? t('chat.markAsPending') : t('chat.markAsCompleted')}
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
        {/* Pending image previews */}
        {pendingImages.length > 0 && (
          <div className="pending-images">
            {pendingImages.map((img, i) => (
              <div key={i} className="pending-image-thumb">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name ?? `Image ${i + 1}`} />
                <button className="pending-image-remove" onClick={() => removePendingImage(i)}>✕</button>
                {img.name && <span className="pending-image-name">{img.name.length > 15 ? img.name.slice(0, 12) + '...' : img.name}</span>}
              </div>
            ))}
          </div>
        )}
        <div
          className="chat-input-area"
          style={{ position: 'relative' }}
          onPaste={handlePaste}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <textarea
            ref={textareaRef}
            className="chat-input"
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={pendingImages.length > 0 ? t('chat.imageDescPlaceholder') : t('chat.inputPlaceholder.continue')}
            rows={1}
            disabled={isStreaming}
          />
          {/* Hidden file input for image upload */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
n            style={{ display: 'none' }}
            onChange={handleFileSelect}
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
            commands={allCommands}
            onSelect={handleSlashSelect}
            onClose={() => { setShowSlashPicker(false); setSlashQuery('') }}
          />
        </div>
        {/* Bottom toolbar: icons | context% | permission | model | send/stop */}
        <div className="chat-input-toolbar">
          <div className="chat-toolbar-left">
            {/* Image upload */}
            <button className="chat-toolbar-icon" title={t('chat.uploadImage')} onClick={() => fileInputRef.current?.click()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* @ mention */}
            <button className="chat-toolbar-icon" title={t('chat.mentionFile')} onClick={() => { setShowMentionPicker(true); textareaRef.current?.focus() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0V12a10 10 0 1 0-3.92 7.94" />
              </svg>
            </button>
            {/* Thinking depth */}
            <div ref={thinkingRef} style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                className={`chat-toolbar-icon${thinkingDepth !== 'none' ? ' active' : ''}`}
                title={`${t('chat.thinkingDepth')}: ${THINKING_DEPTHS.find(td => td.id === thinkingDepth)?.label}`}
                onClick={() => { setShowThinkingDropdown(!showThinkingDropdown); setShowPermissionDropdown(false) }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                  <line x1="9" y1="21" x2="15" y2="21" />
                </svg>
              </button>
              {showThinkingDropdown && (
                <div className="chat-toolbar-dropdown">
                  <div className="chat-toolbar-dropdown-title">{t('chat.thinkingDepth')}</div>
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
            <button className="chat-toolbar-icon" title={t('chat.webSearch')} onClick={() => { setInputValue((v) => v ? v : `${t('chat.webSearch')}: `); textareaRef.current?.focus() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z" />
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
                {PERMISSION_MODES.find(p => p.id === permissionMode)?.label ?? t('permission.alwaysAsk')}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {showPermissionDropdown && (
                <div className="chat-toolbar-dropdown right">
                  <div className="chat-toolbar-dropdown-title">{t('chat.permissionMode')}</div>
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
              <button className="chat-stop-btn" onClick={stopGeneration} title={t('chat.stopGeneration')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
            ) : (
              <button
                className="chat-send-btn"
                onClick={handleSend}
                disabled={!inputValue.trim() && pendingMentions.length === 0 && pendingImages.length === 0}
                title={t('chat.sendTooltip')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      <SettingsPage isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <PluginManager isOpen={showPlugins} onClose={() => setShowPlugins(false)} />
    </div>
  )
}
