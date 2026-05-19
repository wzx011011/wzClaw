// ============================================================
// toast-store — 轻量级 Toast 通知系统
//
// 用法：useToastStore.getState().show('保存成功', 'success')
// 消息默认 3s 后自动消失；error 类型 5s。
// ============================================================

import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'

export type ToastType = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  message: string
  type: ToastType
  /** 显示时间（ms）0 = 永久，直到手动 dismiss */
  duration: number
}

interface ToastState {
  toasts: Toast[]
}

interface ToastActions {
  /** 显示一条 toast */
  show: (message: string, type?: ToastType, duration?: number) => string
  /** 手动关闭指定 toast */
  dismiss: (id: string) => void
  /** 清空所有 */
  clear: () => void
}

export type ToastStore = ToastState & ToastActions

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  show: (message, type = 'info', duration) => {
    const id = uuidv4()
    const ms = duration ?? (type === 'error' ? 5000 : 3000)
    set((s) => ({ toasts: [...s.toasts, { id, message, type, duration: ms }] }))

    if (ms > 0) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, ms)
    }

    return id
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  clear: () => set({ toasts: [] }),
}))
