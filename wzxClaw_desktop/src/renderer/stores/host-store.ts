// ============================================================
// Host Store — 主机管理前端状态（Zustand）
// ============================================================

import { create } from 'zustand'
import type { Host, HostMonitorData, DockerContainer, SftpEntry } from '../../shared/types'

interface HostStoreState {
  hosts: Host[]
  activeHostId: string | null
  viewingHostId: string | null
  monitorData: Record<string, HostMonitorData>
  dockerContainers: Record<string, DockerContainer[]>
  sftpEntries: Record<string, SftpEntry[]>   // key = hostId:path
  isLoading: boolean
  isConnecting: boolean
  error: string | null
}

interface HostStoreActions {
  // CRUD
  loadHosts: () => Promise<void>
  createHost: (params: Record<string, unknown>) => Promise<Host>
  updateHost: (hostId: string, updates: Record<string, unknown>) => Promise<void>
  deleteHost: (hostId: string) => Promise<void>
  // 连接
  testConnection: (hostId: string) => Promise<{ success: boolean; error?: string; info?: { os: string; hostname: string } }>
  // 导航
  openHostDetail: (hostId: string) => void
  closeHostDetail: () => void
  setActiveHost: (hostId: string | null) => void
  // 监控
  fetchMonitor: (hostId: string) => Promise<void>
  // SFTP
  fetchDir: (hostId: string, path: string) => Promise<void>
  // Docker
  fetchContainers: (hostId: string) => Promise<void>
  dockerAction: (hostId: string, containerId: string, action: 'start' | 'stop' | 'restart' | 'remove') => Promise<void>
  fetchContainerLogs: (hostId: string, containerId: string, tail?: number) => Promise<string>
  // 通用
  clearError: () => void
}

type HostStore = HostStoreState & HostStoreActions

export const useHostStore = create<HostStore>((set, get) => ({
  hosts: [],
  activeHostId: null,
  viewingHostId: null,
  monitorData: {},
  dockerContainers: {},
  sftpEntries: {},
  isLoading: false,
  isConnecting: false,
  error: null,

  // ── CRUD ──

  loadHosts: async () => {
    set({ isLoading: true, error: null })
    try {
      const hosts = await window.wzxclaw.listHosts()
      set({ hosts, isLoading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
    }
  },

  createHost: async (params) => {
    set({ isLoading: true, error: null })
    try {
      const host = await window.wzxclaw.createHost(params)
      set(state => ({ hosts: [...state.hosts, host], isLoading: false }))
      return host
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), isLoading: false })
      throw err
    }
  },

  updateHost: async (hostId, updates) => {
    set({ error: null })
    try {
      const updated = await window.wzxclaw.updateHost({ hostId, updates })
      set(state => ({
        hosts: state.hosts.map(h => h.id === hostId ? updated : h),
        isLoading: false
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteHost: async (hostId) => {
    set({ error: null })
    try {
      await window.wzxclaw.deleteHost({ hostId })
      set(state => ({
        hosts: state.hosts.filter(h => h.id !== hostId),
        viewingHostId: state.viewingHostId === hostId ? null : state.viewingHostId,
        activeHostId: state.activeHostId === hostId ? null : state.activeHostId
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  // ── 连接测试 ──

  testConnection: async (hostId) => {
    set({ isConnecting: true, error: null })
    try {
      const result = await window.wzxclaw.testHostConnection({ hostId })
      // 更新 host 状态
      if (result.success) {
        set(state => ({
          hosts: state.hosts.map(h =>
            h.id === hostId ? { ...h, status: 'online' as const, lastConnectedAt: Date.now() } : h
          )
        }))
      } else {
        set(state => ({
          hosts: state.hosts.map(h =>
            h.id === hostId ? { ...h, status: 'offline' as const } : h
          )
        }))
      }
      set({ isConnecting: false })
      return result
    } catch (err) {
      set({ isConnecting: false, error: err instanceof Error ? err.message : String(err) })
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  // ── 导航 ──

  openHostDetail: (hostId) => set({ viewingHostId: hostId }),
  closeHostDetail: () => set({ viewingHostId: null }),
  setActiveHost: (hostId) => set({ activeHostId: hostId }),

  // ── 监控 ──

  fetchMonitor: async (hostId) => {
    try {
      const data = await window.wzxclaw.getHostMonitor({ hostId })
      set(state => ({ monitorData: { ...state.monitorData, [hostId]: data } }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  // ── SFTP ──

  fetchDir: async (hostId, dirPath) => {
    try {
      const entries = await window.wzxclaw.listHostDir({ hostId, path: dirPath })
      set(state => ({
        sftpEntries: { ...state.sftpEntries, [`${hostId}:${dirPath}`]: entries }
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  // ── Docker ──

  fetchContainers: async (hostId) => {
    try {
      const containers = await window.wzxclaw.listHostDocker({ hostId })
      set(state => ({
        dockerContainers: { ...state.dockerContainers, [hostId]: containers }
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  dockerAction: async (hostId, containerId, action) => {
    set({ error: null })
    try {
      await window.wzxclaw.hostDockerAction({ hostId, containerId, action })
      // 刷新容器列表
      await get().fetchContainers(hostId)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  fetchContainerLogs: async (hostId, containerId, tail) => {
    try {
      const result = await window.wzxclaw.getHostDockerLogs({ hostId, containerId, tail })
      return result.logs
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
      return ''
    }
  },

  clearError: () => set({ error: null })
}))
