import type { ThemeMode, AccentColor } from '../../shared/types'

type EffectiveTheme = 'light' | 'dark'

let cleanupSystemThemeListener: (() => void) | null = null

function getSystemTheme(): EffectiveTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'dark'
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyEffectiveTheme(theme: EffectiveTheme): void {
  document.documentElement.setAttribute('data-theme', theme)
  const overlayColors = theme === 'light'
    ? { color: '#f3f3f3', symbolColor: '#1e1e1e' }
    : { color: '#181818', symbolColor: '#e0e0e0' }
  window.wzxclaw.setTitleBarOverlay?.(overlayColors).catch(() => {})
}

export function applyThemeMode(themeMode: ThemeMode): void {
  cleanupSystemThemeListener?.()
  cleanupSystemThemeListener = null

  if (themeMode !== 'system') {
    applyEffectiveTheme(themeMode)
    return
  }

  applyEffectiveTheme(getSystemTheme())

  if (typeof window.matchMedia !== 'function') return
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  const handleChange = (event: MediaQueryListEvent): void => {
    applyEffectiveTheme(event.matches ? 'dark' : 'light')
  }

  mediaQuery.addEventListener('change', handleChange)
  cleanupSystemThemeListener = () => mediaQuery.removeEventListener('change', handleChange)
}

export function applyAccentColor(accentColor: AccentColor): void {
  document.documentElement.setAttribute('data-accent', accentColor)
}

export function applyAppearance(themeMode: ThemeMode, accentColor: AccentColor): void {
  applyAccentColor(accentColor)
  applyThemeMode(themeMode)
}
