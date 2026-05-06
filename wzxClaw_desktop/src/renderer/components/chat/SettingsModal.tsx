import { useState, useEffect } from 'react'
import { useT } from '../../i18n/useT'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useSettingsStore } from '../../stores/settings-store'
import { useToastStore } from '../../stores/toast-store'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * SettingsModal — modal dialog for API key input and provider configuration (per D-65).
 * Allows user to configure provider, API key, base URL, model, and system prompt.
 */
export default function SettingsModal({ isOpen, onClose }: SettingsModalProps): JSX.Element | null {
  const t = useT()
  const settingsProvider = useSettingsStore((s) => s.provider)
  const settingsModel = useSettingsStore((s) => s.model)
  const settingsBaseURL = useSettingsStore((s) => s.baseURL)
  const settingsSystemPrompt = useSettingsStore((s) => s.systemPrompt)
  const settingsRelayToken = useSettingsStore((s) => s.relayToken)
  const settingsShowToolSteps = useSettingsStore((s) => s.showToolSteps)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  // Local form state initialized from settings store
  const [provider, setProvider] = useState(settingsProvider)
  const [model, setModel] = useState(settingsModel)
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState(settingsBaseURL ?? '')
  const [systemPrompt, setSystemPrompt] = useState(settingsSystemPrompt ?? '')
  const [relayToken, setRelayToken] = useState(settingsRelayToken ?? '')
  const [showToolSteps, setShowToolSteps] = useState(settingsShowToolSteps ?? true)
  const [saving, setSaving] = useState(false)
  const [relayConnected, setRelayConnected] = useState(false)
  const [relayConnecting, setRelayConnecting] = useState(false)
  const [relayError, setRelayError] = useState<string | null>(null)
  const [extensionPaths, setExtensionPaths] = useState<{ commandsDir: string; skillsDir: string } | null>(null)

  // Subscribe to relay status
  useEffect(() => {
    const unsub = window.wzxclaw.onRelayStatus((status) => {
      setRelayConnected(status.connected)
      setRelayConnecting(status.connecting)
      if (status.connected) setRelayError(null)
    })
    return unsub
  }, [])

  // Load extension directory paths once
  useEffect(() => {
    window.wzxclaw.getExtensionPaths().then(setExtensionPaths).catch(() => {})
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
      setShowToolSteps(settingsShowToolSteps ?? true)
    }
  }, [isOpen, settingsProvider, settingsModel, settingsBaseURL, settingsSystemPrompt, settingsRelayToken, settingsShowToolSteps])

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
        baseURL: baseURL.trim(),  // 空字符串表示清除自定义 URL，始终发送以便主进程能更新
        systemPrompt: systemPrompt || undefined,
        relayToken: relayToken || undefined,
        showToolSteps
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
        } catch (err: unknown) {
          setRelayError(err instanceof Error ? err.message : t('settingsModal.connectFailed', { error: '' }))
        } finally {
          setRelayConnecting(false)
        }
      }
      onClose()
    } catch (err) {
      console.error('Failed to save settings:', err)
      useToastStore.getState().show(t('settingsModal.saveFailed'), 'error')
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
          <h3>{t('settingsModal.title')}</h3>
          <button className="settings-close-btn" onClick={onClose}>
            x
          </button>
        </div>
        <div className="settings-body">
          {/* Provider section */}
          <label className="settings-label">{t('settingsModal.provider')}</label>
          <select
            className="settings-select"
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value)}
          >
            <option value="openai">OpenAI Compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>

          {/* API Key section */}
          <label className="settings-label">{t('settingsModal.apiKey')}</label>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t('settingsModal.apiKeyPlaceholder')}
          />

          {/* Base URL section */}
          <label className="settings-label">{t('settingsModal.baseUrl')}</label>
          <input
            className="settings-input"
            type="text"
            value={baseURL}
            onChange={(e) => setBaseURL(e.target.value)}
            placeholder={
              provider === 'anthropic'
                ? t('settingsModal.baseUrlPlaceholder')
                : 'https://api.openai.com/v1'
            }
          />

          {/* Model section */}
          <label className="settings-label">{t('settingsModal.model')}</label>
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
          <label className="settings-label">{t('settingsModal.systemPrompt')}</label>
          <textarea
            className="settings-textarea"
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            placeholder="You are a helpful AI coding assistant."
          />

          {/* Show Tool Steps toggle */}
          <label className="settings-label" style={{ marginTop: 8 }}>{t('settingsModal.showToolSteps')}</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', fontSize: 'var(--font-size-sm, 13px)', color: 'var(--text-secondary, #aaa)' }}>
              <input
                type="checkbox"
                checked={showToolSteps}
                onChange={(e) => setShowToolSteps(e.target.checked)}
                style={{ marginRight: 8 }}
              />
              {t('settings.general.showToolStepsDesc')}
            </label>
          </div>

          {/* Relay Token section */}
          <label className="settings-label">{t('settingsModal.relayToken')}</label>
          <input
            className="settings-input"
            type="text"
            value={relayToken}
            onChange={(e) => setRelayToken(e.target.value)}
            placeholder=""
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0 16px' }}>
            {relayConnecting && <span style={{ color: 'var(--warning)', fontSize: 'var(--font-size-sm)' }}>{t('settingsModal.connecting')}</span>}
            {relayConnected && <span style={{ color: 'var(--success)', fontSize: 'var(--font-size-sm)' }}>{t('settingsModal.relayConnected')}</span>}
            {relayError && <span style={{ color: 'var(--error)', fontSize: 'var(--font-size-sm)' }}>{t('settingsModal.connectFailed', { error: relayError })}</span>}
            {!relayConnecting && !relayConnected && !relayError && (
              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>{t('settingsModal.relayTokenHint')}</span>
            )}
          </div>

          {/* User Extensions section */}
          {extensionPaths && (
            <>
              <label className="settings-label" style={{ marginTop: 8 }}>{t('settingsModal.userExtensions')}</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t('settingsModal.commands')} {extensionPaths.commandsDir}
                  </span>
                  <button
                    className="settings-save-btn"
                    style={{ padding: '2px 10px', fontSize: 12, width: 'auto' }}
                    onClick={() => window.wzxclaw.openInExplorer(extensionPaths.commandsDir)}
                  >
                    {t('settingsModal.open')}
                  </button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--text-secondary)', fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t('settingsModal.skills')} {extensionPaths.skillsDir}
                  </span>
                  <button
                    className="settings-save-btn"
                    style={{ padding: '2px 10px', fontSize: 12, width: 'auto' }}
                    onClick={() => window.wzxclaw.openInExplorer(extensionPaths.skillsDir)}
                  >
                    {t('settingsModal.open')}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Save button */}
          <button
            className="settings-save-btn"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? t('settingsModal.saving') : t('settingsModal.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
