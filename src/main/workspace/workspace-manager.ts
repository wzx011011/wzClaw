import { dialog, BrowserWindow } from 'electron'
import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { join, basename, extname } from 'path'
import type { FSWatcher } from 'chokidar'
import type { FileTreeNode } from '../../shared/types'

// ============================================================
// Language Detection
// ============================================================

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.py': 'python',
  '.css': 'css',
  '.scss': 'css',
  '.html': 'html',
  '.md': 'markdown',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.sh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.xml': 'xml',
  '.sql': 'sql',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.vue': 'html',
  '.svelte': 'html',
  '.less': 'css',
  '.sass': 'css',
  '.svg': 'xml',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.env': 'plaintext',
  '.gitignore': 'plaintext',
  '.dockerfile': 'dockerfile',
  '.makefile': 'plaintext'
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  'dockerfile': 'dockerfile',
  'makefile': 'plaintext',
  'gemfile': 'ruby',
  'rakefile': 'ruby',
  '.gitignore': 'plaintext',
  '.env': 'plaintext',
  '.editorconfig': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json'
}

export function getLanguageFromPath(filePath: string): string {
  const filename = basename(filePath).toLowerCase()
  // Check filename-based matches first (e.g., Dockerfile, Makefile)
  if (FILENAME_TO_LANGUAGE[filename]) {
    return FILENAME_TO_LANGUAGE[filename]
  }
  const ext = extname(filePath).toLowerCase()
  return EXTENSION_TO_LANGUAGE[ext] ?? 'plaintext'
}

// ============================================================
// Directory Filtering
// ============================================================

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'out', '.next', '__pycache__', '.cache',
  '.git', '.svn', '.hg', 'build', '.turbo', '.nuxt', '.output',
  'coverage', '.nyc_output', '.parcel-cache', '.vercel'
])

const SKIP_DIR_PREFIXES = ['.']

function shouldSkipEntry(name: string, isDir: boolean): boolean {
  if (!isDir) return false
  if (SKIP_DIRS.has(name)) return true
  // Skip hidden directories (starting with .) except current dir
  if (name.length > 1 && SKIP_DIR_PREFIXES.some(p => name.startsWith(p))) return true
  return false
}

// ============================================================
// WorkspaceManager
// ============================================================

type FileChangeCallback = (filePath: string, changeType: string) => void

/** Pending batched file change notifications. */
interface PendingChange {
  filePath: string
  changeType: string
}

export class WorkspaceManager {
  private workspaceRoot: string | null = null
  private watcher: FSWatcher | null = null
  private fileChangeCallbacks: FileChangeCallback[] = []
  /** Throttle file change IPC: batch notifications every 300ms. */
  private _pendingChanges: PendingChange[] = []
  private _changeFlushTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly CHANGE_FLUSH_INTERVAL_MS = 300

  /**
   * Opens a native folder selection dialog and sets the workspace root.
   * Starts chokidar file watching on the selected folder.
   * Returns the selected root path, or null if cancelled.
   */
  async openFolderDialog(parentWindow: BrowserWindow): Promise<string | null> {
    const result = await dialog.showOpenDialog(parentWindow, {
      properties: ['openDirectory'],
      title: 'Open Folder'
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]
    this.workspaceRoot = selectedPath

    // Start watching the new workspace
    this.stopWatching()
    this.startWatching().catch((err) => {
      console.error('[WorkspaceManager] Failed to start watching:', err)
    })

    return selectedPath
  }

  /**
   * Reads directory entries and returns them as FileTreeNode[].
   * Directories are sorted first (alphabetically), then files (alphabetically).
   * Respects depth limit for lazy loading (default depth=1).
   * Skips node_modules, .git, dist, out, .next, etc.
   */
  async getDirectoryTree(dirPath?: string, depth: number = 1): Promise<FileTreeNode[]> {
    const targetPath = dirPath ?? this.workspaceRoot
    if (!targetPath) {
      return []
    }

    return this.readDirectoryLevel(targetPath, depth)
  }

  private async readDirectoryLevel(dirPath: string, depth: number): Promise<FileTreeNode[]> {
    let entries
    try {
      entries = await readdir(dirPath, { withFileTypes: true })
    } catch {
      return []
    }

    const nodes: FileTreeNode[] = []

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)

      if (entry.isDirectory()) {
        if (shouldSkipEntry(entry.name, true)) continue

        const node: FileTreeNode = {
          name: entry.name,
          path: fullPath,
          isDirectory: true,
          children: depth > 1 ? await this.readDirectoryLevel(fullPath, depth - 1) : undefined
        }
        nodes.push(node)
      } else if (entry.isFile()) {
        const node: FileTreeNode = {
          name: entry.name,
          path: fullPath,
          isDirectory: false
        }
        nodes.push(node)
      }
    }

    // Sort: directories first (alphabetically), then files (alphabetically)
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })

    return nodes
  }

  /**
   * Reads a file from disk and returns content + detected Monaco language ID.
   */
  async readFile(filePath: string): Promise<{ content: string; language: string }> {
    const content = await readFile(filePath, 'utf-8')
    const language = getLanguageFromPath(filePath)
    return { content, language }
  }

  /**
   * Writes content to a file on disk.
   */
  async saveFile(filePath: string, content: string): Promise<void> {
    await writeFile(filePath, content, 'utf-8')
  }

  /**
   * Starts chokidar file watching on the workspace root.
   * Fires registered callbacks on file add/change/unlink events.
   */
  async startWatching(): Promise<void> {
    if (!this.workspaceRoot) return
    if (this.watcher) return // Already watching

    const { watch } = await import('chokidar')

    // Use a function-based ignored so chokidar skips ENTERING these directories
    // entirely (glob patterns still cause chokidar to readdir into them).
    const SKIP_WATCH_DIRS = new Set([
      'node_modules', '.git', 'dist', 'out', '.next',
      '__pycache__', '.cache', '.wzxclaw', '.svn', '.hg',
      'build', '.turbo', '.nuxt', '.output', 'coverage',
      '.nyc_output', '.parcel-cache', '.vercel'
    ])
    const ignoreFn = (filePath: string): boolean => {
      const name = basename(filePath)
      if (SKIP_WATCH_DIRS.has(name)) return true
      return false
    }

    this.watcher = watch(this.workspaceRoot, {
      ignoreInitial: true,
      ignored: ignoreFn,
      persistent: true,
      depth: 20,
    })

    this.watcher.on('add', (p) => {
      this.enqueueFileChange(p, 'created')
    })

    this.watcher.on('change', (p) => {
      this.enqueueFileChange(p, 'modified')
    })

    this.watcher.on('unlink', (p) => {
      this.enqueueFileChange(p, 'deleted')
    })
  }

  /**
   * Stops the chokidar file watcher.
   */
  stopWatching(): void {
    // Flush any pending change notifications before stopping
    this.flushPendingChanges()
    if (this._changeFlushTimer) {
      clearTimeout(this._changeFlushTimer)
      this._changeFlushTimer = null
    }
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  /**
   * Returns the current workspace root path, or null if no folder is open.
   */
  getWorkspaceRoot(): string | null {
    return this.workspaceRoot
  }

  /**
   * Programmatically set the workspace root (e.g. restoring last session).
   * Starts file watching on the path.
   */
  setWorkspaceRoot(rootPath: string): void {
    this.workspaceRoot = rootPath
    this.stopWatching()
    this.startWatching().catch((err) => {
      console.error('[WorkspaceManager] Failed to start watching:', err)
    })
  }

  /**
   * Returns whether the workspace is currently being watched.
   */
  isWatching(): boolean {
    return this.watcher !== null
  }

  /**
   * Registers a callback for file change events from chokidar.
   */
  onFileChange(callback: FileChangeCallback): void {
    this.fileChangeCallbacks.push(callback)
  }

  /**
   * Removes a previously registered file change callback.
   */
  offFileChange(callback: FileChangeCallback): void {
    const idx = this.fileChangeCallbacks.indexOf(callback)
    if (idx >= 0) {
      this.fileChangeCallbacks.splice(idx, 1)
    }
  }

  /**
   * Cleans up: stops watching, clears callbacks.
   */
  dispose(): void {
    this.stopWatching()
    this.fileChangeCallbacks = []
  }

  /**
   * Enqueue a file change and schedule a batched flush.
   * Deduplicates same-file events within the flush window.
   */
  private enqueueFileChange(filePath: string, changeType: string): void {
    // Deduplicate: keep latest changeType for same file
    const existing = this._pendingChanges.findIndex(c => c.filePath === filePath)
    if (existing >= 0) {
      this._pendingChanges[existing].changeType = changeType
    } else {
      this._pendingChanges.push({ filePath, changeType })
    }

    if (!this._changeFlushTimer) {
      this._changeFlushTimer = setTimeout(() => {
        this.flushPendingChanges()
      }, WorkspaceManager.CHANGE_FLUSH_INTERVAL_MS)
    }
  }

  private flushPendingChanges(): void {
    this._changeFlushTimer = null
    const changes = this._pendingChanges
    this._pendingChanges = []
    for (const { filePath, changeType } of changes) {
      for (const cb of this.fileChangeCallbacks) {
        try {
          cb(filePath, changeType)
        } catch {
          // Swallow callback errors to keep watcher stable
        }
      }
    }
  }
}
