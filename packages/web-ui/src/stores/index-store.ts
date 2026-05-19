// ============================================================
// index-store — 代码索引状态管理
//
// Agent 执行语义搜索/符号导航时依赖索引。
// 此 store 追踪索引的构建进度与状态。
// ============================================================

import { create } from 'zustand'

export type IndexStatus = 'idle' | 'indexing' | 'ready' | 'error'

export interface IndexProgress {
  total: number
  indexed: number
  currentFile?: string
}

interface IndexState {
  status: IndexStatus
  progress: IndexProgress | null
  errorMessage: string | null
  /** 最近一次成功完成索引的时间戳 */
  lastIndexedAt: number | null
  /** 当前索引的工作目录 */
  workspaceDir: string | null
}

interface IndexActions {
  startIndexing: (workspaceDir: string) => void
  updateProgress: (progress: IndexProgress) => void
  setReady: () => void
  setError: (message: string) => void
  reset: () => void
}

export type IndexStore = IndexState & IndexActions

export const useIndexStore = create<IndexStore>((set) => ({
  status: 'idle',
  progress: null,
  errorMessage: null,
  lastIndexedAt: null,
  workspaceDir: null,

  startIndexing: (workspaceDir) => set({
    status: 'indexing',
    progress: { total: 0, indexed: 0 },
    errorMessage: null,
    workspaceDir,
  }),

  updateProgress: (progress) => set({ progress }),

  setReady: () => set((s) => ({
    status: 'ready',
    progress: null,
    lastIndexedAt: Date.now(),
    workspaceDir: s.workspaceDir,
  })),

  setError: (message) => set({ status: 'error', errorMessage: message, progress: null }),

  reset: () => set({ status: 'idle', progress: null, errorMessage: null }),
}))
