import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useIndexStore } from '../index-store'

const mockUnsubscribe = vi.fn()
const mockOnIndexProgress = vi.fn().mockReturnValue(mockUnsubscribe)
const mockGetIndexStatus = vi.fn().mockResolvedValue({
  status: 'idle',
  fileCount: 0,
  currentFile: ''
})
const mockReindex = vi.fn().mockResolvedValue(undefined)

const mockWzxclaw = {
  getIndexStatus: mockGetIndexStatus,
  reindex: mockReindex,
  onIndexProgress: mockOnIndexProgress,
  searchIndex: vi.fn().mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  ;(globalThis as Record<string, unknown>).window = { wzxclaw: { ...mockWzxclaw } }

  useIndexStore.setState({
    status: 'idle',
    fileCount: 0,
    currentFile: '',
    error: null
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function getWzxclaw(): Record<string, ReturnType<typeof vi.fn>> {
  return (globalThis as unknown as { window: { wzxclaw: Record<string, ReturnType<typeof vi.fn>> } }).window.wzxclaw
}

describe('IndexStore', () => {
  describe('init', () => {
    it('should subscribe to index:progress events and return unsubscribe', () => {
      const { init } = useIndexStore.getState()
      const unsubscribe = init()

      expect(mockOnIndexProgress).toHaveBeenCalledTimes(1)
      expect(typeof unsubscribe).toBe('function')
      expect(mockGetIndexStatus).toHaveBeenCalledTimes(1)
    })

    it('should fetch initial status on init', async () => {
      mockGetIndexStatus.mockResolvedValue({
        status: 'ready',
        fileCount: 42,
        currentFile: ''
      })

      const { init } = useIndexStore.getState()
      init()
      // Wait for getStatus to resolve
      await vi.waitFor(() => {
        expect(useIndexStore.getState().status).toBe('ready')
        expect(useIndexStore.getState().fileCount).toBe(42)
      })
    })

    it('should update store when progress event fires', () => {
      let progressCallback: (p: { status: string; fileCount: number; currentFile: string; error?: string }) => void = () => {}
      mockOnIndexProgress.mockImplementation((cb) => {
        progressCallback = cb
        return mockUnsubscribe
      })

      const { init } = useIndexStore.getState()
      init()

      // Simulate a progress event from main process
      progressCallback({ status: 'indexing', fileCount: 15, currentFile: 'src/foo.ts' })

      expect(useIndexStore.getState().status).toBe('indexing')
      expect(useIndexStore.getState().fileCount).toBe(15)
      expect(useIndexStore.getState().currentFile).toBe('src/foo.ts')
    })

    it('should update store with error on progress event with error field', () => {
      let progressCallback: (p: { status: string; fileCount: number; currentFile: string; error?: string }) => void = () => {}
      mockOnIndexProgress.mockImplementation((cb) => {
        progressCallback = cb
        return mockUnsubscribe
      })

      const { init } = useIndexStore.getState()
      init()

      progressCallback({ status: 'error', fileCount: 0, currentFile: '', error: 'Out of memory' })

      expect(useIndexStore.getState().status).toBe('error')
      expect(useIndexStore.getState().error).toBe('Out of memory')
    })

    it('should unsubscribe when returned function is called', () => {
      // Ensure mock returns the unsubscribe function
      mockOnIndexProgress.mockReturnValue(mockUnsubscribe)

      const { init } = useIndexStore.getState()
      const unsubscribe = init()
      unsubscribe()

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    })
  })

  describe('reindex', () => {
    it('should call window.wzxclaw.reindex', async () => {
      const { reindex } = useIndexStore.getState()
      await reindex()

      expect(mockReindex).toHaveBeenCalledTimes(1)
    })

    it('should set error state on reindex failure', async () => {
      mockReindex.mockRejectedValue(new Error('Workspace not open'))

      const { reindex } = useIndexStore.getState()
      await reindex()

      expect(useIndexStore.getState().status).toBe('error')
      expect(useIndexStore.getState().error).toBe('Workspace not open')
    })
  })

  describe('getStatus', () => {
    it('should fetch and update status from main process', async () => {
      mockGetIndexStatus.mockResolvedValue({
        status: 'ready',
        fileCount: 100,
        currentFile: ''
      })

      const { getStatus } = useIndexStore.getState()
      await getStatus()

      expect(useIndexStore.getState().status).toBe('ready')
      expect(useIndexStore.getState().fileCount).toBe(100)
    })

    it('should handle error gracefully without crashing', async () => {
      mockGetIndexStatus.mockRejectedValue(new Error('IPC failed'))

      const { getStatus } = useIndexStore.getState()
      // Should not throw
      await getStatus()

      // State should remain unchanged
      expect(useIndexStore.getState().status).toBe('idle')
    })
  })
})
