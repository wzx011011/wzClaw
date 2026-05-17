// ============================================================
// layout-store — IDE 布局状态管理
//
// 管理侧边栏/面板可见性、宽度、活动面板。
// 纯客户端状态，不依赖 IPC。
// ============================================================

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 侧边栏面板类型 */
export type SidebarPanel = 'explorer' | 'sessions' | 'search'

/** 布局状态 */
export interface LayoutState {
  /** 侧边栏是否展开 */
  sidebarVisible: boolean
  /** 当前侧边栏面板 */
  activeSidebarPanel: SidebarPanel
  /** 底部面板（终端）是否展开 */
  bottomPanelVisible: boolean
  /** 底部面板高度（px） */
  bottomPanelHeight: number
  /** 右侧边栏（预览）是否展开 */
  rightSidebarVisible: boolean
  /** 右侧边栏宽度（px） */
  rightSidebarWidth: number
  /** 侧边栏宽度（px） */
  sidebarWidth: number
}

/** 布局操作 */
export interface LayoutActions {
  toggleSidebar(): void
  setActiveSidebarPanel(panel: SidebarPanel): void
  toggleBottomPanel(): void
  setBottomPanelHeight(height: number): void
  toggleRightSidebar(): void
  setRightSidebarWidth(width: number): void
  setSidebarWidth(width: number): void
}

export type LayoutStore = LayoutState & LayoutActions

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      sidebarVisible: true,
      activeSidebarPanel: 'explorer',
      bottomPanelVisible: true,
      bottomPanelHeight: 200,
      rightSidebarVisible: false,
      rightSidebarWidth: 400,
      sidebarWidth: 260,

      toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),
      setActiveSidebarPanel: (panel) => set({ activeSidebarPanel: panel, sidebarVisible: true }),
      toggleBottomPanel: () => set((s) => ({ bottomPanelVisible: !s.bottomPanelVisible })),
      setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
      toggleRightSidebar: () => set((s) => ({ rightSidebarVisible: !s.rightSidebarVisible })),
      setRightSidebarWidth: (width) => set({ rightSidebarWidth: width }),
      setSidebarWidth: (width) => set({ sidebarWidth: width }),
    }),
    {
      name: 'wzxclaw-layout',
      partialize: (state) => ({
        sidebarVisible: state.sidebarVisible,
        activeSidebarPanel: state.activeSidebarPanel,
        bottomPanelVisible: state.bottomPanelVisible,
        bottomPanelHeight: state.bottomPanelHeight,
        rightSidebarVisible: state.rightSidebarVisible,
        rightSidebarWidth: state.rightSidebarWidth,
        sidebarWidth: state.sidebarWidth,
      }),
    },
  ),
)
