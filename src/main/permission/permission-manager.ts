import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipc-channels'

// ============================================================
// PermissionManager (per D-31, D-32, D-33)
// ============================================================

/**
 * Manages tool approval state per conversation.
 * Destructive tools (FileWrite, FileEdit, Bash) require user approval
 * before execution. Once approved for a session, subsequent calls of
 * the same tool type in the same conversation are auto-approved (D-33).
 */
export class PermissionManager {
  private sessionApprovals: Map<string, Set<string>> = new Map()

  /**
   * Check if a tool has been approved in this conversation's session cache.
   */
  isApproved(conversationId: string, toolName: string): boolean {
    const approved = this.sessionApprovals.get(conversationId)
    if (!approved) return false
    return approved.has(toolName)
  }

  /**
   * Request approval from the user for a tool execution.
   * If the tool is already approved in the session cache, returns true immediately.
   * Otherwise, sends an IPC permission request to the renderer and waits for
   * the user's response.
   *
   * @param conversationId - The conversation ID for session tracking
   * @param toolName - The tool name requesting approval
   * @param toolInput - The tool input to display to the user
   * @param sender - The WebContents to send the permission request to
   * @returns Whether the tool execution was approved
   */
  async requestApproval(
    conversationId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    sender: Electron.WebContents
  ): Promise<boolean> {
    // Check session cache first (D-33)
    if (this.isApproved(conversationId, toolName)) {
      return true
    }

    // Send permission request to renderer
    sender.send(IPC_CHANNELS['agent:permission_request'], {
      toolName,
      toolInput,
      reason: `This tool can modify your files. Approve?`
    })

    // Wait for renderer response via ipcMain.handleOnce
    return new Promise<boolean>((resolve) => {
      ipcMain.handleOnce(
        IPC_CHANNELS['agent:permission_response'],
        async (_event, data: { approved: boolean; sessionCache: boolean }) => {
          if (data.approved && data.sessionCache) {
            // Cache approval for this conversation + tool type
            let approved = this.sessionApprovals.get(conversationId)
            if (!approved) {
              approved = new Set()
              this.sessionApprovals.set(conversationId, approved)
            }
            approved.add(toolName)
          }
          resolve(data.approved)
          return data.approved
        }
      )
    })
  }

  /**
   * Clear all cached approvals for a conversation.
   * Called when a conversation ends or is reset.
   */
  clearSession(conversationId: string): void {
    this.sessionApprovals.delete(conversationId)
  }

  /**
   * Check if the renderer is connected.
   * Placeholder — real implementation added in Plan 04.
   */
  isRendererConnected(): boolean {
    return true
  }
}
