import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../workspace-store'
import type { FileTreeNode } from '../../../shared/types'

describe('WorkspaceStore', () => {
  const sampleTree: FileTreeNode[] = [
    {
      name: 'src',
      path: '/src',
      isDirectory: true,
      isExpanded: true,
      children: [
        { name: 'auth.ts', path: '/src/auth.ts', isDirectory: false },
        {
          name: 'utils',
          path: '/src/utils',
          isDirectory: true,
          isExpanded: true,
          children: [
            { name: 'helpers.ts', path: '/src/utils/helpers.ts', isDirectory: false }
          ]
        }
      ]
    },
    { name: 'package.json', path: '/package.json', isDirectory: false }
  ]

  beforeEach(() => {
    useWorkspaceStore.setState({
      rootPath: '/project',
      tree: JSON.parse(JSON.stringify(sampleTree)),
      isLoading: false,
      error: null
    })
    vi.restoreAllMocks()
    ;(globalThis as any).window = {
      wzxclaw: {
        openFolder: vi.fn(),
        setFolder: vi.fn(),
        getDirectoryTree: vi.fn().mockResolvedValue([]),
        getWorkspaceStatus: vi.fn().mockResolvedValue(null)
      }
    }
  })

  describe('collapseNode', () => {
    it('should set isExpanded=false and children=undefined on target directory', () => {
      const { collapseNode } = useWorkspaceStore.getState()
      collapseNode('/src')

      const tree = useWorkspaceStore.getState().tree
      const srcNode = tree.find((n) => n.path === '/src')!
      expect(srcNode.isExpanded).toBe(false)
      expect(srcNode.children).toBeUndefined()
    })

    it('should work on nested nodes', () => {
      const { collapseNode } = useWorkspaceStore.getState()
      collapseNode('/src/utils')

      const tree = useWorkspaceStore.getState().tree
      const srcNode = tree.find((n) => n.path === '/src')!
      const utilsNode = srcNode.children!.find((n) => n.path === '/src/utils')!
      expect(utilsNode.isExpanded).toBe(false)
      expect(utilsNode.children).toBeUndefined()

      // Parent should remain unchanged
      expect(srcNode.isExpanded).toBe(true)
      expect(srcNode.children).toBeDefined()
    })
  })

  describe('updateNode', () => {
    it('should merge changes into target node', () => {
      const { updateNode } = useWorkspaceStore.getState()
      updateNode('/src/auth.ts', { name: 'auth.new.ts' })

      const tree = useWorkspaceStore.getState().tree
      const srcNode = tree.find((n) => n.path === '/src')!
      const authNode = srcNode.children!.find((n) => n.path === '/src/auth.ts')!
      expect(authNode.name).toBe('auth.new.ts')
      // Other properties unchanged
      expect(authNode.isDirectory).toBe(false)
    })
  })

  describe('handleFileChange', () => {
    it('should remove node from tree on "deleted" changeType', () => {
      const { handleFileChange } = useWorkspaceStore.getState()
      handleFileChange('/src/auth.ts', 'deleted')

      const tree = useWorkspaceStore.getState().tree
      const srcNode = tree.find((n) => n.path === '/src')!
      const authNode = srcNode.children!.find((n) => n.path === '/src/auth.ts')
      expect(authNode).toBeUndefined()
    })

    it('should add node to correct parent on "created" changeType', () => {
      const { handleFileChange } = useWorkspaceStore.getState()
      handleFileChange('/src/new-file.ts', 'created')

      const tree = useWorkspaceStore.getState().tree
      const srcNode = tree.find((n) => n.path === '/src')!
      const newNode = srcNode.children!.find((n) => n.path === '/src/new-file.ts')
      expect(newNode).toBeDefined()
      expect(newNode!.name).toBe('new-file.ts')
      expect(newNode!.isDirectory).toBe(false)
    })

    it('should not change tree on "modified" changeType', () => {
      const before = JSON.parse(JSON.stringify(useWorkspaceStore.getState().tree))

      const { handleFileChange } = useWorkspaceStore.getState()
      handleFileChange('/src/auth.ts', 'modified')

      expect(useWorkspaceStore.getState().tree).toEqual(before)
    })
  })
})
