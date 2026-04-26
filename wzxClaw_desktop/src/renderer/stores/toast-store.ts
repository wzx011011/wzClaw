import { create } from 'zustand'

// ============================================================
// ToastStore — 全局轻提示状态（Phase C）
// 用于替换静默的 catch(() => {})，向用户显示操作结果
// ============================================================

export type ToastType = 'error' | 'success' | 'info'

interface ToastState {
  message: string | null
  type: ToastType
}

interface ToastActions {
  show: (message: string, type?: ToastType) => void
  clear: () => void
}

let _timer: ReturnType<typeof setTimeout> | null = null

export const useToastStore = create<ToastState & ToastActions>()((set) => ({
  message: null,
  type: 'info',

  show: (message, type = 'info') => {
    if (_timer) clearTimeout(_timer)
    set({ message, type })
    _timer = setTimeout(() => {
      set({ message: null })
      _timer = null
    }, 3000)
  },

  clear: () => {
    if (_timer) { clearTimeout(_timer); _timer = null }
    set({ message: null })
  },
}))
