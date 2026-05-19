// ============================================================
// SessionService — agent-server 会话管理入口
//
// 职责：
// - 会话元数据 / per-session defaults 管理
// - 消息持久化委托给 ISessionStore
// - 运行时状态记录（active run 的轻量快照）
// ============================================================

import { randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  ISessionStore,
  SessionConfig,
  SessionConfigPatch,
  SessionMeta,
  SessionRuntimeState,
} from '@wzxclaw/brain'

export interface CreateSessionInput extends SessionConfigPatch {
  id?: string
}

export class SessionService {
  private readonly runtimeStates = new Map<string, SessionRuntimeState>()

  constructor(private readonly store: ISessionStore) {}

  async createSession(input: CreateSessionInput = {}): Promise<SessionConfig> {
    const id = input.id ?? randomUUID()
    if (this.store.createSession) {
      return this.store.createSession({ ...input, id })
    }

    if (this.store.renameSession) {
      await this.store.renameSession(id, input.title ?? 'Untitled')
    } else {
      await this.store.appendMessage(id, { type: 'meta', title: input.title ?? 'Untitled' })
    }

    return {
      id,
      title: input.title ?? 'Untitled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      owner: input.owner ?? 'nas-remote',
      workspaceId: input.workspaceId,
      model: input.model,
      provider: input.provider,
      targetHandId: input.targetHandId,
      workingDirectory: input.workingDirectory,
      projectRoots: input.projectRoots,
      metadata: input.metadata,
    }
  }

  async listSessions(workspaceId?: string): Promise<SessionMeta[]> {
    const sessions = await this.store.listSessions()
    return sessions
      .filter((session) => !workspaceId || session.workspaceId === workspaceId)
      .map((session) => ({
      ...session,
      isRunning: this.runtimeStates.get(session.id)?.status === 'running',
    }))
  }

  loadMessages(sessionId: string): Promise<unknown[]> {
    return this.store.loadSession(sessionId)
  }

  appendMessage(sessionId: string, message: unknown): Promise<void> {
    return this.store.appendMessage(sessionId, message)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.runtimeStates.delete(sessionId)
    await this.store.deleteSession(sessionId)
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (this.store.renameSession) {
      await this.store.renameSession(sessionId, title)
    }
    if (this.store.updateSessionConfig) {
      await this.store.updateSessionConfig(sessionId, { title })
    }
  }

  async getSessionConfig(sessionId: string): Promise<SessionConfig | null> {
    if (this.store.getSessionConfig) {
      return this.store.getSessionConfig(sessionId)
    }
    const found = (await this.store.listSessions()).find((session) => session.id === sessionId)
    if (!found) return null
    return {
      id: found.id,
      title: found.title,
      createdAt: found.createdAt ?? found.updatedAt,
      updatedAt: found.updatedAt,
      workspaceId: found.workspaceId,
      model: found.model,
      provider: found.provider,
      targetHandId: found.targetHandId,
      owner: found.owner ?? 'nas-remote',
    }
  }

  async updateSessionConfig(sessionId: string, patch: SessionConfigPatch): Promise<SessionConfig> {
    if (this.store.updateSessionConfig) {
      return this.store.updateSessionConfig(sessionId, patch)
    }
    if (patch.title && this.store.renameSession) {
      await this.store.renameSession(sessionId, patch.title)
    }
    return (await this.getSessionConfig(sessionId)) ?? this.createSession({ ...patch, id: sessionId })
  }

  async buildAgentConfig(
    sessionId: string,
    defaults: Partial<Pick<AgentConfig, 'model' | 'provider' | 'workingDirectory' | 'projectRoots'>>,
    overrides: Partial<Pick<AgentConfig, 'targetHandId' | 'model' | 'provider' | 'workingDirectory' | 'projectRoots'>> = {},
  ): Promise<Partial<AgentConfig>> {
    const config = await this.getSessionConfig(sessionId)
    return {
      model: overrides.model ?? config?.model ?? defaults.model,
      provider: overrides.provider ?? config?.provider ?? defaults.provider,
      workingDirectory: overrides.workingDirectory ?? config?.workingDirectory ?? defaults.workingDirectory,
      projectRoots: overrides.projectRoots ?? config?.projectRoots ?? defaults.projectRoots,
      targetHandId: overrides.targetHandId ?? config?.targetHandId,
    }
  }

  startRun(sessionId: string, persistedMessageCount: number): SessionRuntimeState {
    const state: SessionRuntimeState = {
      sessionId,
      status: 'running',
      turnCount: 0,
      persistedMessageCount,
      lastActivityAt: Date.now(),
    }
    this.runtimeStates.set(sessionId, state)
    return state
  }

  finishRun(sessionId: string, turnCount: number, persistedMessageCount: number): SessionRuntimeState {
    const state: SessionRuntimeState = {
      sessionId,
      status: 'idle',
      turnCount,
      persistedMessageCount,
      lastActivityAt: Date.now(),
    }
    this.runtimeStates.set(sessionId, state)
    return state
  }

  getRuntimeState(sessionId: string): SessionRuntimeState | null {
    return this.runtimeStates.get(sessionId) ?? null
  }
}
