import { create } from 'zustand'
import { DEFAULT_MODELS } from '../../shared/constants'

// ============================================================
// Settings Store (per D-58)
// ============================================================

interface SettingsState {
  provider: string
  model: string
  hasApiKey: boolean
  baseURL?: string
  systemPrompt?: string
  isLoading: boolean
}

interface SettingsActions {
  loadSettings: () => Promise<void>
  updateSettings: (request: Record<string, unknown>) => Promise<void>
  getModelLabel: () => string
}

type SettingsStore = SettingsState & SettingsActions

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  provider: 'openai',
  model: 'gpt-4o',
  hasApiKey: false,
  baseURL: undefined,
  systemPrompt: undefined,
  isLoading: false,

  /**
   * Load current settings from main process via IPC.
   */
  loadSettings: async () => {
    set({ isLoading: true })
    try {
      const settings = await window.wzxclaw.getSettings()
      set({
        provider: settings.provider,
        model: settings.model,
        hasApiKey: settings.hasApiKey,
        baseURL: settings.baseURL,
        systemPrompt: settings.systemPrompt,
        isLoading: false
      })
    } catch (err) {
      console.error('Failed to load settings:', err)
      set({ isLoading: false })
    }
  },

  /**
   * Update settings via IPC, then refresh local state.
   */
  updateSettings: async (request: Record<string, unknown>) => {
    try {
      await window.wzxclaw.updateSettings(request)
      await get().loadSettings()
    } catch (err) {
      console.error('Failed to update settings:', err)
    }
  },

  /**
   * Look up a human-readable model name from DEFAULT_MODELS.
   */
  getModelLabel: () => {
    const { model } = get()
    const preset = DEFAULT_MODELS.find((m) => m.id === model)
    return preset ? preset.name : model
  }
}))
