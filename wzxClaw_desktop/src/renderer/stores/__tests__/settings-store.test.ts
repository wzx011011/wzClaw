import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useSettingsStore } from '../settings-store'

// Helper to get the mocked wzxclaw IPC object
function getWzxclaw(): Record<string, ReturnType<typeof vi.fn>> {
  return (globalThis as unknown as { window: { wzxclaw: Record<string, ReturnType<typeof vi.fn>> } }).window.wzxclaw
}

describe('SettingsStore', () => {
  const mockWzxclaw = {
    getSettings: vi.fn(),
    updateSettings: vi.fn()
  }

  beforeEach(() => {
    // Set up global window.wzxclaw mock
    ;(globalThis as Record<string, unknown>).window = { wzxclaw: { ...mockWzxclaw } }

    // Reset store to initial defaults
    useSettingsStore.setState({
      provider: 'openai',
      model: 'gpt-4o',
      hasApiKey: false,
      baseURL: undefined,
      systemPrompt: undefined,
      relayToken: undefined,
      thinkingDepth: undefined,
      isLoading: false
    })

    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('initial state has correct defaults', () => {
    const state = useSettingsStore.getState()
    expect(state.provider).toBe('openai')
    expect(state.model).toBe('gpt-4o')
    expect(state.hasApiKey).toBe(false)
    expect(state.isLoading).toBe(false)
    expect(state.baseURL).toBeUndefined()
    expect(state.systemPrompt).toBeUndefined()
  })

  it('loadSettings calls window.wzxclaw.getSettings() and updates state', async () => {
    getWzxclaw().getSettings.mockResolvedValueOnce({
      provider: 'anthropic',
      model: 'claude-3-opus',
      hasApiKey: true,
      baseURL: 'https://api.anthropic.com',
      systemPrompt: 'Be helpful',
      relayToken: 'token-123',
      thinkingDepth: 'deep'
    })

    const { loadSettings } = useSettingsStore.getState()
    await loadSettings()

    const state = useSettingsStore.getState()
    expect(getWzxclaw().getSettings).toHaveBeenCalledOnce()
    expect(state.provider).toBe('anthropic')
    expect(state.model).toBe('claude-3-opus')
    expect(state.hasApiKey).toBe(true)
    expect(state.baseURL).toBe('https://api.anthropic.com')
    expect(state.systemPrompt).toBe('Be helpful')
    expect(state.relayToken).toBe('token-123')
    expect(state.thinkingDepth).toBe('deep')
    expect(state.isLoading).toBe(false)
  })

  it('loadSettings sets isLoading=true during fetch', async () => {
    let resolveSettings: (value: unknown) => void
    const settingsPromise = new Promise((resolve) => {
      resolveSettings = resolve
    })
    getWzxclaw().getSettings.mockReturnValueOnce(settingsPromise)

    const { loadSettings } = useSettingsStore.getState()
    const loadPromise = loadSettings()

    // While the promise is pending, isLoading should be true
    expect(useSettingsStore.getState().isLoading).toBe(true)

    // Resolve the settings
    resolveSettings!({
      provider: 'openai',
      model: 'gpt-4o',
      hasApiKey: false
    })

    await loadPromise

    // After resolution, isLoading should be false
    expect(useSettingsStore.getState().isLoading).toBe(false)
  })

  it('loadSettings catches errors and sets isLoading=false', async () => {
    getWzxclaw().getSettings.mockRejectedValueOnce(new Error('IPC failure'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { loadSettings } = useSettingsStore.getState()
    await loadSettings()

    const state = useSettingsStore.getState()
    expect(state.isLoading).toBe(false)
    expect(consoleSpy).toHaveBeenCalledWith('Failed to load settings:', expect.any(Error))

    consoleSpy.mockRestore()
  })

  it('updateSettings calls window.wzxclaw.updateSettings() then loadSettings()', async () => {
    getWzxclaw().updateSettings.mockResolvedValueOnce(undefined)
    getWzxclaw().getSettings.mockResolvedValueOnce({
      provider: 'openai',
      model: 'gpt-4o-mini',
      hasApiKey: true,
      baseURL: 'https://api.openai.com'
    })

    const { updateSettings } = useSettingsStore.getState()
    await updateSettings({ model: 'gpt-4o-mini' })

    expect(getWzxclaw().updateSettings).toHaveBeenCalledWith({ model: 'gpt-4o-mini' })
    expect(getWzxclaw().getSettings).toHaveBeenCalledOnce()

    const state = useSettingsStore.getState()
    expect(state.model).toBe('gpt-4o-mini')
    expect(state.hasApiKey).toBe(true)
  })

  it('getModelLabel returns preset name for known model id', () => {
    // gpt-4o should exist in DEFAULT_MODELS — set model and check
    useSettingsStore.setState({ model: 'gpt-4o' })

    const { getModelLabel } = useSettingsStore.getState()
    const label = getModelLabel()

    // Should return the preset name from DEFAULT_MODELS, not the raw id
    expect(label).not.toBe('gpt-4o')
    // The label should be a human-readable name
    expect(typeof label).toBe('string')
    expect(label.length).toBeGreaterThan(0)
  })

  it('getModelLabel returns raw model string for unknown model id', () => {
    useSettingsStore.setState({ model: 'nonexistent-model-xyz' })

    const { getModelLabel } = useSettingsStore.getState()
    const label = getModelLabel()

    expect(label).toBe('nonexistent-model-xyz')
  })
})
