import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { EditorTab } from '../../shared/types'

// ============================================================
// Tab Store (per D-49, D-50)
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

    await window.wzxclaw.saveFile({ filePath: tab.filePath, content: tab.content })

    // Update diskContent to match current content, mark as clean
    set({
      tabs: get().tabs.map((t) => {
        if (t.id !== tabId) return t
        return { ...t, diskContent: t.content, isDirty: false }
      })
    })
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
  }
}))
