import { useState, useEffect, useCallback } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { DEFAULT_MODELS } from '../../../shared/constants'
import { useT } from '../../i18n/useT'

// ============================================================
// ModelsPanel — Model provider configuration
// ============================================================

export default function ModelsPanel(): JSX.Element {
  const t = useT()
  const settings = useSettingsStore()
  const [provider, setProvider] = useState(settings.provider)
  const [model, setModel] = useState(settings.model)
  const [baseURL, setBaseURL] = useState(settings.baseURL ?? '')
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    setProvider(settings.provider)
    setModel(settings.model)
    setBaseURL(settings.baseURL ?? '')
    // 输入框为空时用脱敏值占位
    if (!apiKeyInput) {
      setApiKeyInput(settings.maskedApiKey ?? '')
    }
  }, [settings.provider, settings.model, settings.baseURL, settings.maskedApiKey])

  const handleSave = async () => {
    setSaving(true)
    try {
      const update: Record<string, unknown> = { provider, model, baseURL }
      // 只有用户实际修改了 key（不是脱敏值）才发送
      if (apiKeyInput && apiKeyInput !== settings.maskedApiKey && !apiKeyInput.includes('****')) {
        update.apiKey = apiKeyInput
      }
      await window.wzxclaw.updateSettings(update)
      await settings.loadSettings()
      setApiKeyInput('')
      setStatus(t('settings.general.saved'))
    } catch (err) {
      setStatus(t('settings.general.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
      setTimeout(() => setStatus(null), 3000)
    }
  }

  const providerModels = DEFAULT_MODELS.filter(m => m.provider === provider)

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.models.title')}</h2>
      </div>

      <div className="settings-panel-body">
        <div className="settings-form">
          <div className="settings-form-group">
            <label className="settings-label">{t('settings.models.provider')}</label>
            <select
              className="settings-select"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value)
                // Auto-switch to first model of this provider
                const firstModel = DEFAULT_MODELS.find(m => m.provider === e.target.value)
                if (firstModel) setModel(firstModel.id)
              }}
            >
              <option value="openai">{t('settings.models.providerOpenAI')}</option>
              <option value="anthropic">{t('settings.models.providerAnthropic')}</option>
            </select>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.models.model')}</label>
            <select
              className="settings-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {providerModels.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
              {providerModels.length === 0 && (
                <option value={model}>{model}</option>
              )}
            </select>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.models.baseUrl')}</label>
            <input
              type="text"
              className="settings-input"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder={t('settings.models.baseUrlPlaceholder')}
            />
            <span className="settings-hint">{t('settings.models.baseUrlHint')}</span>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.models.apiKey')}</label>
            <div className="settings-input-row">
              <input
                type={showApiKey ? 'text' : 'password'}
                className="settings-input"
                style={{ flex: 1, fontFamily: 'monospace' }}
                value={apiKeyInput || settings.maskedApiKey || ''}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={settings.hasApiKey ? undefined : t('settings.models.apiKeyPlaceholder')}
              />
              <button
                className="settings-btn-secondary"
                onClick={() => setShowApiKey(!showApiKey)}
                title={showApiKey ? t('settings.models.hideKey') : t('settings.models.showKey')}
              >
                {showApiKey ? '🙈' : '👁'}
              </button>
            </div>
            <span className="settings-hint">{settings.hasApiKey ? t('settings.models.apiKeyConfigured') : t('settings.models.apiKeyNotConfigured')}</span>
          </div>

          {status && <div className="settings-panel-status">{status}</div>}

          <div className="settings-form-actions">
            <button
              className="settings-btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? t('settings.general.saving') : t('settings.general.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
