import { create } from 'zustand'
import { DEFAULT_MODELS } from '../../shared/constants'
import type { ThemeMode, AccentColor } from '../../shared/types'

// ============================================================
// Settings Store (per D-58)
// ============================================================

interface SettingsState {
  provider: string
  model: string
  hasApiKey: boolean
  maskedApiKey?: string
  baseURL?: string
  systemPrompt?: string
  relayToken?: string
  thinkingDepth?: string
  showToolSteps?: boolean
  language?: string
  notificationSound?: boolean
  notificationDesktop?: boolean
  themeMode: ThemeMode
  accentColor: AccentColor
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
  maskedApiKey: undefined,
  baseURL: undefined,
  systemPrompt: undefined,
  thinkingDepth: undefined,
  showToolSteps: true,
  language: 'zh-CN',
  notificationSound: true,
  notificationDesktop: true,
  themeMode: 'dark',
  accentColor: 'green',
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
        maskedApiKey: settings.maskedApiKey,
        baseURL: settings.baseURL,
        systemPrompt: settings.systemPrompt,
        relayToken: settings.relayToken,
        thinkingDepth: settings.thinkingDepth,
        showToolSteps: settings.showToolSteps ?? true,
        language: settings.language ?? 'zh-CN',
        notificationSound: settings.notificationSound ?? true,
        notificationDesktop: settings.notificationDesktop ?? true,
        themeMode: settings.themeMode ?? 'dark',
        accentColor: settings.accentColor ?? 'green',
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
