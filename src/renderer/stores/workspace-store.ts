import { create } from 'zustand'
import type { FileTreeNode } from '../../shared/types'

// ============================================================
// Workspace Store (per D-49)
// ============================================================

interface WorkspaceState {
  rootPath: string | null
  tree: FileTreeNode[]
  isLoading: boolean
  error: string | null
}

interface WorkspaceActions {
  openFolder: () => Promise<void>
  initWorkspace: () => Promise<void>
  loadTree: (dirPath?: string, depth?: number) => Promise<void>
  expandNode: (dirPath: string) => Promise<void>
  collapseNode: (dirPath: string) => void
  updateNode: (path: string, changes: Partial<FileTreeNode>) => void
  handleFileChange: (filePath: string, changeType: string) => void
}

type WorkspaceStore = WorkspaceState & WorkspaceActions

/**
 * Find a node in the tree by its path and return it along with its parent array.
 */
function findNodeInTree(
  nodes: FileTreeNode[],
  targetPath: string
): { node: FileTreeNode; parent: FileTreeNode[] } | null {
  for (const node of nodes) {
    if (node.path === targetPath) {
      return { node, parent: nodes }
    }
    if (node.isDirectory && node.children) {
      const result = findNodeInTree(node.children, targetPath)
      if (result) return result
    }
  }
  return null
}

/**
 * Remove a node from the tree by path (returns new tree array).
 */
function removeNodeFromTree(nodes: FileTreeNode[], targetPath: string): FileTreeNode[] {
  return nodes
    .filter((n) => n.path !== targetPath)
    .map((n) => {
      if (n.isDirectory && n.children) {
        return { ...n, children: removeNodeFromTree(n.children, targetPath) }
      }
      return n
    })
}

/**
 * Add a file node to the correct parent directory, sorted (dirs first, then files).
 */
function addFileToTree(
  nodes: FileTreeNode[],
  parentDir: string,
  newNode: FileTreeNode
): FileTreeNode[] {
  return nodes.map((n) => {
    if (n.path === parentDir && n.isDirectory) {
      const children = [...(n.children ?? []), newNode]
      children.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return { ...n, children }
    }
    if (n.isDirectory && n.children) {
      return { ...n, children: addFileToTree(n.children, parentDir, newNode) }
    }
    return n
  })
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  rootPath: null,
  tree: [],
  isLoading: false,
  error: null,

  openFolder: async () => {
    set({ isLoading: true, error: null })
    try {
      const result = await window.wzxclaw.openFolder()
      if (result) {
        set({ rootPath: result.rootPath })
        await get().loadTree(undefined, 1)
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ isLoading: false })
    }
  },

  // Restore last workspace on app startup — pulls from main process state
  initWorkspace: async () => {
    try {
      const status = await window.wzxclaw.getWorkspaceStatus()
      if (status?.rootPath) {
        set({ rootPath: status.rootPath })
        await get().loadTree(undefined, 1)
      }
    } catch {
      // silently skip — workspace may not be set
    }
  },

  loadTree: async (dirPath?: string, depth?: number) => {
    set({ isLoading: true, error: null })
    try {
      const tree = await window.wzxclaw.getDirectoryTree({
        dirPath,
        depth: depth ?? 1
      })
      if (!dirPath) {
        // Root level load — replace entire tree
        set({ tree })
      } else {
        // Sub-level load — merge into tree at the right position
        const found = findNodeInTree(get().tree, dirPath)
        if (found) {
          const updatedNode: FileTreeNode = {
            ...found.node,
            children: tree,
            isExpanded: true
          }
          const replaceNodeInTree = (
            nodes: FileTreeNode[]
          ): FileTreeNode[] => {
            return nodes.map((n) => {
              if (n.path === dirPath) return updatedNode
              if (n.isDirectory && n.children) {
                return { ...n, children: replaceNodeInTree(n.children) }
              }
              return n
            })
          }
          set({ tree: replaceNodeInTree(get().tree) })
        }
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ isLoading: false })
    }
  },

  expandNode: async (dirPath: string) => {
    // Check if already expanded with children
    const found = findNodeInTree(get().tree, dirPath)
    if (found && found.node.isExpanded && found.node.children && found.node.children.length > 0) {
      return
    }
    await get().loadTree(dirPath, 1)
  },

  collapseNode: (dirPath: string) => {
    const collapseInTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes.map((n) => {
        if (n.path === dirPath) {
          return { ...n, isExpanded: false, children: undefined }
        }
        if (n.isDirectory && n.children) {
          return { ...n, children: collapseInTree(n.children) }
        }
        return n
      })
    }
    set({ tree: collapseInTree(get().tree) })
  },

  updateNode: (path: string, changes: Partial<FileTreeNode>) => {
    const updateInTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
      return nodes.map((n) => {
        if (n.path === path) return { ...n, ...changes }
        if (n.isDirectory && n.children) {
          return { ...n, children: updateInTree(n.children) }
        }
        return n
      })
    }
    set({ tree: updateInTree(get().tree) })
  },

  handleFileChange: (filePath: string, changeType: string) => {
    const { tree } = get()
    if (changeType === 'deleted') {
      set({ tree: removeNodeFromTree(tree, filePath) })
    } else if (changeType === 'created') {
      // Find the parent directory and add the file node
      const pathParts = filePath.replace(/\\/g, '/').split('/')
      const fileName = pathParts[pathParts.length - 1]
      const parentDir = pathParts.slice(0, -1).join('/')
      const newNode: FileTreeNode = {
        name: fileName,
        path: filePath,
        isDirectory: false
      }
      set({ tree: addFileToTree(tree, parentDir, newNode) })
    }
    // 'modified' — no tree change needed, the tab store handles content refresh
  }
}))
