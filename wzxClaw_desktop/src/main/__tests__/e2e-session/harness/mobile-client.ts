// ============================================================
// L4 E2E Harness — Mobile Client (TypeScript)
// ============================================================
// A minimal WS client that mimics the Android wzxClaw_android
// connection_manager + chat_store projection layer.
//
// Purpose:
//   - Connect to a local test relay as `role=mobile`
//   - Send protocol events (command:send, session:list, etc.)
//   - Project incoming `stream:agent:*` events into a chatStore
//   - Expose chatStore for test assertions
//
// The protocol is the exact JSON `{event, data}` envelope used in
// production, so this harness validates the wire format end-to-end.
// ============================================================

import WebSocket from 'ws'
import { EventEmitter } from 'events'

export interface MobileChatMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  content: string
  timestamp: number
  sessionId?: string
  toolCallId?: string
  toolName?: string
  isError?: boolean
}

export interface ProtocolMessage<T = unknown> {
  event: string
  data: T
}

interface MobileClientOptions {
  url: string
  token: string
  /** Optional fixed deviceId for multi-mobile scenarios (S6) */
  deviceId?: string
}

/** Lightweight in-memory projection — mirrors Android `ChatStore`. */
export class MobileChatStore {
  private bySession = new Map<string, MobileChatMessage[]>()

  append(sessionId: string, msg: MobileChatMessage): void {
    if (!this.bySession.has(sessionId)) this.bySession.set(sessionId, [])
    this.bySession.get(sessionId)!.push({ ...msg, sessionId })
  }

  /** Replace history for a session (used on session:load). */
  replace(sessionId: string, msgs: MobileChatMessage[]): void {
    this.bySession.set(
      sessionId,
      msgs.map((m) => ({ ...m, sessionId })),
    )
  }

  get(sessionId: string): MobileChatMessage[] {
    return [...(this.bySession.get(sessionId) ?? [])]
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId)
  }

  allSessions(): string[] {
    return [...this.bySession.keys()]
  }
}

export class MobileClient extends EventEmitter {
  private ws: WebSocket | null = null
  private connected = false
  private opts: MobileClientOptions
  readonly chatStore = new MobileChatStore()
  /** Buffer of every protocol message received, in order. */
  readonly inbox: ProtocolMessage[] = []
  /** Streaming text being accumulated for the current assistant turn, by sessionId. */
  private streamingText = new Map<string, { content: string; ts: number }>()

  constructor(opts: MobileClientOptions) {
    super()
    this.opts = opts
  }

  async connect(timeoutMs = 3000): Promise<void> {
    const fullUrl = `${this.opts.url.replace(/\/$/, '')}/?role=mobile&token=${encodeURIComponent(this.opts.token)}`
    this.ws = new WebSocket(fullUrl, [`wzxclaw-${this.opts.token}`])

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mobile connect timeout')), timeoutMs)
      this.ws!.once('open', () => {
        clearTimeout(timer)
        this.connected = true
        resolve()
      })
      this.ws!.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

    this.ws.on('message', (raw) => this._onMessage(raw.toString()))
    this.ws.on('close', () => {
      this.connected = false
      this.emit('close')
    })
  }

  private _onMessage(raw: string): void {
    let parsed: ProtocolMessage
    try {
      parsed = JSON.parse(raw) as ProtocolMessage
    } catch {
      return
    }
    this.inbox.push(parsed)
    this.emit('message', parsed)
    this.emit(`event:${parsed.event}`, parsed.data)
    this._project(parsed)
  }

  /** Project relevant stream events into chatStore (mirror Android logic). */
  private _project(msg: ProtocolMessage): void {
    const data = msg.data as Record<string, unknown> | undefined
    const sessionId = data?.sessionId as string | undefined
    if (!sessionId) return

    switch (msg.event) {
      case 'stream:agent:text': {
        const cur = this.streamingText.get(sessionId) ?? { content: '', ts: Date.now() }
        cur.content += String(data?.content ?? '')
        this.streamingText.set(sessionId, cur)
        break
      }
      case 'stream:agent:tool_call': {
        this.chatStore.append(sessionId, {
          role: 'tool_call',
          content: String(data?.input ? JSON.stringify(data.input) : ''),
          timestamp: Date.now(),
          toolCallId: data?.toolCallId as string,
          toolName: data?.toolName as string,
        })
        break
      }
      case 'stream:agent:tool_result': {
        this.chatStore.append(sessionId, {
          role: 'tool_result',
          content: String(data?.output ?? ''),
          timestamp: Date.now(),
          toolCallId: data?.toolCallId as string,
          toolName: data?.toolName as string,
          isError: data?.isError as boolean,
        })
        break
      }
      case 'stream:agent:turn_end':
      case 'stream:agent:done': {
        const buffered = this.streamingText.get(sessionId)
        if (buffered && buffered.content) {
          this.chatStore.append(sessionId, {
            role: 'assistant',
            content: buffered.content,
            timestamp: buffered.ts,
          })
          this.streamingText.delete(sessionId)
        }
        break
      }
    }
  }

  /** Send `command:send` to trigger a desktop agent run for a user prompt. */
  async sendUserMessage(args: {
    sessionId: string
    content: string
    /** If desktop runs the persist+broadcast flow, the desktop side will append the user message itself. */
    appendLocally?: boolean
    activeWorkspaceId?: string | null
    timestamp?: number
  }): Promise<void> {
    const ts = args.timestamp ?? Date.now()
    if (args.appendLocally !== false) {
      this.chatStore.append(args.sessionId, {
        role: 'user',
        content: args.content,
        timestamp: ts,
      })
    }
    this._send({
      event: 'command:send',
      data: {
        sessionId: args.sessionId,
        content: args.content,
        activeWorkspaceId: args.activeWorkspaceId ?? null,
        timestamp: ts,
      },
    })
  }

  /** Send any custom protocol message. */
  send(event: string, data: unknown): void {
    this._send({ event, data })
  }

  private _send(msg: ProtocolMessage): void {
    if (!this.ws || !this.connected) throw new Error('mobile client not connected')
    this.ws.send(JSON.stringify(msg))
  }

  /** Wait for a specific event by name; resolves with that event's data. */
  waitForEvent<T = unknown>(eventName: string, timeoutMs = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(`event:${eventName}`, handler)
        reject(new Error(`Mobile timeout waiting for ${eventName}`))
      }, timeoutMs)
      const handler = (data: T) => {
        clearTimeout(timer)
        resolve(data)
      }
      this.once(`event:${eventName}`, handler as (...args: unknown[]) => void)
    })
  }

  /** Wait for `stream:agent:done` for a specific sessionId. */
  async waitForDone(sessionId: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const data = await this.waitForEvent<{ sessionId?: string }>(
        'stream:agent:done',
        deadline - Date.now(),
      )
      if (!sessionId || data?.sessionId === sessionId) return
    }
    throw new Error(`Timeout waiting for done on session ${sessionId}`)
  }

  async close(): Promise<void> {
    if (!this.ws) return
    return new Promise<void>((resolve) => {
      this.ws!.once('close', () => resolve())
      this.ws!.close()
      // Force resolve after 1s if close hangs
      setTimeout(() => resolve(), 1000)
    })
  }

  /**
   * Force-disconnect the underlying socket without resetting chatStore/inbox.
   * Used by S5 (disconnect mid-stream and reconnect later).
   */
  async forceDisconnect(): Promise<void> {
    if (!this.ws) return
    const sock = this.ws
    return new Promise<void>((resolve) => {
      const onClose = () => {
        this.connected = false
        resolve()
      }
      sock.once('close', onClose)
      sock.terminate()
      setTimeout(() => resolve(), 500)
    })
  }

  /** Reconnect with the same options. Preserves chatStore (same instance). */
  async reconnect(timeoutMs = 3000): Promise<void> {
    this.ws = null
    await this.connect(timeoutMs)
  }

  /** Issue a session:load:request and resolve with the returned messages. */
  async loadSessionHistory(sessionId: string, timeoutMs = 3000): Promise<unknown[]> {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const wait = new Promise<unknown[]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Mobile timeout waiting for session:load:response (req=${requestId})`)),
        timeoutMs,
      )
      const handler = (data: unknown) => {
        const d = data as { requestId?: string; sessionId?: string; messages?: unknown[] }
        if (d.requestId === requestId && d.sessionId === sessionId) {
          clearTimeout(timer)
          this.off('event:session:load:response', handler as never)
          resolve(d.messages ?? [])
        }
      }
      this.on('event:session:load:response', handler as never)
    })
    this._send({ event: 'session:load:request', data: { requestId, sessionId } })
    return wait
  }
}
