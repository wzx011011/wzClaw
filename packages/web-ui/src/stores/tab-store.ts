// ============================================================
// tab-store — 编辑器标签页管理
//
// 管理打开的文件标签：打开、关闭、激活、保存、脏标记。
// 文件读写通过 DataSource.fs 通道。
// ============================================================

import { create } from 'zustand'

/** 编辑器标签页 */
export interface EditorTab {
  readonly id: string
  readonly filePath: string
  readonly fileName: string
  readonly content: string
  /** 磁盘上的内容（用于脏标记检测） */
  readonly diskContent: string
  readonly isDirty: boolean
  readonly language: string
}

/** 标签状态 */
export interface TabState {
  /** 打开的标签页列表 */
  tabs: EditorTab[]
  /** 当前活跃标签 ID */
  activeTabId: string | null
}

/** 标签操作 */
export interface TabActions {
  /** 打开文件（如果已打开则激活） */
  openFile(filePath: string, content: string): void
  /** 关闭标签页 */
  closeTab(tabId: string): void
  /** 激活标签页 */
  activateTab(tabId: string): void
  /** 更新标签内容（编辑） */
  updateContent(tabId: string, content: string): void
  /** 标记为已保存 */
  markSaved(tabId: string): void
  /** 设置活跃标签 */
  setActiveTab(tabId: string | null): void
}

export type TabStore = TabState & TabActions

/** 从文件路径提取文件名 */
function getFileName(filePath: string): string {
  const parts = filePath.split('/')
  return parts[parts.length - 1] || filePath
}

/** 从文件扩展名推断语言 */
function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const mapping: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    yaml: 'yaml',
    yml: 'yaml',
    toml: 'toml',
    sh: 'shell',
    bash: 'shell',
    sql: 'sql',
    xml: 'xml',
    svg: 'xml',
  }
  return mapping[ext] ?? 'plaintext'
}

/** 生成标签 ID */
let tabCounter = 0
function generateTabId(): string {
  tabCounter++
  return `tab-${tabCounter}`
}

export const useTabStore = create<TabStore>()((set) => ({
  tabs: [],
  activeTabId: null,

  openFile: (filePath, content) =>
    set((s) => {
      // 已打开 → 激活
      const existing = s.tabs.find((t) => t.filePath === filePath)
      if (existing) {
        return {
          tabs: s.tabs.map((t) => ({ ...t, isActive: t.id === existing.id })),
          activeTabId: existing.id,
        }
      }

      // 新标签
      const id = generateTabId()
      const tab: EditorTab = {
        id,
        filePath,
        fileName: getFileName(filePath),
        content,
        diskContent: content,
        isDirty: false,
        language: getLanguage(filePath),
      }
      return {
        tabs: [...s.tabs.map((t) => ({ ...t })), tab],
        activeTabId: id,
      }
    }),

  closeTab: (tabId) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId)
      const tabs = s.tabs.filter((t) => t.id !== tabId)

      let activeTabId = s.activeTabId
      if (activeTabId === tabId) {
        // 激活相邻标签
        if (tabs.length > 0) {
          const newIdx = Math.min(idx, tabs.length - 1)
          activeTabId = tabs[newIdx]!.id
        } else {
          activeTabId = null
        }
      }

      return { tabs, activeTabId }
    }),

  activateTab: (tabId) => set({ activeTabId: tabId }),

  updateContent: (tabId, content) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, content, isDirty: content !== t.diskContent }
          : t,
      ),
    })),

  markSaved: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, isDirty: false, diskContent: t.content }
          : t,
      ),
    })),

  setActiveTab: (tabId) => set({ activeTabId: tabId }),
}))
