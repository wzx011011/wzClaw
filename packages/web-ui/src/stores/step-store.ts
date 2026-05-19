// ============================================================
// step-store — 计划模式步骤面板状态
//
// Agent 在 plan 模式下返回结构化步骤列表，StepPanel 从此 store 读取。
// ============================================================

import { create } from 'zustand'

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface Step {
  id: string
  /** 步骤序号（显示用，1-based） */
  index: number
  title: string
  description?: string
  status: StepStatus
  /** tool call id（可选，关联到具体工具调用） */
  toolCallId?: string
  startedAt?: number
  completedAt?: number
}

interface StepState {
  steps: Step[]
  /** 当前会话 ID（步骤属于哪个会话） */
  sessionId: string | null
  /** 面板是否展开 */
  visible: boolean
}

interface StepActions {
  setSteps: (sessionId: string, steps: Omit<Step, 'status'>[]) => void
  updateStep: (id: string, patch: Partial<Pick<Step, 'status' | 'startedAt' | 'completedAt'>>) => void
  markRunning: (id: string) => void
  markCompleted: (id: string) => void
  markFailed: (id: string) => void
  clear: () => void
  show: () => void
  hide: () => void
  toggle: () => void
}

export type StepStore = StepState & StepActions

export const useStepStore = create<StepStore>((set) => ({
  steps: [],
  sessionId: null,
  visible: false,

  setSteps: (sessionId, steps) => {
    set({
      sessionId,
      steps: steps.map((s, i) => ({ ...s, index: i + 1, status: 'pending' })),
      visible: true,
    })
  },

  updateStep: (id, patch) => {
    set((s) => ({
      steps: s.steps.map((step) => step.id === id ? { ...step, ...patch } : step),
    }))
  },

  markRunning: (id) => set((s) => ({
    steps: s.steps.map((step) => step.id === id ? { ...step, status: 'running', startedAt: Date.now() } : step),
  })),

  markCompleted: (id) => set((s) => ({
    steps: s.steps.map((step) => step.id === id ? { ...step, status: 'completed', completedAt: Date.now() } : step),
  })),

  markFailed: (id) => set((s) => ({
    steps: s.steps.map((step) => step.id === id ? { ...step, status: 'failed', completedAt: Date.now() } : step),
  })),

  clear: () => set({ steps: [], sessionId: null }),
  show: () => set({ visible: true }),
  hide: () => set({ visible: false }),
  toggle: () => set((s) => ({ visible: !s.visible })),
}))
