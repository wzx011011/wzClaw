import { useState, useEffect } from 'react'
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
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    setProvider(settings.provider)
    setModel(settings.model)
    setBaseURL(settings.baseURL ?? '')
  }, [settings.provider, settings.model, settings.baseURL])

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.wzxclaw.updateSettings({ provider, model, baseURL })
      await settings.loadSettings()
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
              <span className="settings-key-status">
                {settings.hasApiKey ? t('settings.models.apiKeyConfigured') : t('settings.models.apiKeyNotConfigured')}
              </span>
              <button
                className="settings-btn-secondary"
                onClick={() => window.wzxclaw.updateSettings({}).then(() => settings.loadSettings())}
              >
                {t('settings.models.reEnter')}
              </button>
            </div>
            <span className="settings-hint">{t('settings.models.apiKeyHint')}</span>
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
