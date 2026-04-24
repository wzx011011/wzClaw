import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDiffStore } from '../diff-store'
import type { PendingDiff, DiffHunk } from '../../../shared/types'

// Mock uuid to return predictable values
let uuidCounter = 0
vi.mock('uuid', () => ({
  v4: () => `mock-uuid-${++uuidCounter}`
}))

// Reset counter and store before each test
beforeEach(() => {
  uuidCounter = 0
  useDiffStore.setState({
    pendingDiffs: [],
    activeDiffId: null
  })
})

// ============================================================
// Helper: create a simple PendingDiff for testing
// ============================================================
function createTestDiff(overrides?: Partial<PendingDiff>): PendingDiff {
  return {
    id: 'diff-1',
    filePath: '/test/file.ts',
    originalContent: 'line1\nline2\nline3\nline4\nline5',
    modifiedContent: 'line1\nmodified2\nline3\nline4\nline5',
    hunks: [
      {
        id: 'hunk-1',
        startIndex: 1,
        endIndex: 1,
        type: 'replace',
        originalLines: ['line2'],
        modifiedLines: ['modified2'],
        status: 'pending'
      }
    ],
    toolCallId: 'tc-1',
    timestamp: Date.now(),
    ...overrides
  }
}

describe('DiffStore', () => {
  // ============================================================
  // Test 1: addDiff creates pending diff with hunks computed from original vs modified content
  // ============================================================
  it('should add a pending diff with computed hunks', () => {
    const store = useDiffStore.getState()

    const diff: PendingDiff = {
      id: 'diff-add',
      filePath: '/test/new-file.ts',
      originalContent: 'aaa\nbbb\nccc',
      modifiedContent: 'aaa\nxxx\nccc',
      hunks: [],  // empty hunks, should be computed by addDiff
      toolCallId: 'tc-add',
      timestamp: Date.now()
    }

    store.addDiff(diff)

    const state = useDiffStore.getState()
    expect(state.pendingDiffs).toHaveLength(1)
    expect(state.pendingDiffs[0].id).toBe('diff-add')
    // Hunks should have been computed
    expect(state.pendingDiffs[0].hunks.length).toBeGreaterThan(0)
    // The hunk should represent the change from bbb -> xxx
    expect(state.pendingDiffs[0].hunks[0].type).toBe('replace')
    expect(state.pendingDiffs[0].hunks[0].originalLines).toEqual(['bbb'])
    expect(state.pendingDiffs[0].hunks[0].modifiedLines).toEqual(['xxx'])
    // activeDiffId should be set to the new diff
    expect(state.activeDiffId).toBe('diff-add')
  })

  // ============================================================
  // Test 2: acceptHunk marks hunk as accepted and applies change
  // ============================================================
  it('should accept a single hunk and apply it via IPC', async () => {
    // Mock the IPC apply function
    const mockApplyHunk = vi.fn().mockResolvedValue({ success: true })
    ;(globalThis as Record<string, unknown>).window = {
      wzxclaw: { applyHunk: mockApplyHunk }
    }

    // Add a diff with multiple hunks
    const diff = createTestDiff({
      id: 'diff-accept',
      hunks: [
        { id: 'hunk-a', startIndex: 1, endIndex: 1, type: 'replace', originalLines: ['line2'], modifiedLines: ['new2'], status: 'pending' },
        { id: 'hunk-b', startIndex: 3, endIndex: 3, type: 'replace', originalLines: ['line4'], modifiedLines: ['new4'], status: 'pending' }
      ]
    })
    useDiffStore.getState().addDiff(diff)

    // Accept one hunk
    await useDiffStore.getState().acceptHunk('diff-accept', 'hunk-a')

    const state = useDiffStore.getState()
    // The accepted hunk should be removed from pending hunks
    const updatedDiff = state.pendingDiffs.find(d => d.id === 'diff-accept')
    expect(updatedDiff).toBeDefined()
    expect(updatedDiff!.hunks.find(h => h.id === 'hunk-a')).toBeUndefined()
    // The other hunk should still be pending
    expect(updatedDiff!.hunks.find(h => h.id === 'hunk-b')?.status).toBe('pending')
    // IPC should have been called
    expect(mockApplyHunk).toHaveBeenCalled()
  })

  // ============================================================
  // Test 3: rejectHunk removes the hunk without applying
  // ============================================================
  it('should reject a single hunk without applying it', async () => {
    const mockApplyHunk = vi.fn()
    ;(globalThis as Record<string, unknown>).window = {
      wzxclaw: { applyHunk: mockApplyHunk }
    }

    const diff = createTestDiff({
      id: 'diff-reject',
      hunks: [
        { id: 'hunk-r1', startIndex: 1, endIndex: 1, type: 'replace', originalLines: ['line2'], modifiedLines: ['new2'], status: 'pending' },
        { id: 'hunk-r2', startIndex: 3, endIndex: 3, type: 'replace', originalLines: ['line4'], modifiedLines: ['new4'], status: 'pending' }
      ]
    })
    useDiffStore.getState().addDiff(diff)

    // Reject one hunk
    await useDiffStore.getState().rejectHunk('diff-reject', 'hunk-r1')

    const state = useDiffStore.getState()
    const updatedDiff = state.pendingDiffs.find(d => d.id === 'diff-reject')
    expect(updatedDiff).toBeDefined()
    expect(updatedDiff!.hunks.find(h => h.id === 'hunk-r1')).toBeUndefined()
    // The other hunk should still be pending
    expect(updatedDiff!.hunks.find(h => h.id === 'hunk-r2')?.status).toBe('pending')
    // IPC should NOT have been called
    expect(mockApplyHunk).not.toHaveBeenCalled()
  })

  // ============================================================
  // Test 4: acceptAll applies all hunks and clears pending
  // ============================================================
  it('should accept all hunks and remove the diff from pending', async () => {
    const mockApplyHunk = vi.fn().mockResolvedValue({ success: true })
    ;(globalThis as Record<string, unknown>).window = {
      wzxclaw: { applyHunk: mockApplyHunk }
    }

    const diff = createTestDiff({
      id: 'diff-accept-all',
      hunks: [
        { id: 'hunk-aa1', startIndex: 1, endIndex: 1, type: 'replace', originalLines: ['line2'], modifiedLines: ['new2'], status: 'pending' },
        { id: 'hunk-aa2', startIndex: 3, endIndex: 3, type: 'replace', originalLines: ['line4'], modifiedLines: ['new4'], status: 'pending' }
      ]
    })
    useDiffStore.getState().addDiff(diff)

    await useDiffStore.getState().acceptAll('diff-accept-all')

    const state = useDiffStore.getState()
    // The diff should be removed entirely from pendingDiffs
    expect(state.pendingDiffs.find(d => d.id === 'diff-accept-all')).toBeUndefined()
    // IPC should have been called to apply hunks
    expect(mockApplyHunk).toHaveBeenCalled()
  })

  // ============================================================
  // Test 5: rejectAll clears all pending without applying
  // ============================================================
  it('should reject all hunks and remove the diff from pending', async () => {
    const mockApplyHunk = vi.fn()
    ;(globalThis as Record<string, unknown>).window = {
      wzxclaw: { applyHunk: mockApplyHunk }
    }

    const diff = createTestDiff({
      id: 'diff-reject-all',
      hunks: [
        { id: 'hunk-ra1', startIndex: 1, endIndex: 1, type: 'replace', originalLines: ['line2'], modifiedLines: ['new2'], status: 'pending' },
        { id: 'hunk-ra2', startIndex: 3, endIndex: 3, type: 'replace', originalLines: ['line4'], modifiedLines: ['new4'], status: 'pending' }
      ]
    })
    useDiffStore.getState().addDiff(diff)

    await useDiffStore.getState().rejectAll('diff-reject-all')

    const state = useDiffStore.getState()
    expect(state.pendingDiffs.find(d => d.id === 'diff-reject-all')).toBeUndefined()
    // IPC should NOT have been called
    expect(mockApplyHunk).not.toHaveBeenCalled()
  })

  // ============================================================
  // Test 6: Hunks are computed as contiguous changed regions
  // ============================================================
  it('should compute hunks as contiguous changed regions with context', () => {
    const original = [
      'unchanged-1',
      'unchanged-2',
      'old-line-a',
      'old-line-b',
      'unchanged-3',
      'unchanged-4',
      'old-line-c',
      'unchanged-5'
    ].join('\n')

    const modified = [
      'unchanged-1',
      'unchanged-2',
      'new-line-a',
      'new-line-b',
      'unchanged-3',
      'unchanged-4',
      'new-line-c',
      'unchanged-5'
    ].join('\n')

    const diff: PendingDiff = {
      id: 'diff-compute',
      filePath: '/test/compute.ts',
      originalContent: original,
      modifiedContent: modified,
      hunks: [],
      toolCallId: 'tc-compute',
      timestamp: Date.now()
    }

    useDiffStore.getState().addDiff(diff)

    const state = useDiffStore.getState()
    const computed = state.pendingDiffs[0]

    // Should produce 2 separate hunks (lines 2-3 change, and line 6 change)
    expect(computed.hunks.length).toBe(2)

    // First hunk: replace old-line-a, old-line-b -> new-line-a, new-line-b
    expect(computed.hunks[0].type).toBe('replace')
    expect(computed.hunks[0].originalLines).toEqual(['old-line-a', 'old-line-b'])
    expect(computed.hunks[0].modifiedLines).toEqual(['new-line-a', 'new-line-b'])

    // Second hunk: replace old-line-c -> new-line-c
    expect(computed.hunks[1].type).toBe('replace')
    expect(computed.hunks[1].originalLines).toEqual(['old-line-c'])
    expect(computed.hunks[1].modifiedLines).toEqual(['new-line-c'])

    // All hunks should have status pending
    expect(computed.hunks.every(h => h.status === 'pending')).toBe(true)
  })

  // ============================================================
  // Test 7: setActiveDiff sets the active diff for Monaco display
  // ============================================================
  it('should set and clear active diff ID', () => {
    const store = useDiffStore.getState()
    store.setActiveDiff('diff-1')
    expect(useDiffStore.getState().activeDiffId).toBe('diff-1')

    store.setActiveDiff(null)
    expect(useDiffStore.getState().activeDiffId).toBeNull()
  })

  // ============================================================
  // Test 8: clearDiffs removes all pending diffs and clears active
  // ============================================================
  it('should clear all pending diffs and active diff', () => {
    const diff1 = createTestDiff({ id: 'diff-c1' })
    const diff2 = createTestDiff({ id: 'diff-c2', filePath: '/test/other.ts' })

    useDiffStore.getState().addDiff(diff1)
    useDiffStore.getState().addDiff(diff2)
    useDiffStore.getState().setActiveDiff('diff-c1')

    useDiffStore.getState().clearDiffs()

    const state = useDiffStore.getState()
    expect(state.pendingDiffs).toHaveLength(0)
    expect(state.activeDiffId).toBeNull()
  })

  // ============================================================
  // Test 9: addDiff with pure additions produces 'add' type hunks
  // ============================================================
  it('should compute add-type hunks for new lines', () => {
    const original = 'line1\nline2\nline3'
    const modified = 'line1\nline1.5\nline2\nline3'

    const diff: PendingDiff = {
      id: 'diff-add-type',
      filePath: '/test/add.ts',
      originalContent: original,
      modifiedContent: modified,
      hunks: [],
      toolCallId: 'tc-add',
      timestamp: Date.now()
    }

    useDiffStore.getState().addDiff(diff)

    const state = useDiffStore.getState()
    const hunk = state.pendingDiffs[0].hunks[0]
    expect(hunk.type).toBe('add')
    expect(hunk.originalLines).toEqual([])
    expect(hunk.modifiedLines).toEqual(['line1.5'])
  })

  // ============================================================
  // Test 10: addDiff with pure deletions produces 'delete' type hunks
  // ============================================================
  it('should compute delete-type hunks for removed lines', () => {
    const original = 'line1\nline2\nline3'
    const modified = 'line1\nline3'

    const diff: PendingDiff = {
      id: 'diff-del-type',
      filePath: '/test/del.ts',
      originalContent: original,
      modifiedContent: modified,
      hunks: [],
      toolCallId: 'tc-del',
      timestamp: Date.now()
    }

    useDiffStore.getState().addDiff(diff)

    const state = useDiffStore.getState()
    const hunk = state.pendingDiffs[0].hunks[0]
    expect(hunk.type).toBe('delete')
    expect(hunk.originalLines).toEqual(['line2'])
    expect(hunk.modifiedLines).toEqual([])
  })

  // ============================================================
  // Test 11: accepting last hunk in a diff removes the diff entirely
  // ============================================================
  it('should remove diff from pending when last hunk is accepted', async () => {
    const mockApplyHunk = vi.fn().mockResolvedValue({ success: true })
    ;(globalThis as Record<string, unknown>).window = {
      wzxclaw: { applyHunk: mockApplyHunk }
    }

    const diff = createTestDiff({
      id: 'diff-last-hunk',
      hunks: [
        { id: 'hunk-only', startIndex: 1, endIndex: 1, type: 'replace', originalLines: ['line2'], modifiedLines: ['new2'], status: 'pending' }
      ]
    })
    useDiffStore.getState().addDiff(diff)

    // Accept the only hunk
    await useDiffStore.getState().acceptHunk('diff-last-hunk', 'hunk-only')

    const state = useDiffStore.getState()
    // Diff should be fully removed
    expect(state.pendingDiffs.find(d => d.id === 'diff-last-hunk')).toBeUndefined()
    expect(state.activeDiffId).toBeNull()
  })
})
