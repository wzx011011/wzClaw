// ============================================================
// notification-store — 持久化系统通知列表
//
// 与 toast-store 区别：notification 不自动消失，留在通知中心。
// 使用场景：权限请求、后台任务完成、错误报告等。
// ============================================================

import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface Notification {
  id: string
  title: string
  body?: string
  level: NotificationLevel
  createdAt: number
  read: boolean
  /** 可选：点击通知执行的动作 key（由消费方处理） */
  action?: string
  actionPayload?: unknown
}

interface NotificationState {
  notifications: Notification[]
  /** 未读数 */
  unreadCount: number
}

interface NotificationActions {
  push: (n: Omit<Notification, 'id' | 'createdAt' | 'read'>) => string
  markRead: (id: string) => void
  markAllRead: () => void
  remove: (id: string) => void
  clear: () => void
}

export type NotificationStore = NotificationState & NotificationActions

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,

  push: (n) => {
    const id = uuidv4()
    const notification: Notification = { ...n, id, createdAt: Date.now(), read: false }
    set((s) => ({
      notifications: [notification, ...s.notifications].slice(0, 200),
      unreadCount: s.unreadCount + 1,
    }))
    return id
  },

  markRead: (id) => {
    set((s) => {
      const updated = s.notifications.map((n) => n.id === id ? { ...n, read: true } : n)
      return { notifications: updated, unreadCount: updated.filter((n) => !n.read).length }
    })
  },

  markAllRead: () => {
    set((s) => ({
      notifications: s.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }))
  },

  remove: (id) => {
    const wasUnread = get().notifications.find((n) => n.id === id && !n.read)
    set((s) => ({
      notifications: s.notifications.filter((n) => n.id !== id),
      unreadCount: Math.max(0, s.unreadCount - (wasUnread ? 1 : 0)),
    }))
  },

  clear: () => set({ notifications: [], unreadCount: 0 }),
}))
