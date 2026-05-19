// ============================================================
// hand-store — 在线 Hand 列表管理
//
// 定期获取 /admin/hands，管理选中 Hand，localStorage 持久化。
// ============================================================

import { create } from 'zustand'

const SELECTED_HAND_KEY = 'wzxclaw-selected-hand'

export interface HandInfo {
  id: string
  type: 'desktop' | 'docker'
  capabilities: string[]
  priority: number
  lastHeartbeat: number
}

interface HandState {
  hands: HandInfo[]
  selectedHandId: string | null
  loading: boolean
}

interface HandActions {
  fetchHands: (agentUrl: string, token?: string) => Promise<void>
  selectHand: (id: string | null) => void
  clearSelection: () => void
}

export type HandStore = HandState & HandActions

function restoreSelectedHand(): string | null {
  try {
    return localStorage.getItem(SELECTED_HAND_KEY)
  } catch { return null }
}

export const useHandStore = create<HandStore>((set) => ({
  hands: [],
  selectedHandId: restoreSelectedHand(),
  loading: false,

  fetchHands: async (agentUrl: string, token?: string) => {
    set({ loading: true })
    try {
      const base = agentUrl.replace(/^ws/, 'http').replace(/\/$/, '')
      const headers = token ? { Authorization: `Bearer ${token}` } : undefined
      const res = await fetch(`${base}/admin/hands`, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const hands: HandInfo[] = await res.json()
      set({ hands, loading: false })
    } catch {
      set({ hands: [], loading: false })
    }
  },

  selectHand: (id: string | null) => {
    set({ selectedHandId: id })
    try {
      if (id) {
        localStorage.setItem(SELECTED_HAND_KEY, id)
      } else {
        localStorage.removeItem(SELECTED_HAND_KEY)
      }
    } catch { /* ignore */ }
  },

  clearSelection: () => {
    set({ selectedHandId: null })
    try { localStorage.removeItem(SELECTED_HAND_KEY) } catch { /* ignore */ }
  },
}))
