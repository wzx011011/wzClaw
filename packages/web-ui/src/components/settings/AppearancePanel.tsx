// ============================================================
// AppearancePanel — 外观设置
//
// 主题（dark/light）+ 语言（中文/英文）+ 字体大小
// ============================================================

import { useState, useEffect } from 'react'
import { useConnectionConfig } from '../../hooks/useConnectionConfig'
import { useI18nStore } from '../../i18n/i18n-store'
import { useToastStore } from '../../stores/toast-store'

const FONT_SIZES = [
  { label: '小', value: '11px' },
  { label: '默认', value: '13px' },
  { label: '大', value: '15px' },
  { label: '特大', value: '17px' },
]

const DENSITY = [
  { label: '紧凑', value: 'compact' },
  { label: '默认', value: 'normal' },
  { label: '宽松', value: 'spacious' },
]

function getFontSize(): string {
  try { return localStorage.getItem('wzxclaw-font-size') ?? '13px' } catch { return '13px' }
}
function setFontSizeStorage(v: string): void {
  try { localStorage.setItem('wzxclaw-font-size', v) } catch { /**/ }
  document.documentElement.style.setProperty('--font-size-base', v)
}
function getDensity(): string {
  try { return localStorage.getItem('wzxclaw-density') ?? 'normal' } catch { return 'normal' }
}
function setDensityStorage(v: string): void {
  try { localStorage.setItem('wzxclaw-density', v) } catch { /**/ }
  document.documentElement.setAttribute('data-density', v)
}

export default function AppearancePanel(): React.ReactElement {
  const { config, saveConfig } = useConnectionConfig()
  const setLocale = useI18nStore((s) => s.setLocale)
  const toast = useToastStore((s) => s.show)
  const [themeMode, setThemeMode] = useState(config.themeMode ?? 'dark')
  const [language, setLanguage] = useState(config.language ?? 'zh-CN')
  const [fontSize, setFontSize] = useState(getFontSize)
  const [density, setDensity] = useState(getDensity)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', themeMode)
  }, [themeMode])

  function handleSave() {
    saveConfig({ themeMode: themeMode as 'dark' | 'light', language })
    setLocale(language as 'zh-CN' | 'en')
    setFontSizeStorage(fontSize)
    setDensityStorage(density)
    toast('外观设置已保存', 'success')
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">外观</h3>
      <div className="settings-card">
        {/* 主题 */}
        <div className="settings-field">
          <label className="settings-label">主题</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {(['dark', 'light'] as const).map((t) => (
              <button key={t} onClick={() => setThemeMode(t)} style={{
                padding: '6px 16px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${themeMode === t ? 'var(--accent)' : 'var(--border)'}`,
                background: themeMode === t ? 'var(--accent)' : 'transparent',
                color: themeMode === t ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}>
                {t === 'dark' ? '暗色' : '亮色'}
              </button>
            ))}
          </div>
        </div>

        {/* 语言 */}
        <div className="settings-field">
          <label className="settings-label">语言</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {[{ v: 'zh-CN', l: '中文' }, { v: 'en', l: 'English' }].map(({ v, l }) => (
              <button key={v} onClick={() => setLanguage(v)} style={{
                padding: '6px 16px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${language === v ? 'var(--accent)' : 'var(--border)'}`,
                background: language === v ? 'var(--accent)' : 'transparent',
                color: language === v ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}>
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* 字体大小 */}
        <div className="settings-field">
          <label className="settings-label">字体大小</label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {FONT_SIZES.map((f) => (
              <button key={f.value} onClick={() => setFontSize(f.value)} style={{
                padding: '6px 14px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${fontSize === f.value ? 'var(--accent)' : 'var(--border)'}`,
                background: fontSize === f.value ? 'var(--accent)' : 'transparent',
                color: fontSize === f.value ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: f.value,
              }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* 密度 */}
        <div className="settings-field">
          <label className="settings-label">信息密度</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {DENSITY.map((d) => (
              <button key={d.value} onClick={() => setDensity(d.value)} style={{
                padding: '6px 14px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${density === d.value ? 'var(--accent)' : 'var(--border)'}`,
                background: density === d.value ? 'var(--accent)' : 'transparent',
                color: density === d.value ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: 'var(--font-size-sm)',
              }}>
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <button className="settings-save-btn" onClick={handleSave}>保存外观设置</button>
      </div>
    </div>
  )
}
