import React, { useState, useRef, useEffect, useCallback } from 'react'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import { useTaskStore, getTaskActiveCount } from '../../stores/task-store'
import ChatMessage from './ChatMessage'
import DiffPreview from './DiffPreview'
import MentionPicker from './MentionPicker'
import PermissionRequest from './PermissionRequest'
import SettingsModal from './SettingsModal'
import SessionList from './SessionList'
import SessionTabs from './SessionTabs'
import TaskPanel from './TaskPanel'
import TokenIndicator from './TokenIndicator'
import type { MentionItem } from '../../../shared/types'

// ============================================================
// ChatPanel — Full chat interface (per D-57, D-58, D-67, D-68)
// Integrates message list, input, model selector, and settings.
// ============================================================

export default function ChatPanel(): JSX.Element {
  // Chat store
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const error = useChatStore((s) => s.error)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const stopGeneration = useChatStore((s) => s.stopGeneration)
  const clearConversation = useChatStore((s) => s.clearConversation)

  // Settings store
  const model = useSettingsStore((s) => s.model)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)

  // Local UI state
  const [inputValue, setInputValue] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const [showMentionPicker, setShowMentionPicker] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  // Mention store actions
  const addMention = useChatStore((s) => s.addMention)
  const removeMention = useChatStore((s) => s.removeMention)
  const pendingMentions = useChatStore((s) => s.pendingMentions)

  // Session count for History button badge
  const sessions = useChatStore((s) => s.sessions)

  // Task panel state
  const taskPanelVisible = useTaskStore((s) => s.panelVisible)
  const toggleTaskPanel = useTaskStore((s) => s.togglePanel)
  const activeTaskCount = useTaskStore((s) => getTaskActiveCount(s.tasks))

  // Auto-scroll to bottom when messages change — use rAF for smooth scheduling
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
    return () => cancelAnimationFrame(raf)
  }, [messages])

  // Listen for "Open Settings" from command palette (per CMD-01)
  useEffect(() => {
    const handler = () => setShowSettings(true)
    window.addEventListener('wzxclaw:open-settings', handler)
    return () => window.removeEventListener('wzxclaw:open-settings', handler)
  }, [])

  // Close more menu on outside click
  useEffect(() => {
    if (!showMoreMenu) return
    const handler = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMoreMenu])

  // Initialize task store — subscribe to IPC events for real-time updates
  useEffect(() => {
    const unsub = useTaskStore.getState().init()
    return unsub
  }, [])

  // Auto-resize textarea and detect @-mention trigger
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setInputValue(value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }

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

  const handleSend = (): void => {
    const trimmed = inputValue.trim()
    if ((!trimmed && pendingMentions.length === 0) || isStreaming) return
    if (trimmed === '/compact') {
      // Trigger manual compact via IPC
      window.wzxclaw.compactContext()
      setInputValue('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }
    sendMessage(trimmed || 'See the attached files.')
    setInputValue('')
    setShowMentionPicker(false)
    setMentionFilter('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // If mention picker is visible, let it handle navigation keys
    if (showMentionPicker && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Escape')) {
      return // MentionPicker handles these via window keydown
    }
    if (e.key === 'Enter' && !e.shiftKey && !showMentionPicker) {
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

  return (
    <div className="chat-panel">
      {/* Header — simplified icon-based design */}
      <div className="chat-header">
        <div className="chat-header-left">
          <select
            className="chat-model-select"
            value={model}
            onChange={(e) => handleModelChange(e.target.value)}
          >
            {DEFAULT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          {!hasApiKey && <span className="chat-no-key-warning" title="No API key configured">!</span>}
          <TokenIndicator />
        </div>
        <div className="chat-header-controls">
          {isStreaming && (
            <button className="chat-icon-btn" onClick={stopGeneration} title="Stop generation">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
            </button>
          )}
          {/* New conversation */}
          <button
            className="chat-icon-btn"
            onClick={() => useChatStore.getState().createSession()}
            title="New conversation (Ctrl+T)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {/* More menu */}
          <div style={{ position: 'relative' }} ref={moreMenuRef}>
            <button
              className={`chat-icon-btn${showMoreMenu ? ' active' : ''}`}
              onClick={() => setShowMoreMenu(!showMoreMenu)}
              title="More options"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="12" cy="19" r="1.5" />
              </svg>
            </button>
            {showMoreMenu && (
              <div className="chat-more-menu">
                <button
                  className="chat-more-menu-item"
                  onClick={() => { setShowSessions(!showSessions); setShowMoreMenu(false) }}
                >
                  <span className="menu-icon">📋</span>
                  History{sessions.length > 0 ? ` (${sessions.length})` : ''}
                </button>
                {messages.length > 0 && (
                  <button
                    className="chat-more-menu-item"
                    onClick={() => { clearConversation(); setShowMoreMenu(false) }}
                  >
                    <span className="menu-icon">🗑</span>
                    Clear conversation
                  </button>
                )}
                <button
                  className="chat-more-menu-item"
                  onClick={() => { toggleTaskPanel(); setShowMoreMenu(false) }}
                  style={activeTaskCount > 0 && !taskPanelVisible ? { color: 'var(--accent)' } : {}}
                >
                  <span className="menu-icon">📌</span>
                  Tasks{activeTaskCount > 0 ? ` (${activeTaskCount})` : ''}
                </button>
                <div className="chat-more-menu-separator" />
                <button
                  className="chat-more-menu-item"
                  onClick={() => { setShowSettings(true); setShowMoreMenu(false) }}
                >
                  <span className="menu-icon">⚙</span>
                  Settings
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Session list */}
      <SessionList isOpen={showSessions} onToggle={() => setShowSessions(!showSessions)} />

      {/* Session tabs */}
      <SessionTabs />

      {/* Messages */}
      <div className="chat-messages">
        {messages.length === 0 ? (
          <div className="chat-empty">
            Start a conversation with the AI agent
          </div>
        ) : (
          messages.map((msg) => <ChatMessage key={msg.id} message={msg} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Permission requests */}
      <PermissionRequest />

      {/* Diff preview for pending file changes */}
      <DiffPreview />

      {/* Task panel for agent task tracking */}
      {taskPanelVisible && (
        <TaskPanel onClose={() => useTaskStore.getState().togglePanel()} />
      )}

      {/* Error banner */}
      {error && (
        <div className="chat-error">
          <span>{error}</span>
        </div>
      )}

      {/* Input area */}
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
            placeholder="Type a message... (Enter to send, Shift+Enter for newline, @ to mention files)"
            rows={1}
            disabled={isStreaming}
          />
          <button
            className="chat-send-btn"
            onClick={handleSend}
            disabled={(!inputValue.trim() && pendingMentions.length === 0) || isStreaming}
          >
            &#9654;
          </button>
          {/* Mention picker dropdown */}
          <MentionPicker
            visible={showMentionPicker}
            filter={mentionFilter}
            onSelect={handleMentionSelect}
            onClose={() => { setShowMentionPicker(false); setMentionFilter('') }}
          />
        </div>
      </div>

      {/* Settings modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}
