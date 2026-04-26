import { create } from 'zustand'
import type { AgentStep } from '../../shared/types'

// ============================================================
// Step Store — state management for step panel
// (per TASK-01 through TASK-05)
// ============================================================

interface StepState {
  steps: AgentStep[]
  panelVisible: boolean
}

interface StepActions {
  init: () => () => void
  togglePanel: () => void
  showPanel: () => void
  loadSteps: () => Promise<void>
  setSteps: (steps: AgentStep[]) => void
}

type StepStore = StepState & StepActions

export const useStepStore = create<StepStore>((set, get) => ({
  steps: [],
  panelVisible: false,

  init: () => {
    // Subscribe to real-time step events from main process
    const unsubCreated = window.wzxclaw.onStepCreated((step) => {
      const { steps } = get()
      // Avoid duplicates
      if (!steps.find((t) => t.id === step.id)) {
        set({ steps: [...steps, step] })
      }
    })

    const unsubUpdated = window.wzxclaw.onStepUpdated((step) => {
      const { steps } = get()
      set({
        steps: steps.map((t) => (t.id === step.id ? step : t))
      })
    })

    // 步骤面板默认隐藏 — 延迟 200ms 加载初始数据，让首帧 IPC 优先处理会话恢复
    const loadTimer = setTimeout(() => get().loadSteps(), 200)

    return () => {
      clearTimeout(loadTimer)
      unsubCreated()
      unsubUpdated()
    }
  },

  togglePanel: () => {
    set((s) => ({ panelVisible: !s.panelVisible }))
  },

  showPanel: () => {
    set({ panelVisible: true })
  },

  loadSteps: async () => {
    try {
      const steps = await window.wzxclaw.listSteps()
      set({ steps })
    } catch {
      // Silently fail -- steps will sync via IPC events
    }
  },

  setSteps: (steps) => {
    set({ steps })
  }
}))

// ============================================================
// Computed helpers
// ============================================================

export function getStepCompletedCount(steps: AgentStep[]): number {
  return steps.filter((t) => t.status === 'completed').length
}

export function getStepActiveCount(steps: AgentStep[]): number {
  return steps.filter((t) => t.status !== 'completed').length
}
