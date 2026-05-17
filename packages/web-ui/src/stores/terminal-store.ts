// ============================================================
// terminal-store — 终端实例管理
//
// 管理终端标签页的创建、切换、关闭。
// 终端数据流由 TerminalChannel 处理，store 只管标签状态。
// ============================================================

import { create } from 'zustand'

/** 终端实例 */
export interface TerminalInstance {
  readonly id: string
  readonly title: string
  readonly isActive: boolean
}

/** 终端状态 */
export interface TerminalState {
  /** 终端实例列表 */
  terminals: TerminalInstance[]
  /** 当前活跃终端 ID */
  activeTerminalId: string | null
  /** 面板是否可见 */
  panelVisible: boolean
}

/** 终端操作 */
export interface TerminalActions {
  /** 创建终端实例（由 TerminalPanel 调用后填入） */
  addTerminal(id: string, title: string): void
  /** 切换到指定终端 */
  setActiveTerminal(id: string): void
  /** 关闭终端 */
  removeTerminal(id: string): void
  /** 切换面板可见性 */
  togglePanel(): void
  /** 设置面板可见性 */
  setPanelVisible(visible: boolean): void
}

export type TerminalStore = TerminalState & TerminalActions

let terminalCounter = 0

export const useTerminalStore = create<TerminalStore>()((set) => ({
  terminals: [],
  activeTerminalId: null,
  panelVisible: true,

  addTerminal: (id, title) =>
    set((s) => {
      const terminals = s.terminals.map((t) => ({ ...t, isActive: false }))
      terminals.push({ id, title, isActive: true })
      return { terminals, activeTerminalId: id }
    }),

  setActiveTerminal: (id) =>
    set((s) => ({
      terminals: s.terminals.map((t) => ({ ...t, isActive: t.id === id })),
      activeTerminalId: id,
    })),

  removeTerminal: (id) =>
    set((s) => {
      const terminals = s.terminals.filter((t) => t.id !== id)
      const activeTerminalId =
        s.activeTerminalId === id
          ? (terminals[terminals.length - 1]?.id ?? null)
          : s.activeTerminalId
      return { terminals, activeTerminalId }
    }),

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),

  setPanelVisible: (visible) => set({ panelVisible: visible }),
}))

/** 生成终端 ID */
export function generateTerminalId(): string {
  terminalCounter++
  return `term-${Date.now()}-${terminalCounter}`
}
