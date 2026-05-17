// ============================================================
// file-browser-store — 文件浏览状态管理
//
// 管理当前路径、文件列表、历史导航、收藏夹。
// 通过工厂注入 DataSource.fs 通道。
// ============================================================

import { create } from 'zustand'
import type { FileTreeNode } from '../data-source/types'
import type { FsChannel } from '../data-source/types'

const FAVORITES_KEY = 'wzxclaw-file-favorites'

interface FileBrowserState {
  currentPath: string
  items: FileTreeNode[]
  loading: boolean
  error: string | null
  history: string[]
  favorites: string[]
}

interface FileBrowserActions {
  navigate: (path: string) => Promise<void>
  goBack: () => Promise<void>
  toggleFavorite: (path: string) => void
  isFavorite: (path: string) => boolean
}

export type FileBrowserStore = FileBrowserState & FileBrowserActions

export function createFileBrowserStore(fs: FsChannel | undefined) {
  const savedFavorites: string[] = (() => {
    try {
      return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]')
    } catch { return [] }
  })()

  return create<FileBrowserStore>((set, get) => ({
    currentPath: '/data',
    items: [],
    loading: false,
    error: null,
    history: [],
    favorites: savedFavorites,

    navigate: async (path: string) => {
      if (!fs) {
        set({ error: '文件浏览需要 Hand 连接' })
        return
      }
      const prevPath = get().currentPath
      set({ loading: true, error: null })
      try {
        const items = await fs.tree(path, 1)
        set({
          currentPath: path,
          items,
          loading: false,
          history: [...get().history, prevPath],
        })
      } catch (err: any) {
        const msg = err?.message || String(err)
        const isOffline = msg.includes('Hand') || msg.includes('connect') || msg.includes('ECONNREFUSED')
        set({
          loading: false,
          error: isOffline ? 'Hand 离线，无法浏览文件' : msg,
        })
      }
    },

    goBack: async () => {
      const { history } = get()
      if (history.length === 0) return
      const prevPath = history[history.length - 1]!
      set({ history: history.slice(0, -1) })
      if (!fs) return
      set({ loading: true, error: null })
      try {
        const items = await fs.tree(prevPath, 1)
        set({ currentPath: prevPath, items, loading: false })
      } catch (err: any) {
        set({ loading: false, error: err?.message || String(err) })
      }
    },

    toggleFavorite: (path: string) => {
      const { favorites } = get()
      const next = favorites.includes(path)
        ? favorites.filter((f) => f !== path)
        : [...favorites, path]
      set({ favorites: next })
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next))
    },

    isFavorite: (path: string) => get().favorites.includes(path),
  }))
}
