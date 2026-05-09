// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { applyAccentColor, applyAppearance, applyThemeMode } from '../appearance'

describe('appearance theme helper', () => {
  const setTitleBarOverlay = vi.fn()
  let matchMediaListeners: Array<(event: MediaQueryListEvent) => void> = []

  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-accent')
    setTitleBarOverlay.mockResolvedValue(undefined)
    matchMediaListeners = []
    Object.assign(window, {
      wzxclaw: { setTitleBarOverlay },
      matchMedia: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn((_event: string, cb: (event: MediaQueryListEvent) => void) => {
          matchMediaListeners.push(cb)
        }),
        removeEventListener: vi.fn(),
      }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('applies light theme and titlebar overlay', () => {
    applyThemeMode('light')

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(setTitleBarOverlay).toHaveBeenCalledWith({ color: '#f3f3f3', symbolColor: '#1e1e1e' })
  })

  it('applies dark theme and titlebar overlay', () => {
    applyThemeMode('dark')

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(setTitleBarOverlay).toHaveBeenCalledWith({ color: '#181818', symbolColor: '#e0e0e0' })
  })

  it('resolves system theme through matchMedia and reacts to changes', () => {
    applyThemeMode('system')

    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(matchMediaListeners).toHaveLength(1)

    matchMediaListeners[0]({ matches: true } as MediaQueryListEvent)

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('applies accent color', () => {
    applyAccentColor('purple')

    expect(document.documentElement.getAttribute('data-accent')).toBe('purple')
  })

  it('applies theme and accent together', () => {
    applyAppearance('dark', 'green')

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-accent')).toBe('green')
  })
})
