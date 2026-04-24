import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTabStore } from '../tab-store'

let uuidCounter = 0
vi.mock('uuid', () => ({ v4: () => `mock-uuid-${uuidCounter++}` }))

describe('TabStore', () => {
  beforeEach(() => {
    uuidCounter = 0
    useTabStore.setState({
      tabs: [],
      activeTabId: null
    })
    vi.restoreAllMocks()
    ;(globalThis as any).window = {
      wzxclaw: {
        saveFile: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue({ content: 'disk-content', language: 'typescript' })
      }
    }
  })

  describe('openTab', () => {
    it('should create new tab with correct properties', () => {
      const { openTab } = useTabStore.getState()
      openTab('/src/index.ts', 'index.ts', 'hello', 'typescript')

      const { tabs, activeTabId } = useTabStore.getState()
      expect(tabs).toHaveLength(1)
      expect(tabs[0]).toEqual({
        id: 'mock-uuid-0',
        filePath: '/src/index.ts',
        fileName: 'index.ts',
        content: 'hello',
        diskContent: 'hello',
        isDirty: false,
        language: 'typescript'
      })
      expect(activeTabId).toBe('mock-uuid-0')
    })

    it('should activate existing tab instead of creating duplicate for same filePath', () => {
      const { openTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')

      // Second open with same filePath — should reuse, not create
      openTab('/src/a.ts', 'a.ts', 'bbb', 'typescript')

      const { tabs, activeTabId } = useTabStore.getState()
      expect(tabs).toHaveLength(1)
      expect(tabs[0].content).toBe('aaa') // content stays from first open
      expect(activeTabId).toBe('mock-uuid-0')
    })
  })

  describe('closeTab', () => {
    it('should remove tab from array', () => {
      const { openTab, closeTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      openTab('/src/b.ts', 'b.ts', 'bbb', 'typescript')
      expect(useTabStore.getState().tabs).toHaveLength(2)

      closeTab(useTabStore.getState().tabs[0].id)
      expect(useTabStore.getState().tabs).toHaveLength(1)
      expect(useTabStore.getState().tabs[0].fileName).toBe('b.ts')
    })

    it('should set activeTabId to adjacent tab (prefer right) when closing active', () => {
      const { openTab, closeTab, setActiveTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      openTab('/src/b.ts', 'b.ts', 'bbb', 'typescript')
      openTab('/src/c.ts', 'c.ts', 'ccc', 'typescript')

      const tabs = useTabStore.getState().tabs
      // Activate the middle tab, then close it — should prefer right neighbor
      setActiveTab(tabs[1].id)
      closeTab(tabs[1].id)

      expect(useTabStore.getState().activeTabId).toBe(tabs[2].id)
    })

    it('should set activeTabId to null when closing last remaining tab', () => {
      const { openTab, closeTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      const tabId = useTabStore.getState().tabs[0].id

      closeTab(tabId)
      expect(useTabStore.getState().tabs).toHaveLength(0)
      expect(useTabStore.getState().activeTabId).toBeNull()
    })

    it('should be a no-op when closing unknown tabId', () => {
      const { openTab, closeTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      const before = useTabStore.getState().tabs

      closeTab('nonexistent-id')
      expect(useTabStore.getState().tabs).toEqual(before)
    })
  })

  describe('setActiveTab', () => {
    it('should update activeTabId', () => {
      const { openTab, setActiveTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      openTab('/src/b.ts', 'b.ts', 'bbb', 'typescript')

      const tabs = useTabStore.getState().tabs
      setActiveTab(tabs[0].id)
      expect(useTabStore.getState().activeTabId).toBe(tabs[0].id)
    })
  })

  describe('updateTabContent', () => {
    it('should mark dirty when content differs from diskContent', () => {
      const { openTab, updateTabContent } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'original', 'typescript')
      const tabId = useTabStore.getState().tabs[0].id

      updateTabContent(tabId, 'modified')
      const tab = useTabStore.getState().tabs[0]
      expect(tab.content).toBe('modified')
      expect(tab.isDirty).toBe(true)
    })

    it('should mark clean when content matches diskContent', () => {
      const { openTab, updateTabContent } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'original', 'typescript')
      const tabId = useTabStore.getState().tabs[0].id

      // First dirty it
      updateTabContent(tabId, 'modified')
      expect(useTabStore.getState().tabs[0].isDirty).toBe(true)

      // Then set back to original disk content
      updateTabContent(tabId, 'original')
      expect(useTabStore.getState().tabs[0].isDirty).toBe(false)
    })
  })

  describe('getActiveTab', () => {
    it('should return correct tab', () => {
      const { openTab } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'aaa', 'typescript')
      openTab('/src/b.ts', 'b.ts', 'bbb', 'typescript')

      // activeTabId should be the second tab (last opened)
      const active = useTabStore.getState().getActiveTab()
      expect(active).toBeDefined()
      expect(active!.fileName).toBe('b.ts')
    })

    it('should return undefined when no active tab', () => {
      const result = useTabStore.getState().getActiveTab()
      expect(result).toBeUndefined()
    })
  })

  describe('refreshTabContent', () => {
    it('should update both content and diskContent, clearing isDirty', () => {
      const { openTab, updateTabContent, refreshTabContent } = useTabStore.getState()
      openTab('/src/a.ts', 'a.ts', 'original', 'typescript')
      const tabId = useTabStore.getState().tabs[0].id

      // Dirty the tab
      updateTabContent(tabId, 'dirty-content')
      expect(useTabStore.getState().tabs[0].isDirty).toBe(true)

      // Refresh clears dirty
      refreshTabContent(tabId, 'new-disk-content')
      const tab = useTabStore.getState().tabs[0]
      expect(tab.content).toBe('new-disk-content')
      expect(tab.diskContent).toBe('new-disk-content')
      expect(tab.isDirty).toBe(false)
    })
  })
})
