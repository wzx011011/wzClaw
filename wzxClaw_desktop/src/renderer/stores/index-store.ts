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

/** 节流间隔（ms）— 索引进度更新最多每 500ms 触发一次 set() */
const INDEX_PROGRESS_THROTTLE_MS = 500

export const useIndexStore = create<IndexStore>((set, get) => ({
  status: 'idle',
  fileCount: 0,
  currentFile: '',
  error: null,

  /**
   * Subscribe to index:progress IPC events. Returns unsubscribe function.
   * Call once on mount (e.g. in IDELayout useEffect), cleanup on unmount.
   * Also fetches initial status via getStatus().
   *
   * 进度更新节流：每 INDEX_PROGRESS_THROTTLE_MS 最多触发一次 set()，
   * 防止启动索引期间每个文件触发重渲染。
   */
  init: () => {
    let lastUpdateTime = 0
    let pendingTimer: ReturnType<typeof setTimeout> | null = null

    const applyProgress = (payload: IndexProgressPayload) => {
      lastUpdateTime = Date.now()
      set({
        status: (payload.status as IndexingStatus) || 'idle',
        fileCount: payload.fileCount,
        currentFile: payload.currentFile,
        error: payload.error ?? null
      })
    }

    const unsubscribe = window.wzxclaw.onIndexProgress((payload: IndexProgressPayload) => {
      // 状态切换（idle→indexing, indexing→ready/error）立即更新，不节流
      const newStatus = (payload.status as IndexingStatus) || 'idle'
      const isTransition = newStatus !== get().status
      if (newStatus !== 'indexing' || isTransition) {
        applyProgress(payload)
        if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
        return
      }

      // 索引进度更新节流
      const now = Date.now()
      if (now - lastUpdateTime >= INDEX_PROGRESS_THROTTLE_MS) {
        applyProgress(payload)
      } else if (!pendingTimer) {
        pendingTimer = setTimeout(() => {
          pendingTimer = null
          applyProgress(payload)
        }, INDEX_PROGRESS_THROTTLE_MS - (now - lastUpdateTime))
      }
    })

    // Fetch initial status on init
    get().getStatus()

    return () => {
      unsubscribe()
      if (pendingTimer) clearTimeout(pendingTimer)
    }
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
