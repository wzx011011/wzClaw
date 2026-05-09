// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import AppearancePanel from '../settings/AppearancePanel'
import { useSettingsStore } from '../../stores/settings-store'

vi.mock('../../i18n/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string>) => {
    const labels: Record<string, string> = {
      'settings.appearance.title': '外观',
      'settings.appearance.themeMode': '主题模式',
      'settings.appearance.accentColor': '强调色',
      'settings.appearance.theme.system': '跟随系统',
      'settings.appearance.theme.light': '浅色',
      'settings.appearance.theme.dark': '深色',
      'settings.appearance.accent.green': '绿色',
      'settings.appearance.accent.purple': '紫色',
      'settings.appearance.save': '保存外观设置',
      'settings.appearance.saving': '保存中...',
      'settings.appearance.saved': '已保存',
      'settings.appearance.saveFailed': `保存失败：${vars?.error ?? ''}。请重试`,
      'settings.appearance.systemHint': '跟随系统会随操作系统外观自动切换',
      'settings.appearance.themeAria': '选择主题模式',
      'settings.appearance.greenAria': '绿色强调色',
      'settings.appearance.purpleAria': '紫色强调色',
    }
    return labels[key] ?? key
  },
}))

describe('AppearancePanel', () => {
  const updateSettings = vi.fn()
  const getSettings = vi.fn()
  const setTitleBarOverlay = vi.fn()

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-accent')
    updateSettings.mockResolvedValue(undefined)
    getSettings.mockResolvedValue({
      provider: 'openai',
      model: 'gpt-4o',
      hasApiKey: false,
      themeMode: 'light',
      accentColor: 'purple',
    })
    setTitleBarOverlay.mockResolvedValue(undefined)
    Object.assign(window, {
      wzxclaw: { updateSettings, getSettings, setTitleBarOverlay },
      matchMedia: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    })
    useSettingsStore.setState({
      provider: 'openai',
      model: 'gpt-4o',
      hasApiKey: false,
      themeMode: 'dark',
      accentColor: 'green',
      isLoading: false,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders theme mode and accent controls', () => {
    render(<AppearancePanel />)

    expect(screen.getByText('外观')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '浅色' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '紫色强调色' })).toBeInTheDocument()
  })

  it('previews theme and accent immediately', () => {
    render(<AppearancePanel />)

    fireEvent.click(screen.getByRole('radio', { name: '浅色' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: '紫色强调色' }))
    expect(document.documentElement.getAttribute('data-accent')).toBe('purple')
  })

  it('shows system hint only for system mode', () => {
    render(<AppearancePanel />)

    expect(screen.queryByText('跟随系统会随操作系统外观自动切换')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '跟随系统' }))
    expect(screen.getByText('跟随系统会随操作系统外观自动切换')).toBeInTheDocument()
  })

  it('saves appearance settings and reloads store', async () => {
    render(<AppearancePanel />)

    fireEvent.click(screen.getByRole('radio', { name: '浅色' }))
    fireEvent.click(screen.getByRole('button', { name: '紫色强调色' }))
    fireEvent.click(screen.getByRole('button', { name: '保存外观设置' }))

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ themeMode: 'light', accentColor: 'purple' }))
    expect(getSettings).toHaveBeenCalledOnce()
    expect(await screen.findByText('已保存')).toBeInTheDocument()
  })

  it('supports arrow key navigation in theme picker', () => {
    render(<AppearancePanel />)

    const darkButton = screen.getByRole('radio', { name: '深色' })
    darkButton.focus()
    fireEvent.keyDown(darkButton, { key: 'ArrowLeft' })

    expect(screen.getByRole('radio', { name: '浅色' })).toHaveFocus()
  })
})
