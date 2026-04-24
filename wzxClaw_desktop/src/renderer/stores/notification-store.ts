import { create } from 'zustand'

export type NotificationType = 'info' | 'success' | 'warning' | 'error'

export interface Notification {
  id: string
  type: NotificationType
  message: string
  timestamp: number
  /** Auto-dismiss duration in ms. 0 = no auto-dismiss */
  duration: number
}

interface NotificationState {
  notifications: Notification[]
}

interface NotificationActions {
  add: (type: NotificationType, message: string, duration?: number) => void
  dismiss: (id: string) => void
  clear: () => void
}

let nextId = 0

export const useNotificationStore = create<NotificationState & NotificationActions>((set) => ({
  notifications: [],

  add: (type, message, duration = 4000) => {
    const id = `notif-${++nextId}`
    const notification: Notification = {
      id,
      type,
      message,
      timestamp: Date.now(),
      duration
    }
    set((s) => ({ notifications: [...s.notifications, notification] }))

    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }))
      }, duration)
    }
  },

  dismiss: (id) => {
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) }))
  },

  clear: () => set({ notifications: [] })
}))
