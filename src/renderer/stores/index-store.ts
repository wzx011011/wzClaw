import { create } from 'zustand'

// ============================================================
// Index Store — state management for codebase indexing status
// (per IDX-06, IDX-07)
// ============================================================

export type IndexingStatus = 'idle' | 'indexing' | 'ready' | 'error'

interface IndexState {
  status: IndexingStatus
  fileCount: number
  currentFile: string
  error: string | null
}

interface IndexActions {
  init: () => () => void
  reindex: () => Promise<void>
  getStatus: () => Promise<void>
}

type IndexStore = IndexState & IndexActions

interface IndexProgressPayload {
  status: string
  fileCount: number
  currentFile: string
  error?: string
}

export const useIndexStore = create<IndexStore>((set, get) => ({
  status: 'idle',
  fileCount: 0,
  currentFile: '',
  error: null,

  /**
   * Subscribe to index:progress IPC events. Returns unsubscribe function.
   * Call once on mount (e.g. in IDELayout useEffect), cleanup on unmount.
   * Also fetches initial status via getStatus().
   */
  init: () => {
    const unsubscribe = window.wzxclaw.onIndexProgress((payload: IndexProgressPayload) => {
      set({
        status: (payload.status as IndexingStatus) || 'idle',
        fileCount: payload.fileCount,
        currentFile: payload.currentFile,
        error: payload.error ?? null
      })
    })

    // Fetch initial status on init
    get().getStatus()

    return unsubscribe
  },

  /**
   * Trigger a full re-index via IPC.
   * Progress events will be received by the init() subscription.
   */
  reindex: async () => {
    try {
      await window.wzxclaw.reindex()
    } catch (err) {
      set({
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      })
    }
  },

  /**
   * Fetch current index status from main process.
   */
  getStatus: async () => {
    try {
      const result = await window.wzxclaw.getIndexStatus()
      set({
        status: (result.status as IndexingStatus) || 'idle',
        fileCount: result.fileCount,
        currentFile: result.currentFile,
        error: result.error ?? null
      })
    } catch (err) {
      console.error('Failed to get index status:', err)
    }
  }
}))
