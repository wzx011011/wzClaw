import fs from 'fs/promises'

// ============================================================
// FileHistoryManager (Phase 3.3)
//
// Records a snapshot of each file's content immediately before
// a FileWrite or FileEdit tool writes to it.  This allows the
// renderer to offer a "Revert" button on each ToolCard so the
// user can undo individual AI writes within a session.
//
// Storage: in-memory only (entries are lost on app restart).
// ============================================================

/** Maximum total snapshots retained across all files. */
const MAX_ENTRIES = 50

export interface FileHistoryEntry {
  /** Absolute path of the file that was snapshotted. */
  filePath: string
  /** File content BEFORE the write. Empty string if file did not exist. */
  content: string
  /** Unix ms timestamp of when the snapshot was taken. */
  timestamp: number
  /** ID of the tool call that triggered the write (correlates with ToolCard). */
  toolCallId: string
}

export class FileHistoryManager {
  private entries: FileHistoryEntry[] = []

  /**
   * Read the current on-disk content of filePath and store it as a
   * pre-write snapshot tagged with toolCallId.
   *
   * If the file does not exist yet (new file being created), the snapshot
   * stores an empty string so that revert effectively deletes the file
   * content (the revert handler writes the empty string back).
   *
   * Called by AgentLoop.executeToolCore before FileWrite / FileEdit runs.
   */
  async snapshot(filePath: string, toolCallId: string): Promise<void> {
    let content = ''
    try {
      content = await fs.readFile(filePath, 'utf-8')
    } catch {
      // File does not exist yet — snapshot empty string
    }

    this.entries.push({ filePath, content, timestamp: Date.now(), toolCallId })

    // Cap memory usage
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES)
    }
  }

  /**
   * Look up a snapshot by the tool call ID that created it.
   * Returns undefined if no snapshot was recorded for this call.
   */
  getByToolCallId(toolCallId: string): FileHistoryEntry | undefined {
    return this.entries.find((e) => e.toolCallId === toolCallId)
  }

  /**
   * Return all snapshots for a given file, most recent first.
   * Used by the IPC handler that lets the renderer browse file history.
   */
  getEntriesForFile(filePath: string): FileHistoryEntry[] {
    return this.entries.filter((e) => e.filePath === filePath).reverse()
  }

  /**
   * Clear all recorded history (call on session reset).
   */
  clear(): void {
    this.entries = []
  }
}
