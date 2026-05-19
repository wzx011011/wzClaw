// ============================================================
// command-store — 命令面板注册表
//
// 使用方式：
//   CommandRegistry.register({ id, title, category, handler, shortcut? })
//   useCommandStore.getState().open()   — 打开命令面板
//   useCommandStore.getState().execute(id) — 执行命令
// ============================================================

import { create } from 'zustand'

export interface Command {
  /** 唯一 ID，如 'file.newSession' */
  id: string
  /** 显示名称 */
  title: string
  /** 分组（用于命令面板分类显示） */
  category?: string
  /** 快捷键描述字符串（仅显示用，不注册实际快捷键） */
  shortcut?: string
  /** 执行函数 */
  handler: () => void | Promise<void>
  /** 是否禁用（可选，动态控制） */
  disabled?: boolean
  /** 图标 SVG 字符串（可选） */
  icon?: string
}

interface CommandState {
  commands: Map<string, Command>
  /** 命令面板是否打开 */
  open: boolean
  /** 面板搜索词 */
  query: string
}

interface CommandActions {
  /** 注册命令（已有 id 则覆盖） */
  register: (cmd: Command) => void
  /** 批量注册 */
  registerAll: (cmds: Command[]) => void
  /** 注销 */
  unregister: (id: string) => void
  /** 执行命令 */
  execute: (id: string) => Promise<void>
  /** 打开命令面板 */
  openPalette: () => void
  /** 关闭命令面板 */
  closePalette: () => void
  /** 设置搜索词 */
  setQuery: (q: string) => void
  /** 过滤后的命令列表（按 query 过滤） */
  filteredCommands: () => Command[]
}

export type CommandStore = CommandState & CommandActions

export const useCommandStore = create<CommandStore>((set, get) => ({
  commands: new Map(),
  open: false,
  query: '',

  register: (cmd) => {
    set((s) => {
      const next = new Map(s.commands)
      next.set(cmd.id, cmd)
      return { commands: next }
    })
  },

  registerAll: (cmds) => {
    set((s) => {
      const next = new Map(s.commands)
      for (const cmd of cmds) next.set(cmd.id, cmd)
      return { commands: next }
    })
  },

  unregister: (id) => {
    set((s) => {
      const next = new Map(s.commands)
      next.delete(id)
      return { commands: next }
    })
  },

  execute: async (id) => {
    const cmd = get().commands.get(id)
    if (!cmd || cmd.disabled) return
    get().closePalette()
    await cmd.handler()
  },

  openPalette: () => set({ open: true, query: '' }),
  closePalette: () => set({ open: false }),
  setQuery: (q) => set({ query: q }),

  filteredCommands: () => {
    const { commands, query } = get()
    const all = Array.from(commands.values()).filter((c) => !c.disabled)
    if (!query.trim()) return all
    const lower = query.toLowerCase()
    return all.filter(
      (c) => c.title.toLowerCase().includes(lower) || c.id.toLowerCase().includes(lower) || (c.category?.toLowerCase().includes(lower) ?? false)
    )
  },
}))
