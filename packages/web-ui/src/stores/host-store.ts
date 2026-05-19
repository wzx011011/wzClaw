// ============================================================
// host-store — 远程 Host 配置管理
//
// Host 是用户配置的远程机器入口（NAS、服务器等）。
// 与 hand-store（运行时已注册的 Hand）区别：
//   - host = 配置项（静态，用户定义）
//   - hand = 运行时连接实体（动态，心跳检测）
// ============================================================

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { v4 as uuidv4 } from 'uuid'

export type HostType = 'nas' | 'server' | 'docker' | 'custom'
export type HostStatus = 'unknown' | 'online' | 'offline' | 'error'

export interface Host {
  id: string
  name: string
  type: HostType
  /** WebSocket agent-server 地址 */
  agentUrl: string
  /** 认证 Token（可选） */
  token?: string
  /** 是否默认 */
  isDefault: boolean
  /** 创建时间 */
  createdAt: number
  /** 最近连接时间 */
  lastConnectedAt?: number
  /** 运行时状态（不持久化，启动时重置为 unknown） */
  status: HostStatus
  /** 状态消息 */
  statusMessage?: string
}

export type HostDraft = Omit<Host, 'id' | 'createdAt' | 'status' | 'isDefault'>

interface HostState {
  hosts: Host[]
}

interface HostActions {
  addHost: (draft: HostDraft) => string
  updateHost: (id: string, patch: Partial<HostDraft>) => void
  removeHost: (id: string) => void
  setDefault: (id: string) => void
  setStatus: (id: string, status: HostStatus, message?: string) => void
  getDefaultHost: () => Host | undefined
}

export type HostStore = HostState & HostActions

export const useHostStore = create<HostStore>()(
  persist(
    (set, get) => ({
      hosts: [],

      addHost: (draft) => {
        const id = uuidv4()
        const host: Host = {
          ...draft,
          id,
          createdAt: Date.now(),
          isDefault: get().hosts.length === 0, // 第一个自动设为默认
          status: 'unknown',
        }
        set((s) => ({ hosts: [...s.hosts, host] }))
        return id
      },

      updateHost: (id, patch) => {
        set((s) => ({
          hosts: s.hosts.map((h) => h.id === id ? { ...h, ...patch } : h),
        }))
      },

      removeHost: (id) => {
        set((s) => {
          const remaining = s.hosts.filter((h) => h.id !== id)
          // 如果删除的是默认 host，将第一个设为默认
          if (remaining.length > 0 && !remaining.some((h) => h.isDefault)) {
            remaining[0] = { ...remaining[0]!, isDefault: true }
          }
          return { hosts: remaining }
        })
      },

      setDefault: (id) => {
        set((s) => ({
          hosts: s.hosts.map((h) => ({ ...h, isDefault: h.id === id })),
        }))
      },

      setStatus: (id, status, message) => {
        set((s) => ({
          hosts: s.hosts.map((h) => h.id === id ? { ...h, status, statusMessage: message } : h),
        }))
      },

      getDefaultHost: () => get().hosts.find((h) => h.isDefault),
    }),
    {
      name: 'wzxclaw-hosts',
      // 仅持久化配置字段，status 不存储
      partialize: (state) => ({
        hosts: state.hosts.map(({ status: _s, statusMessage: _m, ...rest }) => rest),
      }),
      // 从持久化恢复时把 status 重置为 unknown
      merge: (persisted: unknown, current) => {
        const p = persisted as Partial<HostState>
        return {
          ...current,
          hosts: (p.hosts ?? []).map((h) => {
            const host = h as unknown as Host
            return { ...host, status: 'unknown' as HostStatus }
          }),
        }
      },
    },
  ),
)
