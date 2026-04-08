import React, { useState, useRef, useEffect } from 'react'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useChatStore } from '../../stores/chat-store'
import ChatMessage from './ChatMessage'
import PermissionRequest from './PermissionRequest'
import SettingsModal from './SettingsModal'
import SessionList from './SessionList'
import TokenIndicator from './TokenIndicator'

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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Session count for History button badge
  const sessions = useChatStore((s) => s.sessions)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setInputValue(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }

  const handleSend = (): void => {
    const trimmed = inputValue.trim()
    if (!trimmed || isStreaming) return
    if (trimmed === '/compact') {
      // Trigger manual compact via IPC
      window.wzxclaw.compactContext()
      setInputValue('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }
    sendMessage(trimmed)
    setInputValue('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
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

      {/* Error banner */}
      {error && (
        <div className="chat-error">
          <span>{error}</span>
        </div>
      )}

      {/* Input area */}
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          className="chat-input"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          rows={1}
          disabled={isStreaming}
        />
        <button
          className="chat-send-btn"
          onClick={handleSend}
          disabled={!inputValue.trim() || isStreaming}
        >
          &#9654;
        </button>
      </div>

      {/* Settings modal */}
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  )
}
