// ============================================================
// diff-store — 文件差异预览状态
//
// 当 Agent 执行 file_edit 操作时，把待应用的差异推入此 store，
// DiffPreview 组件从这里读取并渲染对比视图。
// ============================================================

import { create } from 'zustand'

export interface FileDiff {
  /** 文件路径 */
  path: string
  /** 原始内容 */
  originalContent: string
  /** 修改后内容 */
  modifiedContent: string
  /** 关联的 tool call ID */
  toolCallId?: string
  /** 差异状态 */
  status: 'pending' | 'applied' | 'rejected'
}

interface DiffState {
  /** 当前展示的差异列表 */
  diffs: FileDiff[]
  /** 当前选中预览的文件 diff index */
  activeIndex: number
}

interface DiffActions {
  /** 推入一个新差异（agent 生成时调用） */
  push: (diff: Omit<FileDiff, 'status'>) => void
  /** 标记 diff 为已应用 */
  markApplied: (toolCallId: string) => void
  /** 标记 diff 为已拒绝 */
  markRejected: (toolCallId: string) => void
  /** 切换选中的 diff */
  setActiveIndex: (index: number) => void
  /** 清理已完成（applied / rejected）的 diff */
  cleanup: () => void
  /** 清空所有 */
  clear: () => void
}

export type DiffStore = DiffState & DiffActions

export const useDiffStore = create<DiffStore>((set, get) => ({
  diffs: [],
  activeIndex: 0,

  push: (diff) => {
    set((s) => ({
      diffs: [...s.diffs, { ...diff, status: 'pending' }],
      activeIndex: s.diffs.length,
    }))
  },

  markApplied: (toolCallId) => {
    set((s) => ({
      diffs: s.diffs.map((d) => d.toolCallId === toolCallId ? { ...d, status: 'applied' } : d),
    }))
  },

  markRejected: (toolCallId) => {
    set((s) => ({
      diffs: s.diffs.map((d) => d.toolCallId === toolCallId ? { ...d, status: 'rejected' } : d),
    }))
  },

  setActiveIndex: (index) => set({ activeIndex: index }),

  cleanup: () => {
    const { diffs, activeIndex } = get()
    const pending = diffs.filter((d) => d.status === 'pending')
    set({ diffs: pending, activeIndex: Math.min(activeIndex, Math.max(0, pending.length - 1)) })
  },

  clear: () => set({ diffs: [], activeIndex: 0 }),
}))
