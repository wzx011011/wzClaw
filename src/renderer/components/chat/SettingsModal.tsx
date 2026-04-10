import { useState, useEffect } from 'react'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * SettingsModal — modal dialog for API key input and provider configuration (per D-65).
 * Allows user to configure provider, API key, base URL, model, and system prompt.
 */
export default function SettingsModal({ isOpen, onClose }: SettingsModalProps): JSX.Element | null {
  const settingsProvider = useSettingsStore((s) => s.provider)
  const settingsModel = useSettingsStore((s) => s.model)
  const settingsBaseURL = useSettingsStore((s) => s.baseURL)
  const settingsSystemPrompt = useSettingsStore((s) => s.systemPrompt)
  const settingsRelayToken = useSettingsStore((s) => s.relayToken)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Local form state initialized from settings store
  const [provider, setProvider] = useState(settingsProvider)
  const [model, setModel] = useState(settingsModel)
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState(settingsBaseURL ?? '')
  const [systemPrompt, setSystemPrompt] = useState(settingsSystemPrompt ?? '')
  const [relayToken, setRelayToken] = useState(settingsRelayToken ?? '')
  const [saving, setSaving] = useState(false)
  const [relayConnected, setRelayConnected] = useState(false)
  const [relayConnecting, setRelayConnecting] = useState(false)
  const [relayError, setRelayError] = useState<string | null>(null)

  // Subscribe to relay status
  useEffect(() => {
    const unsub = window.wzxclaw.onRelayStatus((status) => {
      setRelayConnected(status.connected)
      setRelayConnecting(status.connecting)
      if (status.connected) setRelayError(null)
    })
    return unsub
  }, [])

  // Sync local state when settings store changes or modal opens
  useEffect(() => {
    if (isOpen) {
      setProvider(settingsProvider)
      setModel(settingsModel)
      setApiKey('')
      setBaseURL(settingsBaseURL ?? '')
      setSystemPrompt(settingsSystemPrompt ?? '')
      setRelayToken(settingsRelayToken ?? '')
    }
  }, [isOpen, settingsProvider, settingsModel, settingsBaseURL, settingsSystemPrompt, settingsRelayToken])

  if (!isOpen) return null

  const filteredModels = DEFAULT_MODELS.filter((m) => m.provider === provider)

  const handleProviderChange = (newProvider: string): void => {
    setProvider(newProvider)
    // Auto-select first model for the new provider
    const models = DEFAULT_MODELS.filter((m) => m.provider === newProvider)
    if (models.length > 0) {
      setModel(models[0].id)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      const request: Record<string, unknown> = {
        provider,
        model,
        baseURL: provider === 'openai' ? baseURL : undefined,
        systemPrompt: systemPrompt || undefined,
        relayToken: relayToken || undefined
      }
      // Only send API key if user entered one
      if (apiKey.trim()) {
        request.apiKey = apiKey.trim()
      }
      await updateSettings(request)
      // Try connecting relay if token is provided
      if (relayToken.trim()) {
        try {
          setRelayConnecting(true)
          setRelayError(null)
          await window.wzxclaw.connectRelay({ token: relayToken.trim() })
        } catch (err: any) {
          setRelayError(err.message || '连接失败')
        } finally {
          setRelayConnecting(false)
        }
      }
      onClose()
    } catch (err) {
      console.error('Failed to save settings:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close-btn" onClick={onClose}>
            x
          </button>
        </div>
        <div className="settings-body">
          {/* Provider section */}
          <label className="settings-label">Provider</label>
          <select
            className="settings-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>

          {/* API Key section */}
          <label className="settings-label">API Key</label>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
          />

          {/* Base URL section (only for openai provider) */}
          {provider === 'openai' && (
            <>
              <label className="settings-label">Base URL</label>
              <input
                className="settings-input"
                type="text"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </>
          )}

          {/* Model section */}
          <label className="settings-label">Model</label>
          <select
            className="settings-select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            {filteredModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>

          {/* System Prompt section */}
          <label className="settings-label">System Prompt</label>
          <textarea
            className="settings-textarea"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder="You are a helpful AI coding assistant."
          />

          {/* Relay Token section */}
          <label className="settings-label">Relay Token</label>
          <input
            className="settings-input"
            type="text"
            value={relayToken}
            onChange={(e) => setRelayToken(e.target.value)}
            placeholder="Enter relay pairing token"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 16px' }}>
            {relayConnecting && <span style={{ color: '#fbbf24', fontSize: 12 }}>Connecting...</span>}
            {relayConnected && <span style={{ color: '#4ade80', fontSize: 12 }}>Relay connected</span>}
            {relayError && <span style={{ color: '#f87171', fontSize: 12 }}>Connection failed: {relayError}</span>}
            {!relayConnecting && !relayConnected && !relayError && (
              <span style={{ color: '#666', fontSize: 12 }}>Used for mobile app pairing via relay server</span>
            )}
          </div>

          {/* Save button */}
          <button
            className="settings-save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
