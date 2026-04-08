import { create } from 'zustand'

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
    saveActiveTab: () => void
    updateSettings: (req: Record<string, unknown>) => void
    openSettingsModal: () => void
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
    const builtIn: CommandDef[] = [
      {
        id: 'file.open-folder',
        label: 'Open Folder',
        category: 'File',
        shortcut: 'Ctrl+Shift+O',
        handler: deps.openFolder
      },
      {
        id: 'file.save',
        label: 'Save File',
        category: 'File',
        shortcut: 'Ctrl+S',
        handler: deps.saveActiveTab
      },
      {
        id: 'session.new',
        label: 'New Session',
        category: 'Session',
        handler: deps.clearConversation
      },
      {
        id: 'session.clear',
        label: 'Clear Session',
        category: 'Session',
        handler: deps.clearConversation
      },
      {
        id: 'view.toggle-sidebar',
        label: 'Toggle Sidebar',
        category: 'View',
        shortcut: 'Ctrl+B',
        handler: () => {
          // Toggle sidebar visibility via DOM class
          const sidebar = document.querySelector('.sidebar-pane')
          if (sidebar) sidebar.classList.toggle('hidden')
        }
      },
      {
        id: 'view.toggle-terminal',
        label: 'Toggle Terminal',
        category: 'View',
        shortcut: 'Ctrl+`',
        available: false, // Coming soon (Phase 8)
        handler: () => {}
      },
      {
        id: 'settings.change-model',
        label: 'Change Model',
        category: 'Settings',
        handler: deps.openSettingsModal
      },
      {
        id: 'settings.open',
        label: 'Open Settings',
        category: 'Settings',
        handler: deps.openSettingsModal
      }
    ]

    for (const cmd of builtIn) {
      get().register(cmd)
    }
  }
}))
