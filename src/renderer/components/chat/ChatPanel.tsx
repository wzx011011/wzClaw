import React, { useState, useRef, useEffect, useCallback } from 'react'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import ChatMessage from './ChatMessage'
import DiffPreview from './DiffPreview'
import MentionPicker from './MentionPicker'
import PermissionRequest from './PermissionRequest'
import SettingsModal from './SettingsModal'
import SessionList from './SessionList'
import SessionTabs from './SessionTabs'
import TokenIndicator from './TokenIndicator'
import type { FileMention } from '../../../shared/types'

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
  const [mentionFilter, setMentionFilter] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Mention store actions
  const addMention = useChatStore((s) => s.addMention)
  const removeMention = useChatStore((s) => s.removeMention)
  const pendingMentions = useChatStore((s) => s.pendingMentions)

  // Session count for History button badge
  const sessions = useChatStore((s) => s.sessions)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Listen for "Open Settings" from command palette (per CMD-01)
  useEffect(() => {
    const handler = () => setShowSettings(true)
    window.addEventListener('wzxclaw:open-settings', handler)
    return () => window.removeEventListener('wzxclaw:open-settings', handler)
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

  const handleMentionSelect = useCallback((mention: FileMention) => {
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
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header-left">
          <span>Chat</span>
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
            <button className="chat-ctrl-btn chat-stop-btn" onClick={stopGeneration}>
              Stop
            </button>
          )}
          <button
            className="chat-ctrl-btn"
            onClick={() => setShowSessions(!showSessions)}
          >
            History{sessions.length > 0 ? ` (${sessions.length})` : ''}
          </button>
          {messages.length > 0 && (
            <button className="chat-ctrl-btn" onClick={clearConversation}>
              Clear
            </button>
          )}
          <button
            className="chat-ctrl-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
          >
            Gear
          </button>
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
              <span key={m.path} className="mention-badge">
                @{m.path}
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
