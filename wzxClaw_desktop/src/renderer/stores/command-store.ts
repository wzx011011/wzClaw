import { create } from 'zustand'
import { useTerminalStore } from './terminal-store'
import { useI18nStore } from '../i18n/i18n-store'

// ============================================================
// Command Store — pluggable command registry for Command Palette
// (per CMD-01 through CMD-05)
// ============================================================

export interface CommandDef {
  id: string
  label: string
  category: string
  shortcut?: string
  handler: () => void | Promise<void>
  available?: boolean // false = shown grayed with "Coming soon"
}

interface CommandState {
  commands: CommandDef[]
  paletteOpen: boolean
}

interface CommandActions {
  register: (cmd: CommandDef) => void
  unregister: (id: string) => void
  execute: (id: string) => void
  openPalette: () => void
  closePalette: () => void
  registerBuiltInCommands: (deps: {
    openFolder: () => void
    clearConversation: () => void
    createSession: () => void
    saveActiveTab: () => void
    updateSettings: (req: Record<string, unknown>) => void
    openSettingsModal: () => void
    reindex: () => void
  }) => void
}

type CommandStore = CommandState & CommandActions

export const useCommandStore = create<CommandStore>((set, get) => ({
  commands: [],
  paletteOpen: false,

  /**
   * Register a command. If a command with the same id already exists,
   * it is replaced (no duplicates).
   */
  register: (cmd) =>
    set((s) => ({
      commands: [...s.commands.filter((c) => c.id !== cmd.id), cmd]
    })),

  /**
   * Remove a command by id.
   */
  unregister: (id) =>
    set((s) => ({
      commands: s.commands.filter((c) => c.id !== id)
    })),

  /**
   * Execute a command by id. Skips commands with available: false.
   * Does nothing if the id is not found.
   */
  execute: (id) => {
    const cmd = get().commands.find((c) => c.id === id)
    if (cmd && cmd.available !== false) {
      cmd.handler()
    }
  },

  /**
   * Open the command palette overlay.
   */
  openPalette: () => set({ paletteOpen: true }),

  /**
   * Close the command palette overlay.
   */
  closePalette: () => set({ paletteOpen: false }),

  /**
   * Register the 8 built-in commands for the IDE.
   * Can be called multiple times safely (replaces by id).
   */
  registerBuiltInCommands: (deps) => {
    const t = useI18nStore.getState().t
    const builtIn: CommandDef[] = [
      {
        id: 'file.open-folder',
        label: t('cmd.file.openFolder'),
        category: t('cmd.category.file'),
        shortcut: 'Ctrl+Shift+O',
        handler: deps.openFolder
      },
      {
        id: 'file.save',
        label: t('cmd.file.save'),
        category: t('cmd.category.file'),
        shortcut: 'Ctrl+S',
        handler: deps.saveActiveTab
      },
      {
        id: 'session.new',
        label: t('cmd.session.new'),
        category: t('cmd.category.session'),
        shortcut: 'Ctrl+T',
        handler: deps.createSession
      },
      {
        id: 'session.clear',
        label: t('cmd.session.clear'),
        category: t('cmd.category.session'),
        handler: deps.clearConversation
      },
      {
        id: 'view.toggle-sidebar',
        label: t('cmd.view.toggleSidebar'),
        category: t('cmd.category.view'),
        shortcut: 'Ctrl+B',
        handler: () => {
          const sidebar = document.querySelector('.sidebar-pane')
          if (sidebar) sidebar.classList.toggle('hidden')
        }
      },
      {
        id: 'view.toggle-terminal',
        label: t('cmd.view.toggleTerminal'),
        category: t('cmd.category.view'),
        shortcut: 'Ctrl+`',
        available: true,
        handler: () => useTerminalStore.getState().togglePanel()
      },
      {
        id: 'settings.change-model',
        label: t('cmd.settings.changeModel'),
        category: t('cmd.category.settings'),
        handler: deps.openSettingsModal
      },
      {
        id: 'settings.open',
        label: t('cmd.settings.open'),
        category: t('cmd.category.settings'),
        handler: deps.openSettingsModal
      },
      {
        id: 'index.reindex',
        label: t('cmd.index.reindex'),
        category: t('cmd.category.index'),
        handler: deps.reindex
      }
    ]

    for (const cmd of builtIn) {
      get().register(cmd)
    }
  }
}))
