import { create } from 'zustand'
import type { TerminalInstance } from '../../shared/types'
import { useWorkspaceStore } from './workspace-store'

// ============================================================
// Terminal Store — state management for terminal panel tabs
// (per TERM-01 through TERM-07)
// ============================================================

interface TerminalState {
  tabs: TerminalInstance[]
  activeTerminalId: string | null
  panelVisible: boolean
}

interface TerminalActions {
  togglePanel: () => void
  showPanel: () => void
  hidePanel: () => void
  createTerminal: () => Promise<void>
  switchTerminal: (id: string) => void
  closeTerminal: (id: string) => void
}

type TerminalStore = TerminalState & TerminalActions

let terminalCounter = 0

export const useTerminalStore = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeTerminalId: null,
  panelVisible: false,

  togglePanel: () => {
    const { panelVisible, tabs } = get()
    if (panelVisible) {
      set({ panelVisible: false })
    } else {
      // If no terminals exist yet, create one
      if (tabs.length === 0) {
        get().createTerminal()
      }
      set({ panelVisible: true })
    }
  },

  showPanel: () => {
    const { tabs } = get()
    if (tabs.length === 0) {
      get().createTerminal()
    }
    set({ panelVisible: true })
  },

  hidePanel: () => {
    set({ panelVisible: false })
  },

  createTerminal: async () => {
    const rootPath = useWorkspaceStore.getState().rootPath ?? process.cwd()
    try {
      const result = await window.wzxclaw.createTerminal({ cwd: rootPath })
      terminalCounter++
      const newTab: TerminalInstance = {
        id: result.terminalId,
        title: `bash (${terminalCounter})`,
        isActive: true
      }
      const { tabs } = get()
      // Mark all existing tabs as inactive
      const updatedTabs = tabs.map((t) => ({ ...t, isActive: false }))
      set({
        tabs: [...updatedTabs, newTab],
        activeTerminalId: result.terminalId,
        panelVisible: true
      })
    } catch (err) {
      console.error('Failed to create terminal:', err)
    }
  },

  switchTerminal: (id: string) => {
    const { tabs } = get()
    const updatedTabs = tabs.map((t) => ({
      ...t,
      isActive: t.id === id
    }))
    set({ tabs: updatedTabs, activeTerminalId: id })
  },

  closeTerminal: (id: string) => {
    const { tabs, activeTerminalId } = get()
    window.wzxclaw.killTerminal({ terminalId: id }).catch((err) => {
      console.error('Failed to kill terminal:', err)
    })

    const remaining = tabs.filter((t) => t.id !== id)
    if (remaining.length === 0) {
      // No terminals left — hide panel
      set({ tabs: [], activeTerminalId: null, panelVisible: false })
    } else if (activeTerminalId === id) {
      // Closed the active tab — switch to the last remaining
      const lastTab = remaining[remaining.length - 1]
      const updatedTabs = remaining.map((t) => ({
        ...t,
        isActive: t.id === lastTab.id
      }))
      set({ tabs: updatedTabs, activeTerminalId: lastTab.id })
    } else {
      set({ tabs: remaining })
    }
  }
}))
