import { create } from 'zustand'
import type { FileTreeNode, Workspace } from '../../shared/types'

// ============================================================
// Workspace Store — 文件树管理 + 工作区 CRUD
// ============================================================

// --- 文件树辅助函数 ---

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

// --- Store 类型 ---

interface WorkspaceStoreState {
  // 文件树状态
  rootPath: string | null
  tree: FileTreeNode[]
  // 工作区 CRUD 状态
  tasks: Workspace[]
  activeWorkspaceId: string | null
  viewingWorkspaceId: string | null
  // 通用状态
  isLoading: boolean
  error: string | null
}

interface WorkspaceStoreActions {
  // 文件树操作
  openFolder: () => Promise<void>
  setFolder: (folderPath: string) => Promise<void>
  setFolders: (projects: Array<{ name: string; path: string }>) => Promise<void>
  initWorkspace: () => Promise<void>
  loadTree: (dirPath?: string, depth?: number) => Promise<void>
  expandNode: (dirPath: string) => Promise<void>
  collapseNode: (dirPath: string) => void
  collapseAll: () => void
  updateNode: (path: string, changes: Partial<FileTreeNode>) => void
  handleFileChange: (filePath: string, changeType: string) => void
  // 工作区 CRUD
  loadWorkspaces: () => Promise<void>
  createWorkspace: (title: string, description?: string) => Promise<Workspace>
  updateWorkspace: (workspaceId: string, updates: { title?: string; description?: string; archived?: boolean }) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  openWorkspaceDetail: (workspaceId: string) => void
  closeWorkspaceDetail: () => void
  openWorkspace: (workspaceId: string) => void
  closeWorkspace: () => void
  addProject: (workspaceId: string, folderPath: string) => Promise<void>
  removeProject: (workspaceId: string, projectId: string) => Promise<void>
  getActiveWorkspace: () => Workspace | null
  getViewingWorkspace: () => Workspace | null
}

type WorkspaceStore = WorkspaceStoreState & WorkspaceStoreActions

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  rootPath: null,
  tree: [],
  tasks: [],
  activeWorkspaceId: null,
  viewingWorkspaceId: null,
  isLoading: false,
  error: null,

  // ============================================================
  // 文件树操作
  // ============================================================

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

  setFolder: async (folderPath: string) => {
    set({ isLoading: true, error: null })
    try {
      const result = await window.wzxclaw.setFolder({ folderPath })
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

  /**
   * Load multiple project folders as separate root nodes in the file tree.
   * Sets the first folder as the main workspace (for agent working dir),
   * then loads all folders and displays them as top-level collapsible roots.
   */
  setFolders: async (projects: Array<{ name: string; path: string }>) => {
    if (projects.length === 0) return
    if (projects.length === 1) {
      return get().setFolder(projects[0].path)
    }
    set({ isLoading: true, error: null })
    try {
      // Set first project as the agent's working directory
      const result = await window.wzxclaw.setFolder({ folderPath: projects[0].path })
      if (result) set({ rootPath: result.rootPath })

      // Load all project folders in parallel, each becomes a root node
      const rootNodes = await Promise.all(
        projects.map(async (project) => {
          const children = await window.wzxclaw.getDirectoryTree({
            dirPath: project.path,
            depth: 1,
          })
          const rootNode: FileTreeNode = {
            name: project.name,
            path: project.path,
            isDirectory: true,
            isExpanded: true,
            children,
          }
          return rootNode
        })
      )
      set({ tree: rootNodes })
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

  collapseAll: () => {
    const collapseAllNodes = (nodes: FileTreeNode[]): FileTreeNode[] =>
      nodes.map((n) => n.isDirectory
        ? { ...n, isExpanded: false, children: undefined }
        : n
      )
    set({ tree: collapseAllNodes(get().tree) })
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
  },

  // ============================================================
  // 工作区 CRUD
  // ============================================================

  loadWorkspaces: async () => {
    set({ isLoading: true, error: null })
    try {
      const tasks = await window.wzxclaw.listWorkspaces()
      set({ tasks, isLoading: false })
    } catch (err) {
      set({ error: (err as Error).message, isLoading: false })
    }
  },

  createWorkspace: async (title, description) => {
    const workspace = await window.wzxclaw.createWorkspace({ title, description })
    set((s) => ({ tasks: [...s.tasks, workspace] }))
    return workspace
  },

  updateWorkspace: async (workspaceId, updates) => {
    const updated = await window.wzxclaw.updateWorkspace({ workspaceId, updates })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
    }))
  },

  deleteWorkspace: async (workspaceId) => {
    await window.wzxclaw.deleteWorkspace({ workspaceId })
    set((s) => ({
      tasks: s.tasks.filter((t) => t.id !== workspaceId),
      activeWorkspaceId: s.activeWorkspaceId === workspaceId ? null : s.activeWorkspaceId
    }))
  },

  openWorkspaceDetail: (workspaceId) => {
    set({ viewingWorkspaceId: workspaceId })
  },

  closeWorkspaceDetail: () => {
    set({ viewingWorkspaceId: null })
  },

  openWorkspace: (workspaceId) => {
    set({ activeWorkspaceId: workspaceId, viewingWorkspaceId: null })
  },

  closeWorkspace: () => {
    set({ activeWorkspaceId: null })
  },

  addProject: async (workspaceId, folderPath) => {
    const updated = await window.wzxclaw.addWorkspaceProject({ workspaceId, folderPath })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
    }))
  },

  removeProject: async (workspaceId, projectId) => {
    const updated = await window.wzxclaw.removeWorkspaceProject({ workspaceId, projectId })
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === workspaceId ? updated : t))
    }))
  },

  getActiveWorkspace: () => {
    const { tasks, activeWorkspaceId } = get()
    if (!activeWorkspaceId) return null
    return tasks.find((t) => t.id === activeWorkspaceId) ?? null
  },

  getViewingWorkspace: () => {
    const { tasks, viewingWorkspaceId } = get()
    if (!viewingWorkspaceId) return null
    return tasks.find((t) => t.id === viewingWorkspaceId) ?? null
  }
}))
