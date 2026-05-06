import { useState } from 'react'
import { useSettingsStore } from '../../stores/settings-store'
import { useT, useLocale, useSetLocale } from '../../i18n/useT'

// ============================================================
// GeneralPanel — General settings
// ============================================================

export default function GeneralPanel(): JSX.Element {
  const settings = useSettingsStore()
  const t = useT()
  const locale = useLocale()
  const setLocale = useSetLocale()
  const [showToolSteps, setShowToolSteps] = useState(settings.showToolSteps ?? true)
  const [thinkingDepth, setThinkingDepth] = useState(settings.thinkingDepth ?? 'none')
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt ?? '')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.wzxclaw.updateSettings({
        showToolSteps,
        thinkingDepth,
        systemPrompt,
      })
      await settings.loadSettings()
      setStatus(t('settings.general.saved'))
    } catch (err) {
      setStatus(t('settings.general.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setSaving(false)
      setTimeout(() => setStatus(null), 3000)
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.general.title')}</h2>
      </div>

      <div className="settings-panel-body">
        <div className="settings-form">
          <div className="settings-form-group">
            <label className="settings-label">{t('settings.general.language')}</label>
            <select
              className="settings-select"
              value={locale}
              onChange={(e) => setLocale(e.target.value as 'zh-CN' | 'en')}
            >
              <option value="zh-CN">中文</option>
              <option value="en">English</option>
            </select>
            <span className="settings-hint">{t('settings.general.languageDesc')}</span>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.general.showToolSteps')}</label>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={showToolSteps}
                onChange={(e) => setShowToolSteps(e.target.checked)}
              />
              <span>{t('settings.general.showToolStepsDesc')}</span>
            </label>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.general.thinkingDepth')}</label>
            <select
              className="settings-select"
              value={thinkingDepth}
              onChange={(e) => setThinkingDepth(e.target.value)}
            >
              <option value="none">{t('settings.general.thinkingDepth.none')}</option>
              <option value="low">{t('settings.general.thinkingDepth.low')}</option>
              <option value="medium">{t('settings.general.thinkingDepth.medium')}</option>
              <option value="high">{t('settings.general.thinkingDepth.high')}</option>
            </select>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.general.customPrompt')}</label>
            <textarea
              className="settings-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={t('settings.general.customPromptPlaceholder')}
              rows={6}
            />
            <span className="settings-hint">{t('settings.general.customPromptHint')}</span>
          </div>

          <div className="settings-form-group">
            <label className="settings-label">{t('settings.general.extensionPath')}</label>
            <div className="settings-input-row">
              <button
                className="settings-btn-secondary"
                onClick={async () => {
                  const paths = await window.wzxclaw.getExtensionPaths?.()
                  if (paths) {
                    setStatus(`${t('settings.general.commandsDir', { path: paths.commandsDir })}\n${t('settings.general.skillsDir', { path: paths.skillsDir })}`)
                    setTimeout(() => setStatus(null), 10000)
                  }
                }}
              >
                {t('settings.general.showExtensionPath')}
              </button>
              <button
                className="settings-btn-secondary"
                onClick={() => {
                  const dir = window.wzxclaw.openInExplorer?.('~/.wzxclaw')
                  // fallback
                  if (!dir) window.wzxclaw.openInExplorer?.(process.env.USERPROFILE ?? '~')
                }}
              >
                {t('settings.general.openConfigDir')}
              </button>
            </div>
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
