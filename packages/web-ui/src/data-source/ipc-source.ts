// ============================================================
// IpcDataSource — Electron Native Capability Bridge
//
// 仅提供桌面端 native 能力（fs/terminal/preview/settings）。
// Session/Chat/Workspace 等业务操作统一通过 agent-server WebSocket。
// ============================================================

import type {
  DataSource,
  SessionMeta,
  SessionConfig,
  RawMessage,
  Settings,
  Workspace,
  RuntimeCapabilities,
  FsChannel,
  FileTreeNode,
  FileWatchEvent,
  TerminalChannel,
  TerminalSpawnOptions,
  PreviewChannel,
} from './types'

/**
 * window.wzxclaw 的类型声明（preload API）
 *
 * 只声明 native capability 方法。
 */
interface WzxClawApi {
  // Settings
  getSettings: () => Promise<Settings>
  updateSettings: (request: Partial<Settings>) => Promise<void>

  // FS
  fsReadFile: (request: { path: string }) => Promise<{ content: string }>
  fsWriteFile: (request: { path: string; content: string }) => Promise<void>
  fsTree: (request: { dirPath: string; depth?: number }) => Promise<{ nodes: FileTreeNode[] }>
  onFsWatch: (cb: (payload: { events: FileWatchEvent[] }) => void) => () => void
  fsWatchStart: (request: { path: string }) => Promise<void>
  fsWatchStop: (request: { path: string }) => Promise<void>

  // Terminal
  terminalSpawn: (request: TerminalSpawnOptions) => Promise<{ terminalId: string }>
  terminalWrite: (request: { terminalId: string; data: string }) => Promise<void>
  terminalResize: (request: { terminalId: string; cols: number; rows: number }) => Promise<void>
  terminalKill: (request: { terminalId: string }) => Promise<void>
  onTerminalData: (cb: (payload: { terminalId: string; data: string }) => void) => () => void
  onTerminalExit: (cb: (payload: { terminalId: string; exitCode: number }) => void) => () => void

  // Preview
  previewOpen: (request: { url: string }) => Promise<void>
  previewReload: () => Promise<void>
  onPreviewUrlChange: (cb: (payload: { url: string | null }) => void) => () => void
}

declare global {
  interface Window {
    wzxclaw?: WzxClawApi
  }
}

/**
 * IpcDataSource — Electron native capability bridge
 *
 * 只提供 fs/terminal/preview/settings。
 * Session/Chat/Workspace 操作由 WebSocketDataSource 通过 agent-server 处理。
 */
export class IpcDataSource implements DataSource {
  readonly capabilities: RuntimeCapabilities = {
    workspace: false,
    fs: true,
    terminal: true,
    preview: true,
    tools: false,
    permission: false,
    mcp: false,
    skills: false,
    plugins: false,
    hosts: false,
    indexing: false,
    insights: false,
    browser: false,
    notifications: false,
  }

  private _available: boolean
  private readonly _connectionListeners = new Set<(connected: boolean) => void>()

  constructor() {
    this._available = typeof window !== 'undefined' && !!window.wzxclaw

    if (this._available) {
      this.fs = this._createFsChannel()
      this.terminal = this._createTerminalChannel()
      this.preview = this._createPreviewChannel()
    }
  }

  readonly fs?: FsChannel
  readonly terminal?: TerminalChannel
  readonly preview?: PreviewChannel

  // ---- 连接生命周期 ----

  async connect(): Promise<void> {
    if (!window.wzxclaw) {
      throw new Error('Electron preload API 不可用：window.wzxclaw 未定义')
    }
    this._available = true
    this._notifyConnectionChange(true)
  }

  disconnect(): void {
    this._available = false
    this._notifyConnectionChange(false)
  }

  isConnected(): boolean {
    return this._available
  }

  onConnectionChange(callback: (connected: boolean) => void): () => void {
    this._connectionListeners.add(callback)
    return () => {
      this._connectionListeners.delete(callback)
    }
  }

  // ---- 设置 ----

  async getSettings(): Promise<Settings> {
    this._ensureAvailable()
    return window.wzxclaw!.getSettings()
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    this._ensureAvailable()
    await window.wzxclaw!.updateSettings(settings)
  }

  // ---- Session/Chat/Workspace — 由 agent-server 处理，本地 IPC 不提供 ----

  async sendMessage(): Promise<void> { throw new Error('Use WebSocketDataSource for chat') }
  async stopGeneration(): Promise<void> { throw new Error('Use WebSocketDataSource') }
  onStreamEvent(): () => void { return () => {} }
  async listSessions(): Promise<SessionMeta[]> { return [] }
  async loadSession(): Promise<RawMessage[]> { return [] }
  async createSession(): Promise<string> { throw new Error('Use WebSocketDataSource') }
  async deleteSession(): Promise<void> { throw new Error('Use WebSocketDataSource') }
  async renameSession(): Promise<void> { throw new Error('Use WebSocketDataSource') }
  async getSessionConfig(): Promise<SessionConfig | null> { return null }
  async updateSessionConfig(): Promise<SessionConfig> { throw new Error('Use WebSocketDataSource') }
  async listWorkspaces(): Promise<Workspace[]> { return [] }
  async getWorkspace(): Promise<Workspace | null> { return null }
  async createWorkspace(): Promise<Workspace> { throw new Error('Use WebSocketDataSource') }
  async updateWorkspace(): Promise<Workspace> { throw new Error('Use WebSocketDataSource') }
  async deleteWorkspace(): Promise<void> { throw new Error('Use WebSocketDataSource') }
  async addWorkspaceProject(): Promise<Workspace> { throw new Error('Use WebSocketDataSource') }
  async removeWorkspaceProject(): Promise<Workspace> { throw new Error('Use WebSocketDataSource') }

  // ---- 内部方法 ----

  private _ensureAvailable(): void {
    if (!this._available || !window.wzxclaw) {
      throw new Error('Electron preload API 不可用')
    }
  }

  private _notifyConnectionChange(connected: boolean): void {
    for (const cb of this._connectionListeners) {
      try { cb(connected) } catch { /* ignore */ }
    }
  }

  private _createFsChannel(): FsChannel {
    return {
      readFile: async (path: string) => {
        this._ensureAvailable()
        return window.wzxclaw!.fsReadFile({ path })
      },
      writeFile: async (path: string, content: string) => {
        this._ensureAvailable()
        await window.wzxclaw!.fsWriteFile({ path, content })
      },
      tree: async (dirPath: string, depth?: number) => {
        this._ensureAvailable()
        const result = await window.wzxclaw!.fsTree({ dirPath, depth })
        return result.nodes
      },
      watch: (path: string, callback: (events: FileWatchEvent[]) => void) => {
        this._ensureAvailable()
        const unsub = window.wzxclaw!.onFsWatch((payload) => {
          callback(payload.events)
        })
        window.wzxclaw!.fsWatchStart({ path }).catch(() => {})
        return () => {
          unsub()
          window.wzxclaw!.fsWatchStop({ path }).catch(() => {})
        }
      },
    }
  }

  private _createTerminalChannel(): TerminalChannel {
    return {
      spawn: async (options: TerminalSpawnOptions) => {
        this._ensureAvailable()
        const result = await window.wzxclaw!.terminalSpawn(options)
        return result.terminalId
      },
      write: async (terminalId: string, data: string) => {
        this._ensureAvailable()
        await window.wzxclaw!.terminalWrite({ terminalId, data })
      },
      resize: async (terminalId: string, cols: number, rows: number) => {
        this._ensureAvailable()
        await window.wzxclaw!.terminalResize({ terminalId, cols, rows })
      },
      kill: async (terminalId: string) => {
        this._ensureAvailable()
        await window.wzxclaw!.terminalKill({ terminalId })
      },
      onData: (terminalId: string, callback: (data: string) => void) => {
        this._ensureAvailable()
        return window.wzxclaw!.onTerminalData((payload) => {
          if (payload.terminalId === terminalId) callback(payload.data)
        })
      },
      onExit: (terminalId: string, callback: (exitCode: number) => void) => {
        this._ensureAvailable()
        return window.wzxclaw!.onTerminalExit((payload) => {
          if (payload.terminalId === terminalId) callback(payload.exitCode)
        })
      },
    }
  }

  private _createPreviewChannel(): PreviewChannel {
    let currentUrl: string | null = null
    const urlListeners = new Set<(url: string | null) => void>()

    if (window.wzxclaw) {
      window.wzxclaw.onPreviewUrlChange((payload) => {
        currentUrl = payload.url
        for (const cb of urlListeners) {
          try { cb(currentUrl) } catch { /* ignore */ }
        }
      })
    }

    return {
      open: async (url: string) => {
        this._ensureAvailable()
        currentUrl = url
        await window.wzxclaw!.previewOpen({ url })
      },
      reload: async () => {
        this._ensureAvailable()
        await window.wzxclaw!.previewReload()
      },
      getUrl: () => currentUrl,
      onUrlChange: (callback: (url: string | null) => void) => {
        urlListeners.add(callback)
        return () => { urlListeners.delete(callback) }
      },
    }
  }
}
