import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import type { PendingDiff, DiffHunk } from '../../shared/types'

// ============================================================
// Diff Store (per DIFF-01 through DIFF-07)
// Manages pending file diffs with per-hunk accept/reject.
// ============================================================

interface DiffState {
  pendingDiffs: PendingDiff[]
  activeDiffId: string | null
}

interface DiffActions {
  addDiff: (diff: PendingDiff) => void
  acceptHunk: (diffId: string, hunkId: string) => Promise<void>
  rejectHunk: (diffId: string, hunkId: string) => Promise<void>
  acceptAll: (diffId: string) => Promise<void>
  rejectAll: (diffId: string) => Promise<void>
  clearDiffs: () => void
  setActiveDiff: (diffId: string | null) => void
}

type DiffStore = DiffState & DiffActions

// ============================================================
// Hunk computation: line-by-line LCS-based diff
// Produces contiguous changed regions from original vs modified.
// ============================================================

function computeHunks(originalContent: string, modifiedContent: string): DiffHunk[] {
  const originalLines = originalContent.split('\n')
  const modifiedLines = modifiedContent.split('\n')
  const hunks: DiffHunk[] = []

  // Simple LCS-based diff using a DP table
  const m = originalLines.length
  const n = modifiedLines.length

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (originalLines[i - 1] === modifiedLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to find diff operations
  interface DiffOp {
    type: 'equal' | 'delete' | 'insert'
    originalIdx: number
    modifiedIdx: number
    line: string
  }

  const ops: DiffOp[] = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && originalLines[i - 1] === modifiedLines[j - 1]) {
      ops.push({ type: 'equal', originalIdx: i - 1, modifiedIdx: j - 1, line: originalLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', originalIdx: -1, modifiedIdx: j - 1, line: modifiedLines[j - 1] })
      j--
    } else {
      ops.push({ type: 'delete', originalIdx: i - 1, modifiedIdx: -1, line: originalLines[i - 1] })
      i--
    }
  }
  ops.reverse()

  // Group contiguous changes into hunks
  let currentDeletes: DiffOp[] = []
  let currentInserts: DiffOp[] = []

  function flushHunk(): void {
    if (currentDeletes.length === 0 && currentInserts.length === 0) return

    const hasDeletes = currentDeletes.length > 0
    const hasInserts = currentInserts.length > 0

    let type: DiffHunk['type']
    if (hasDeletes && hasInserts) {
      type = 'replace'
    } else if (hasDeletes) {
      type = 'delete'
    } else {
      type = 'add'
    }

    // startIndex/endIndex refer to original line indices
    const startIdx = currentDeletes.length > 0
      ? currentDeletes[0].originalIdx
      : (currentInserts.length > 0 ? currentInserts[0].modifiedIdx : 0)
    const endIdx = currentDeletes.length > 0
      ? currentDeletes[currentDeletes.length - 1].originalIdx
      : (currentInserts.length > 0 ? currentInserts[currentInserts.length - 1].modifiedIdx : 0)

    hunks.push({
      id: uuidv4(),
      startIndex: startIdx,
      endIndex: endIdx,
      type,
      originalLines: currentDeletes.map(op => op.line),
      modifiedLines: currentInserts.map(op => op.line),
      status: 'pending'
    })

    currentDeletes = []
    currentInserts = []
  }

  for (const op of ops) {
    if (op.type === 'equal') {
      flushHunk()
    } else if (op.type === 'delete') {
      currentDeletes.push(op)
    } else {
      currentInserts.push(op)
    }
  }
  flushHunk()

  return hunks
}

// ============================================================
// Apply accepted hunks to file content and write via IPC
// ============================================================

async function applyHunksToDisk(
  filePath: string,
  originalContent: string,
  modifiedContent: string,
  hunkIds: string[],
  allHunks: DiffHunk[]
): Promise<void> {
  if (hunkIds.length === 0) return

  // Build the final content by applying only accepted hunks
  const originalLines = originalContent.split('\n')
  const acceptedIds = new Set(hunkIds)
  const acceptedHunks = allHunks.filter(h => acceptedIds.has(h.id))

  // Sort hunks by startIndex descending so we can splice from end to start
  // without invalidating earlier indices
  const sortedHunks = [...acceptedHunks].sort((a, b) => b.startIndex - a.startIndex)

  const resultLines = [...originalLines]
  for (const hunk of sortedHunks) {
    // Remove original lines and insert modified lines
    resultLines.splice(hunk.startIndex, hunk.endIndex - hunk.startIndex + 1, ...hunk.modifiedLines)
  }

  const finalContent = resultLines.join('\n')

  await window.wzxclaw.applyHunk({
    filePath,
    hunksToApply: hunkIds,
    modifiedContent: finalContent
  })
}

// ============================================================
// Store
// ============================================================

export const useDiffStore = create<DiffStore>((set, get) => ({
  pendingDiffs: [],
  activeDiffId: null,

  /**
   * Add a pending diff. Computes hunks from original vs modified content.
   * Sets the new diff as active.
   */
  addDiff: (diff: PendingDiff) => {
    const hunks = diff.hunks.length > 0 ? diff.hunks : computeHunks(diff.originalContent, diff.modifiedContent)
    const newDiff: PendingDiff = { ...diff, hunks }
    set({
      pendingDiffs: [...get().pendingDiffs, newDiff],
      activeDiffId: diff.id
    })
  },

  /**
   * Accept a single hunk: apply it to disk and remove from pending hunks.
   * If this was the last hunk, remove the entire diff from pendingDiffs.
   */
  acceptHunk: async (diffId: string, hunkId: string) => {
    const { pendingDiffs } = get()
    const diff = pendingDiffs.find(d => d.id === diffId)
    if (!diff) return

    const hunk = diff.hunks.find(h => h.id === hunkId)
    if (!hunk) return

    // Apply this single hunk to disk
    await applyHunksToDisk(diff.filePath, diff.originalContent, diff.modifiedContent, [hunkId], diff.hunks)

    // Remove accepted hunk from diff
    const updatedHunks = diff.hunks.filter(h => h.id !== hunkId)

    if (updatedHunks.length === 0) {
      // Last hunk resolved - remove diff entirely
      set({
        pendingDiffs: pendingDiffs.filter(d => d.id !== diffId),
        activeDiffId: get().activeDiffId === diffId ? null : get().activeDiffId
      })
    } else {
      set({
        pendingDiffs: pendingDiffs.map(d =>
          d.id === diffId ? { ...d, hunks: updatedHunks } : d
        )
      })
    }
  },

  /**
   * Reject a single hunk: remove without applying.
   * If this was the last hunk, remove the entire diff from pendingDiffs.
   */
  rejectHunk: async (diffId: string, hunkId: string) => {
    const { pendingDiffs } = get()
    const diff = pendingDiffs.find(d => d.id === diffId)
    if (!diff) return

    const updatedHunks = diff.hunks.filter(h => h.id !== hunkId)

    if (updatedHunks.length === 0) {
      set({
        pendingDiffs: pendingDiffs.filter(d => d.id !== diffId),
        activeDiffId: get().activeDiffId === diffId ? null : get().activeDiffId
      })
    } else {
      set({
        pendingDiffs: pendingDiffs.map(d =>
          d.id === diffId ? { ...d, hunks: updatedHunks } : d
        )
      })
    }
  },

  /**
   * Accept all pending hunks in a diff and remove from pendingDiffs.
   */
  acceptAll: async (diffId: string) => {
    const { pendingDiffs } = get()
    const diff = pendingDiffs.find(d => d.id === diffId)
    if (!diff) return

    const pendingHunkIds = diff.hunks.map(h => h.id)
    await applyHunksToDisk(diff.filePath, diff.originalContent, diff.modifiedContent, pendingHunkIds, diff.hunks)

    set({
      pendingDiffs: pendingDiffs.filter(d => d.id !== diffId),
      activeDiffId: get().activeDiffId === diffId ? null : get().activeDiffId
    })
  },

  /**
   * Reject all pending hunks and remove from pendingDiffs.
   */
  rejectAll: async (diffId: string) => {
    set({
      pendingDiffs: get().pendingDiffs.filter(d => d.id !== diffId),
      activeDiffId: get().activeDiffId === diffId ? null : get().activeDiffId
    })
  },

  /**
   * Clear all pending diffs and reset active diff.
   */
  clearDiffs: () => {
    set({ pendingDiffs: [], activeDiffId: null })
  },

  /**
   * Set the active diff ID for Monaco display.
   */
  setActiveDiff: (diffId: string | null) => {
    set({ activeDiffId: diffId })
  }
}))
