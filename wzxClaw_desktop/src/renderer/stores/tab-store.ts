import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { EditorTab } from '../../shared/types'

// ============================================================
// Tab Store (per D-49, D-50, D-51, D-52)
// ============================================================

interface TabState {
  tabs: EditorTab[]
  activeTabId: string | null
}

interface TabActions {
  openTab: (
    filePath: string,
    fileName: string,
    content: string,
    language: string
  ) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  updateTabContent: (tabId: string, content: string) => void
  saveTab: (tabId: string) => Promise<void>
  getActiveTab: () => EditorTab | undefined
  refreshTabContent: (tabId: string, newContent: string) => void
  openOrRefreshTab: (filePath: string) => Promise<void>
  handleExternalFileChange: (filePath: string, changeType: string) => Promise<void>
}

type TabStore = TabState & TabActions

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openTab: (filePath, fileName, content, language) => {
    const { tabs } = get()
    // If tab already exists for this file, just activate it
    const existing = tabs.find((t) => t.filePath === filePath)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }

    // Create new tab
    const newTab: EditorTab = {
      id: uuidv4(),
      filePath,
      fileName,
      content,
      diskContent: content,
      isDirty: false,
      language
    }
    set({
      tabs: [...tabs, newTab],
      activeTabId: newTab.id
    })
  },

  closeTab: (tabId) => {
    const { tabs, activeTabId } = get()
    const index = tabs.findIndex((t) => t.id === tabId)
    if (index === -1) return

    const newTabs = tabs.filter((t) => t.id !== tabId)

    // If closing the active tab, activate adjacent (prefer right, then left)
    let newActiveId = activeTabId
    if (activeTabId === tabId) {
      if (newTabs.length === 0) {
        newActiveId = null
      } else {
        // Prefer right neighbor, then left
        const rightIndex = Math.min(index, newTabs.length - 1)
        newActiveId = newTabs[rightIndex]?.id ?? null
      }
    }

    set({ tabs: newTabs, activeTabId: newActiveId })
  },

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
  },

  updateTabContent: (tabId, content) => {
    set({
      tabs: get().tabs.map((t) => {
        if (t.id !== tabId) return t
        return {
          ...t,
          content,
          isDirty: content !== t.diskContent
        }
      })
    })
  },

  saveTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    if (!tab) return

    try {
      await window.wzxclaw.saveFile({ filePath: tab.filePath, content: tab.content })

      // Update diskContent to match current content, mark as clean
      set({
        tabs: get().tabs.map((t) => {
          if (t.id !== tabId) return t
          return { ...t, diskContent: t.content, isDirty: false }
        })
      })
    } catch (err) {
      // Log error but keep dirty state so user can retry (per D-51)
      console.error('Failed to save file:', tab.filePath, err)
    }
  },

  getActiveTab: () => {
    const { tabs, activeTabId } = get()
    return tabs.find((t) => t.id === activeTabId)
  },

  refreshTabContent: (tabId, newContent) => {
    set({
      tabs: get().tabs.map((t) => {
        if (t.id !== tabId) return t
        return {
          ...t,
          content: newContent,
          diskContent: newContent,
          isDirty: false
        }
      })
    })
  },

  /**
   * Open or refresh a tab for the given file path.
   * Used by agent edit auto-refresh (per D-52):
   * - If tab exists: re-read from disk and refresh content
   * - If no tab: read file and open new tab
   */
  openOrRefreshTab: async (filePath: string) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.filePath === filePath)

    try {
      const result = await window.wzxclaw.readFile({ filePath })
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath

      if (existing) {
        // Refresh existing tab with fresh disk content (per D-52)
        get().refreshTabContent(existing.id, result.content)
        set({ activeTabId: existing.id })
      } else {
        // Open new tab with file content
        get().openTab(filePath, fileName, result.content, result.language)
      }
    } catch (err) {
      console.error('Failed to open/refresh tab for:', filePath, err)
    }
  },

  /**
   * Handle file change events from disk (chokidar) or agent tool execution (per D-52).
   * Respects dirty state: will NOT overwrite a tab that has unsaved user edits.
   */
  handleExternalFileChange: async (filePath: string, changeType: string) => {
    const { tabs } = get()

    if (changeType === 'deleted') {
      // Close any open tab for this file
      const existing = tabs.find((t) => t.filePath === filePath)
      if (existing) {
        get().closeTab(existing.id)
      }
      return
    }

    // changeType === 'created' or 'modified'
    const existing = tabs.find((t) => t.filePath === filePath)

    if (existing) {
      // If the tab is dirty (user has unsaved edits), skip refresh to avoid losing work
      if (existing.isDirty) {
        return
      }
      // Re-read file from disk and refresh the tab content
      try {
        const result = await window.wzxclaw.readFile({ filePath })
        get().refreshTabContent(existing.id, result.content)
      } catch (err) {
        console.error('Failed to refresh tab for:', filePath, err)
      }
    }
    // If no tab is open for this file and it's a 'created' event,
    // we don't auto-open — the user or agent will open it explicitly.
    // For 'modified', same — only refresh if already open.
  }
}))
