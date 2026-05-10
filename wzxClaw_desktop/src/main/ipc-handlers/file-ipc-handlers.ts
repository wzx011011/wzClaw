import { ipcMain } from 'electron'
import path from 'path'
import { IPC_CHANNELS, IpcSchemas } from '../../shared/ipc-channels'
import type { WorkspaceManager } from '../workspace/workspace-manager'

/**
 * Check whether a file path is within the workspace root boundary.
 * Uses normalized, case-insensitive comparison to prevent path traversal
 * on Windows (e.g., junction points, case variations, ".." segments).
 */
function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const normalized = path.resolve(filePath).toLowerCase()
  const root = path.resolve(workspaceRoot).toLowerCase()
  return normalized === root || normalized.startsWith(root + path.sep)
}

export interface FileIpcDeps {
  workspaceManager: WorkspaceManager
}

export function registerFileIpcHandlers(deps: FileIpcDeps): void {
  const { workspaceManager } = deps

  // ============================================================
  // File: read
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read'], async (_event, request) => {
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) throw new Error('No workspace open')
    const filePath = request?.filePath
    if (typeof filePath !== 'string' || !filePath) throw new Error('Invalid filePath')
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath)
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      throw new Error('Access denied: file path is outside the workspace root')
    }
    return workspaceManager.readFile(absolutePath)
  })

  // ============================================================
  // File: read-content — reads file for @-mention injection with 100KB limit
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read-content'], async (_event, request) => {
    const result = IpcSchemas['file:read-content'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { filePath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      return { error: 'No workspace open', size: 0, limit: 102400 }
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      return { error: 'Access denied: file path is outside the workspace root', size: 0, limit: 102400 }
    }

    const { stat, readFile } = await import('fs/promises')
    const fileStat = await stat(absolutePath)
    const size = fileStat.size
    const limit = 102400 // 100KB

    if (size > limit) {
      return { error: 'File too large', size, limit }
    }

    const content = await readFile(absolutePath, 'utf-8')
    // Return relative path for display
    const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/')
    return { content, size, path: relativePath }
  })

  // ============================================================
  // File: read-folder-tree — generates directory tree summary for folder @-mention
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:read-folder-tree'], async (_event, request) => {
    const result = IpcSchemas['file:read-folder-tree'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { dirPath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      return { error: 'No workspace open' }
    }

    const absolutePath = path.isAbsolute(dirPath)
      ? dirPath
      : path.resolve(workspaceRoot, dirPath)

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      return { error: 'Access denied: directory path is outside the workspace root' }
    }

    // Directories to skip
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'out', 'coverage', '__pycache__', '.cache'])
    const MAX_DEPTH = 3
    const MAX_ENTRIES = 100

    const { readdir, stat: fsStat } = await import('fs/promises')

    interface TreeNode {
      name: string
      isDirectory: boolean
      children: TreeNode[]
    }

    async function buildTree(dir: string, depth: number, entryCount: { count: number }): Promise<TreeNode[]> {
      if (depth > MAX_DEPTH || entryCount.count >= MAX_ENTRIES) return []

      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return []
      }

      // Sort: directories first, then files, both alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      const nodes: TreeNode[] = []
      for (const entry of entries) {
        if (entryCount.count >= MAX_ENTRIES) break
        if (SKIP_DIRS.has(entry.name)) continue
        if (entry.name.startsWith('.') && entry.name !== '.env') continue

        entryCount.count++
        const childPath = path.join(dir, entry.name)
        const isDir = entry.isDirectory()

        const node: TreeNode = {
          name: entry.name,
          isDirectory: isDir,
          children: []
        }

        if (isDir) {
          node.children = await buildTree(childPath, depth + 1, entryCount)
        }

        nodes.push(node)
      }
      return nodes
    }

    try {
      const dirStat = await fsStat(absolutePath)
      if (!dirStat.isDirectory()) {
        return { error: 'Path is not a directory' }
      }

      const entryCount = { count: 0 }
      const children = await buildTree(absolutePath, 1, entryCount)

      // Format as tree string
      function formatTree(nodes: TreeNode[], prefix: string): string {
        let result = ''
        for (let i = 0; i < nodes.length; i++) {
          const isLast = i === nodes.length - 1
          const connector = isLast ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 '
          const suffix = nodes[i].isDirectory ? '/' : ''
          result += `${prefix}${connector}${nodes[i].name}${suffix}\n`

          if (nodes[i].isDirectory && nodes[i].children.length > 0) {
            const newPrefix = prefix + (isLast ? '    ' : '\u2502   ')
            result += formatTree(nodes[i].children, newPrefix)
          }
        }
        return result
      }

      const dirName = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/') || path.basename(absolutePath)
      const tree = `${dirName}/\n` + formatTree(children, '')
      const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/')

      return { tree, fileCount: entryCount.count, path: relativePath }
    } catch (err) {
      return { error: `Failed to read directory: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // ============================================================
  // File: save — validates filePath and enforces workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:save'], async (_event, request) => {
    const result = IpcSchemas['file:save'].request.safeParse(request)
    if (!result.success) {
      throw new Error(`Invalid request: ${result.error.message}`)
    }

    const { filePath } = result.data
    const workspaceRoot = workspaceManager.getWorkspaceRoot()
    if (!workspaceRoot) {
      throw new Error('No workspace open')
    }

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspaceRoot, filePath)

    // Verify the resolved path stays within the workspace boundary
    if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
      throw new Error('Access denied: file path is outside the workspace root')
    }

    await workspaceManager.saveFile(absolutePath, result.data.content)
  })

  // ============================================================
  // File: rename — renames/moves a file within workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:rename'], async (_event, request) => {
    try {
      const { oldPath, newPath } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absOld = path.isAbsolute(oldPath) ? oldPath : path.resolve(workspaceRoot, oldPath)
      const absNew = path.isAbsolute(newPath) ? newPath : path.resolve(workspaceRoot, newPath)

      if (!isWithinWorkspace(absOld, workspaceRoot) || !isWithinWorkspace(absNew, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const { rename } = await import('fs/promises')
      await rename(absOld, absNew)
      return { success: true }
    } catch (error) {
      console.error('Failed to rename file:', error)
      return { success: false }
    }
  })

  // ============================================================
  // File: delete — removes a file/directory within workspace boundary
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:delete'], async (_event, request) => {
    try {
      const { filePath } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceRoot, filePath)

      if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const { rm } = await import('fs/promises')
      await rm(absolutePath, { recursive: true })
      return { success: true }
    } catch (error) {
      console.error('Failed to delete file:', error)
      return { success: false }
    }
  })

  // ============================================================
  // File: create — creates a new empty file or directory
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:create'], async (_event, request) => {
    try {
      const { dirPath, name, type } = request
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) throw new Error('No workspace open')

      const absoluteDir = path.isAbsolute(dirPath) ? dirPath : path.resolve(workspaceRoot, dirPath)
      if (!isWithinWorkspace(absoluteDir, workspaceRoot)) {
        throw new Error('Access denied: path is outside the workspace root')
      }

      const fullPath = path.join(absoluteDir, name)
      const fsp = await import('fs/promises')
      if (type === 'directory') {
        await fsp.mkdir(fullPath, { recursive: true })
      } else {
        // 确保父目录存在
        await fsp.mkdir(absoluteDir, { recursive: true })
        await fsp.writeFile(fullPath, '', 'utf-8')
      }
      return { success: true, filePath: fullPath }
    } catch (error) {
      console.error('Failed to create file:', error)
      return { success: false, filePath: '' }
    }
  })

  // ============================================================
  // File: apply-hunk — validates filePath, enforces workspace boundary,
  // writes accepted diff hunks to disk
  // ============================================================
  ipcMain.handle(IPC_CHANNELS['file:apply-hunk'], async (_event, request) => {
    try {
      const result = IpcSchemas['file:apply-hunk'].request.safeParse(request)
      if (!result.success) {
        throw new Error(`Invalid request: ${result.error.message}`)
      }

      const { filePath, modifiedContent } = result.data
      const workspaceRoot = workspaceManager.getWorkspaceRoot()
      if (!workspaceRoot) {
        throw new Error('No workspace open')
      }

      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(workspaceRoot, filePath)

      // Verify the resolved path stays within the workspace boundary
      if (!isWithinWorkspace(absolutePath, workspaceRoot)) {
        throw new Error('Access denied: file path is outside the workspace root')
      }

      const { writeFile } = await import('fs/promises')
      await writeFile(absolutePath, modifiedContent, 'utf-8')
      return { success: true }
    } catch (error) {
      console.error('Failed to apply hunk:', error)
      return { success: false }
    }
  })
}
