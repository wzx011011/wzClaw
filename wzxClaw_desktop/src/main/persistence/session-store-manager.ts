// ============================================================
// SessionStoreManager — SessionStore 的集中管理与缓存
// 消除散落在各处的 new SessionStore(primaryRoot) 调用
// ============================================================

import { SessionStore } from './session-store'
import type { WorkspaceManager } from '../workspace/workspace-manager'
import type { WorkspaceStore } from '../tasks/workspace-store'

/**
 * 解析工作区根路径。
 * 统一 "从 activeWorkspaceId 解析文件系统路径" 的逻辑，
 * 之前在 ipc-handlers.ts 和 mobile-relay-handler.ts 中重复 9+ 次。
 */
export function resolveWorkspaceRoot(
  activeWorkspaceId: string | undefined,
  workspaceManager: WorkspaceManager,
  workspaceStore: WorkspaceStore,
): Promise<string> {
  const fallback = workspaceManager.getWorkspaceRoot() ?? process.cwd()
  if (!activeWorkspaceId) return Promise.resolve(fallback)
  return workspaceStore.getWorkspace(activeWorkspaceId)
    .then(w => w?.projects[0]?.path ?? fallback)
    .catch(() => fallback)
}

/**
 * SessionStore 的集中管理器。
 * 按 workspaceRoot 缓存实例，避免重复 mkdirSync。
 */
export class SessionStoreManager {
  private cache = new Map<string, SessionStore>()

  /**
   * 获取指定 workspaceRoot 对应的 SessionStore（缓存实例）。
   */
  getForRoot(workspaceRoot: string): SessionStore {
    let store = this.cache.get(workspaceRoot)
    if (!store) {
      store = new SessionStore(workspaceRoot)
      this.cache.set(workspaceRoot, store)
    }
    return store
  }

  /**
   * 从 activeWorkspaceId 解析并返回对应的 SessionStore。
   * 合并 resolveWorkspaceRoot + getForRoot 两步操作。
   */
  async getForWorkspace(
    activeWorkspaceId: string | undefined,
    workspaceManager: WorkspaceManager,
    workspaceStore: WorkspaceStore,
  ): Promise<SessionStore> {
    const root = await resolveWorkspaceRoot(activeWorkspaceId, workspaceManager, workspaceStore)
    return this.getForRoot(root)
  }

  /**
   * 清除缓存（工作区切换时调用）。
   */
  clear(): void {
    this.cache.clear()
  }
}
