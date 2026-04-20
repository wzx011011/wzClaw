import { describe, it, expect, beforeEach } from 'vitest'
import { StepManager } from '../step-manager'
import type { StepEvent } from '../step-manager'

describe('StepManager', () => {
  let tm: StepManager

  beforeEach(() => {
    tm = new StepManager()
  })

  describe('createStep', () => {
    it('returns a step with correct fields', () => {
      const step = tm.createStep('Test subject', 'Test description')
      expect(step.id).toBe('step-1')
      expect(step.subject).toBe('Test subject')
      expect(step.description).toBe('Test description')
      expect(step.status).toBe('pending')
      expect(step.blockedBy).toEqual([])
      expect(step.createdAt).toBeGreaterThan(0)
      expect(step.updatedAt).toBeGreaterThan(0)
    })

    it('increments step IDs', () => {
      const t1 = tm.createStep('First')
      const t2 = tm.createStep('Second')
      expect(t1.id).toBe('step-1')
      expect(t2.id).toBe('step-2')
    })

    it('sets status to blocked when blockedBy references non-completed step', () => {
      const t1 = tm.createStep('Blocker', 'Must complete first')
      const t2 = tm.createStep('Dependent', 'Depends on blocker', [t1.id])
      expect(t2.status).toBe('blocked')
    })

    it('sets status to pending when blockedBy references completed step', () => {
      const t1 = tm.createStep('Blocker', 'Already done')
      tm.updateStep(t1.id, { status: 'completed' })
      const t2 = tm.createStep('Dependent', 'Blocker done', [t1.id])
      expect(t2.status).toBe('pending')
    })

    it('sets status to blocked when blockedBy references unknown step (forward reference)', () => {
      const t1 = tm.createStep('Dependent', 'References unknown', ['step-999'])
      expect(t1.status).toBe('blocked')
    })
  })

  describe('updateStep', () => {
    it('changes step status', () => {
      const step = tm.createStep('Test', 'Desc')
      const updated = tm.updateStep(step.id, { status: 'in_progress' })
      expect(updated?.status).toBe('in_progress')
    })

    it('changes step subject', () => {
      const step = tm.createStep('Old subject', 'Desc')
      const updated = tm.updateStep(step.id, { subject: 'New subject' })
      expect(updated?.subject).toBe('New subject')
    })

    it('changes step description', () => {
      const step = tm.createStep('Subject', 'Old desc')
      const updated = tm.updateStep(step.id, { description: 'New desc' })
      expect(updated?.description).toBe('New desc')
    })

    it('returns null for unknown step ID', () => {
      const result = tm.updateStep('step-999', { status: 'completed' })
      expect(result).toBeNull()
    })

    it('updates updatedAt timestamp', () => {
      const step = tm.createStep('Test', 'Desc')
      const before = step.updatedAt
      // Small delay to ensure timestamp difference
      const updated = tm.updateStep(step.id, { status: 'in_progress' })
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('dependency unblocking', () => {
    it('unblocks dependent steps when all blockers are completed', () => {
      const t1 = tm.createStep('Blocker 1', 'First')
      const t2 = tm.createStep('Blocker 2', 'Second')
      const t3 = tm.createStep('Dependent', 'Depends on both', [t1.id, t2.id])

      expect(t3.status).toBe('blocked')

      // Complete first blocker -- still blocked
      tm.updateStep(t1.id, { status: 'completed' })
      expect(tm.getStep(t3.id)?.status).toBe('blocked')

      // Complete second blocker -- should unblock
      tm.updateStep(t2.id, { status: 'completed' })
      expect(tm.getStep(t3.id)?.status).toBe('pending')
    })

    it('does not unblock if only some blockers are completed', () => {
      const t1 = tm.createStep('blocker-a')
      const t2 = tm.createStep('blocker-b')
      const t3 = tm.createStep('blocked', undefined, [t1.id, t2.id])

      tm.updateStep(t1.id, { status: 'completed' })
      expect(tm.getStep(t3.id)?.status).toBe('blocked')
    })
  })
})
