import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useStepStore, getStepCompletedCount, getStepActiveCount } from '../step-store'
import type { AgentStep } from '../../../shared/types'

// Helper to get the mocked wzxclaw IPC object
function getWzxclaw(): Record<string, ReturnType<typeof vi.fn>> {
  return (globalThis as unknown as { window: { wzxclaw: Record<string, ReturnType<typeof vi.fn>> } }).window.wzxclaw
}

function makeStep(overrides: Partial<AgentStep> & { id: string }): AgentStep {
  return {
    subject: 'Test step',
    description: 'A step for testing',
    status: 'pending',
    blockedBy: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

describe('StepStore', () => {
  const mockWzxclaw = {
    listSteps: vi.fn().mockResolvedValue([]),
    onStepCreated: vi.fn().mockReturnValue(vi.fn()),
    onStepUpdated: vi.fn().mockReturnValue(vi.fn())
  }

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>).window = { wzxclaw: { ...mockWzxclaw } }

    useStepStore.setState({
      steps: [],
      panelVisible: false
    })

    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ============================================================
  // Pure helper tests
  // ============================================================

  describe('getStepCompletedCount', () => {
    it('returns correct count of completed steps', () => {
      const steps: AgentStep[] = [
        makeStep({ id: 's1', status: 'completed' }),
        makeStep({ id: 's2', status: 'in_progress' }),
        makeStep({ id: 's3', status: 'completed' }),
        makeStep({ id: 's4', status: 'pending' }),
        makeStep({ id: 's5', status: 'completed' })
      ]

      expect(getStepCompletedCount(steps)).toBe(3)
    })

    it('returns 0 for empty array', () => {
      expect(getStepCompletedCount([])).toBe(0)
    })

    it('returns 0 when no steps are completed', () => {
      const steps: AgentStep[] = [
        makeStep({ id: 's1', status: 'pending' }),
        makeStep({ id: 's2', status: 'in_progress' }),
        makeStep({ id: 's3', status: 'blocked' })
      ]

      expect(getStepCompletedCount(steps)).toBe(0)
    })
  })

  describe('getStepActiveCount', () => {
    it('returns correct count of non-completed steps', () => {
      const steps: AgentStep[] = [
        makeStep({ id: 's1', status: 'completed' }),
        makeStep({ id: 's2', status: 'in_progress' }),
        makeStep({ id: 's3', status: 'completed' }),
        makeStep({ id: 's4', status: 'pending' }),
        makeStep({ id: 's5', status: 'blocked' })
      ]

      // s2, s4, s5 are not completed
      expect(getStepActiveCount(steps)).toBe(3)
    })

    it('returns 0 for empty array', () => {
      expect(getStepActiveCount([])).toBe(0)
    })

    it('returns 0 when all steps are completed', () => {
      const steps: AgentStep[] = [
        makeStep({ id: 's1', status: 'completed' }),
        makeStep({ id: 's2', status: 'completed' })
      ]

      expect(getStepActiveCount(steps)).toBe(0)
    })
  })

  // ============================================================
  // Store action tests
  // ============================================================

  describe('setSteps', () => {
    it('replaces all steps', () => {
      useStepStore.setState({
        steps: [makeStep({ id: 'old-1', status: 'pending' })]
      })

      const newSteps: AgentStep[] = [
        makeStep({ id: 'new-1', status: 'in_progress' }),
        makeStep({ id: 'new-2', status: 'completed' })
      ]

      const { setSteps } = useStepStore.getState()
      setSteps(newSteps)

      const state = useStepStore.getState()
      expect(state.steps).toEqual(newSteps)
      expect(state.steps).toHaveLength(2)
    })
  })

  describe('togglePanel', () => {
    it('toggles panelVisible from false to true', () => {
      useStepStore.setState({ panelVisible: false })

      const { togglePanel } = useStepStore.getState()
      togglePanel()

      expect(useStepStore.getState().panelVisible).toBe(true)
    })

    it('toggles panelVisible from true to false', () => {
      useStepStore.setState({ panelVisible: true })

      const { togglePanel } = useStepStore.getState()
      togglePanel()

      expect(useStepStore.getState().panelVisible).toBe(false)
    })
  })

  describe('showPanel', () => {
    it('sets panelVisible to true', () => {
      useStepStore.setState({ panelVisible: false })

      const { showPanel } = useStepStore.getState()
      showPanel()

      expect(useStepStore.getState().panelVisible).toBe(true)
    })

    it('keeps panelVisible true if already true', () => {
      useStepStore.setState({ panelVisible: true })

      const { showPanel } = useStepStore.getState()
      showPanel()

      expect(useStepStore.getState().panelVisible).toBe(true)
    })
  })

  describe('loadSteps', () => {
    it('calls window.wzxclaw.listSteps() and updates steps', async () => {
      const remoteSteps: AgentStep[] = [
        makeStep({ id: 'remote-1', status: 'completed' }),
        makeStep({ id: 'remote-2', status: 'in_progress' })
      ]
      getWzxclaw().listSteps.mockResolvedValueOnce(remoteSteps)

      const { loadSteps } = useStepStore.getState()
      await loadSteps()

      expect(getWzxclaw().listSteps).toHaveBeenCalledOnce()
      const state = useStepStore.getState()
      expect(state.steps).toEqual(remoteSteps)
    })

    it('swallows errors silently', async () => {
      getWzxclaw().listSteps.mockRejectedValueOnce(new Error('IPC fail'))
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { loadSteps } = useStepStore.getState()
      // Should not throw
      await expect(loadSteps()).resolves.toBeUndefined()

      // Steps remain unchanged (empty)
      expect(useStepStore.getState().steps).toEqual([])

      consoleSpy.mockRestore()
    })
  })
})
