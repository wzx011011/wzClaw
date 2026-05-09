import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { useT } from '../../i18n/useT'
import { useSettingsStore } from '../../stores/settings-store'
import { applyAccentColor, applyThemeMode } from '../../theme/appearance'
import type { ThemeMode, AccentColor } from '../../../shared/types'

const THEME_OPTIONS: Array<{ value: ThemeMode; labelKey: string }> = [
  { value: 'system', labelKey: 'settings.appearance.theme.system' },
  { value: 'light', labelKey: 'settings.appearance.theme.light' },
  { value: 'dark', labelKey: 'settings.appearance.theme.dark' },
]

const ACCENT_OPTIONS: Array<{ value: AccentColor; labelKey: string; ariaKey: string; color: string }> = [
  { value: 'green', labelKey: 'settings.appearance.accent.green', ariaKey: 'settings.appearance.greenAria', color: '#10b981' },
  { value: 'purple', labelKey: 'settings.appearance.accent.purple', ariaKey: 'settings.appearance.purpleAria', color: '#7c3aed' },
]

export default function AppearancePanel(): JSX.Element {
  const t = useT()
  const settings = useSettingsStore()
  const [themeMode, setThemeMode] = useState<ThemeMode>(settings.themeMode)
  const [accentColor, setAccentColor] = useState<AccentColor>(settings.accentColor)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const themeButtonRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    setThemeMode(settings.themeMode)
    setAccentColor(settings.accentColor)
  }, [settings.themeMode, settings.accentColor])

  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    }
  }, [])

  const clearStatus = (): void => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current)
    statusTimerRef.current = null
    setStatus(null)
  }

  const handleThemeChange = (value: ThemeMode): void => {
    clearStatus()
    setThemeMode(value)
    applyThemeMode(value)
  }

  const handleAccentChange = (value: AccentColor): void => {
    clearStatus()
    setAccentColor(value)
    applyAccentColor(value)
  }

  const focusThemeOption = (index: number): void => {
    const nextIndex = (index + THEME_OPTIONS.length) % THEME_OPTIONS.length
    themeButtonRefs.current[nextIndex]?.focus()
  }

  const handleThemeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, value: ThemeMode): void => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusThemeOption(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusThemeOption(index - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleThemeChange(value)
    }
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    clearStatus()
    try {
      await window.wzxclaw.updateSettings({ themeMode, accentColor })
      await settings.loadSettings()
      setStatus({ kind: 'success', text: t('settings.appearance.saved') })
      statusTimerRef.current = setTimeout(() => setStatus(null), 3000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setStatus({ kind: 'error', text: t('settings.appearance.saveFailed', { error: message }) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-panel appearance-panel">
      <div className="settings-panel-header">
        <h2 className="settings-panel-title">{t('settings.appearance.title')}</h2>
      </div>

      <div className="settings-panel-body">
        <div className="settings-form appearance-form">
          <div className="settings-form-group appearance-section">
            <label className="settings-label">{t('settings.appearance.themeMode')}</label>
            <div className="appearance-theme-picker" role="radiogroup" aria-label={t('settings.appearance.themeAria')}>
              {THEME_OPTIONS.map((option, index) => (
                <button
                  key={option.value}
                  ref={(element) => { themeButtonRefs.current[index] = element }}
                  type="button"
                  role="radio"
                  aria-checked={themeMode === option.value}
                  className={`appearance-theme-btn${themeMode === option.value ? ' active' : ''}`}
                  onClick={() => handleThemeChange(option.value)}
                  onKeyDown={(event) => handleThemeKeyDown(event, index, option.value)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
            {themeMode === 'system' && (
              <span className="settings-hint">{t('settings.appearance.systemHint')}</span>
            )}
          </div>

          <div className="settings-form-group appearance-section">
            <label className="settings-label">{t('settings.appearance.accentColor')}</label>
            <div className="appearance-accent-picker">
              {ACCENT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`appearance-accent-option${accentColor === option.value ? ' active' : ''}`}
                  aria-pressed={accentColor === option.value}
                  aria-label={t(option.ariaKey)}
                  onClick={() => handleAccentChange(option.value)}
                >
                  <span className="appearance-accent-swatch" style={{ backgroundColor: option.color }} />
                  <span className="appearance-accent-label">{t(option.labelKey)}</span>
                </button>
              ))}
            </div>
          </div>

          {status && (
            <div className={`settings-panel-status appearance-status ${status.kind}`}>
              {status.text}
            </div>
          )}

          <div className="settings-form-actions">
            <button className="settings-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? t('settings.appearance.saving') : t('settings.appearance.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
