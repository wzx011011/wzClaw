import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ============================================================
// LayoutStore — 布局状态持久化（localStorage）
// 使用 zustand/persist 跨重启保持侧边栏/面板状态
// ============================================================

export type SidebarPanel = 'explorer' | 'sessions'

interface LayoutState {
  activeSidebarPanel: SidebarPanel
  sidebarVisible: boolean
  rightSidebarVisible: boolean
  rightSidebarTab: 'editor' | 'preview'
  sidebarWidth: number
  rightSidebarWidth: number
  pinnedSessionIds: string[]
}

interface LayoutActions {
  setActiveSidebarPanel: (panel: SidebarPanel) => void
  toggleSidebar: () => void
  setSidebarVisible: (visible: boolean) => void
  toggleRightSidebar: () => void
  setRightSidebarVisible: (visible: boolean) => void
  setRightSidebarTab: (tab: 'editor' | 'preview') => void
  setSidebarWidth: (width: number) => void
  setRightSidebarWidth: (width: number) => void
  pinSession: (sessionId: string) => void
  unpinSession: (sessionId: string) => void
}

export const useLayoutStore = create<LayoutState & LayoutActions>()(
  persist(
    (set, get) => ({
      // --- 默认值 ---
      activeSidebarPanel: 'explorer',
      sidebarVisible: true,
      rightSidebarVisible: false,
      rightSidebarTab: 'editor',
      sidebarWidth: 240,
      rightSidebarWidth: 500,
      pinnedSessionIds: [],

      // --- Actions ---
      setActiveSidebarPanel: (panel) => {
        const { sidebarVisible, activeSidebarPanel } = get()
        if (activeSidebarPanel === panel && sidebarVisible) {
          // 再次点击同一面板 → 切换侧边栏显隐（VS Code 行为）
          set({ sidebarVisible: false })
        } else {
          set({ activeSidebarPanel: panel, sidebarVisible: true })
        }
      },

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setSidebarVisible: (visible) => set({ sidebarVisible: visible }),

      toggleRightSidebar: () => set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
      setRightSidebarVisible: (visible) => set({ rightSidebarVisible: visible }),

      setRightSidebarTab: (tab) => set({ rightSidebarTab: tab, rightSidebarVisible: true }),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),
      setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),

      pinSession: (sessionId) =>
        set((s) => ({
          pinnedSessionIds: s.pinnedSessionIds.includes(sessionId)
            ? s.pinnedSessionIds
            : [...s.pinnedSessionIds, sessionId],
        })),

      unpinSession: (sessionId) =>
        set((s) => ({
          pinnedSessionIds: s.pinnedSessionIds.filter((id) => id !== sessionId),
        })),
    }),
    {
      name: 'wzxclaw-layout',
      partialize: (state) => ({
        activeSidebarPanel: state.activeSidebarPanel,
        sidebarVisible: state.sidebarVisible,
        rightSidebarVisible: state.rightSidebarVisible,
        rightSidebarTab: state.rightSidebarTab,
        sidebarWidth: state.sidebarWidth,
        rightSidebarWidth: state.rightSidebarWidth,
        pinnedSessionIds: state.pinnedSessionIds,
      }),
    }
  )
)
