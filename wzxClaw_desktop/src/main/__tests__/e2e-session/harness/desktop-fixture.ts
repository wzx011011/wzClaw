// ============================================================
// L4 E2E Harness — Desktop Fixture
// ============================================================
// Scripted desktop-side handler that mirrors src/main/index.ts's
// mobile `command:send` pipeline at the protocol layer.
//
// What it includes (real production code paths):
//   - Real SessionStore (writes JSONL to a temp WZXCLAW_TEST_USER_DATA dir)
//   - Real `persistRuntimeDelta` semantics (incremental append + counter)
//   - Real WS connection to relay as role=desktop
//   - Real protocol envelope `{event, data}`
//
// What is scripted (not loading the full Electron main):
//   - The "runtime" is a fake that produces a pre-defined event sequence
//     per user message, so we can deterministically reproduce flaky bugs
//     without depending on a real LLM API.
// ============================================================

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { SessionStore, type ChatMessageLike } from '../../../persistence/session-store'

export interface ScriptedTurn {
  /** Optional thinking text to emit before tool calls / final text. */
  thinking?: string
  /** Tool calls to execute in this turn. */
  tools?: Array<{
    toolCallId: string
    toolName: string
    input?: unknown
    output: string
    isError?: boolean
    /** ms to wait before result is emitted */
    delayMs?: number
  }>
  /** Final assistant text for this turn. */
  text?: string
  /** If set, throw this error mid-stream (simulates agent:error path) */
  errorAfter?: 'thinking' | 'tools' | 'text'
  /** If set, abort before completing this turn (simulates command:stop) */
  abortAfter?: 'thinking' | 'tools' | 'text'
}

export interface ScriptedScript {
  /** Each entry is one *turn* (one LLM round) within a single user message. */
  turns: ScriptedTurn[]
}

export type ScriptProvider = (args: {
  sessionId: string
  userMessage: string
  /** All prior messages in this runtime (excluding the just-appended user msg) */
  prior: ChatMessageLike[]
  /** Counts how many user messages on this session have triggered a script call (1-indexed) */
  callIndex: number
}) => ScriptedScript

export interface DesktopFixtureOptions {
  url: string
  token: string
  workspaceRoot: string
  /** Provide a script to drive each user message. */
  script: ScriptProvider
}

interface RuntimeState {
  messages: ChatMessageLike[]
  callCount: number
  /** Hold the abort signal for command:stop */
  aborted: boolean
}

const NOW = () => Date.now()
let _msgIdCounter = 0
function nextId(): string {
  _msgIdCounter += 1
  return `m_${Date.now()}_${_msgIdCounter}`
}

/**
 * Desktop-side test fixture. Connects to the relay as role=desktop and
 * services mobile `command:send` requests.
 */
export class DesktopFixture extends EventEmitter {
  private ws: WebSocket | null = null
  private connected = false
  private opts: DesktopFixtureOptions
  readonly sessionStore: SessionStore
  /** Per-session runtimes (in-memory message list, abort flag). */
  private runtimes = new Map<string, RuntimeState>()
  /** Mirror of production's mobilePersistedMessageCounts. */
  private persistedCounts = new Map<string, number>()
  /** Serialise persistence per session (mirror production write lock). */
  private persistLocks = new Map<string, Promise<void>>()

  constructor(opts: DesktopFixtureOptions) {
    super()
    this.opts = opts
    this.sessionStore = new SessionStore(opts.workspaceRoot)
  }

  async connect(timeoutMs = 3000): Promise<void> {
    const fullUrl = `${this.opts.url.replace(/\/$/, '')}/?role=desktop&token=${encodeURIComponent(this.opts.token)}`
    this.ws = new WebSocket(fullUrl, [`wzxclaw-${this.opts.token}`])

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('desktop connect timeout')), timeoutMs)
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
    let parsed: { event: string; data: Record<string, unknown> }
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const { event, data } = parsed
    if (event === 'command:send') {
      void this._handleCommandSend(data)
    } else if (event === 'command:stop') {
      const sid = data?.sessionId as string | undefined
      if (sid) {
        const rt = this.runtimes.get(sid)
        if (rt) rt.aborted = true
      }
    } else if (event === 'session:clear:request') {
      const sid = data?.sessionId as string | undefined
      if (sid) {
        this.runtimes.delete(sid)
        this.persistedCounts.delete(sid) // critical: same as production fix
      }
    } else if (event === 'session:load:request') {
      const requestId = (data?.requestId as string | undefined) ?? ''
      const sid = data?.sessionId as string | undefined
      if (sid) {
        void this.sessionStore
          .loadSession(sid)
          .then((messages) => {
            this.broadcast('session:load:response', { requestId, sessionId: sid, messages })
          })
          .catch((err) => {
            this.broadcast('session:load:response', {
              requestId,
              sessionId: sid,
              messages: [],
              error: err instanceof Error ? err.message : String(err),
            })
          })
      }
    } else if (event === 'session:list:request') {
      const requestId = (data?.requestId as string | undefined) ?? ''
      void this.sessionStore
        .listSessions()
        .then((sessions) => {
          this.broadcast('session:list:response', { requestId, sessions })
        })
        .catch(() => {
          this.broadcast('session:list:response', { requestId, sessions: [] })
        })
    }
  }

  private getRuntime(sessionId: string): RuntimeState {
    let rt = this.runtimes.get(sessionId)
    if (!rt) {
      rt = { messages: [], callCount: 0, aborted: false }
      this.runtimes.set(sessionId, rt)
    }
    return rt
  }

  /** Mirror of production `persistRuntimeDelta`. */
  private async persistRuntimeDelta(sessionId: string, runtime: RuntimeState): Promise<number> {
    const run = async (): Promise<number> => {
      const persistedCount = this.persistedCounts.get(sessionId) ?? 0
      const newMessages = runtime.messages.slice(persistedCount)
      if (newMessages.length > 0) {
        await this.sessionStore.appendMessages(sessionId, newMessages)
        this.persistedCounts.set(sessionId, runtime.messages.length)
      }
      return runtime.messages.length
    }
    const pending = this.persistLocks.get(sessionId) ?? Promise.resolve()
    const next = pending.catch(() => {}).then(run) as Promise<number>
    this.persistLocks.set(sessionId, next.then(() => undefined, () => undefined))
    return next
  }

  private broadcast(event: string, data: unknown): void {
    if (!this.ws || !this.connected) return
    this.ws.send(JSON.stringify({ event, data }))
  }

  private async _handleCommandSend(data: Record<string, unknown>): Promise<void> {
    const sessionId = data?.sessionId as string
    const userContent = data?.content as string
    if (!sessionId || typeof userContent !== 'string') return

    const rt = this.getRuntime(sessionId)
    rt.aborted = false
    rt.callCount += 1
    const priorSnapshot = [...rt.messages]
    rt.messages.push({ role: 'user', content: userContent, timestamp: NOW(), id: nextId() })

    // first-event persist (capture user msg)
    await this.persistRuntimeDelta(sessionId, rt)
    this.broadcast('stream:agent:running_changed', { sessionId, isRunning: true })

    const script = this.opts.script({
      sessionId,
      userMessage: userContent,
      prior: priorSnapshot,
      callIndex: rt.callCount,
    })

    let totalUsage = { inputTokens: 0, outputTokens: 0 }
    try {
      for (let turnIdx = 0; turnIdx < script.turns.length; turnIdx++) {
        const turn = script.turns[turnIdx]
        if (rt.aborted) throw new Error('aborted')

        // -- thinking
        if (turn.thinking) {
          this.broadcast('stream:agent:thinking', { sessionId, content: turn.thinking })
          if (turn.errorAfter === 'thinking') throw new Error('scripted error after thinking')
          if (turn.abortAfter === 'thinking') {
            rt.aborted = true
            throw new Error('aborted')
          }
        }

        // -- tools
        if (turn.tools && turn.tools.length > 0) {
          // Append assistant message containing tool_call blocks (production records this)
          rt.messages.push({
            role: 'assistant',
            content: '',
            timestamp: NOW(),
            id: nextId(),
            toolCalls: turn.tools.map((t) => ({
              id: t.toolCallId,
              name: t.toolName,
              input: t.input ?? {},
            })),
          })
          for (const t of turn.tools) {
            this.broadcast('stream:agent:tool_call', {
              sessionId,
              toolCallId: t.toolCallId,
              toolName: t.toolName,
              input: t.input ?? {},
            })
            if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs))
            this.broadcast('stream:agent:tool_result', {
              sessionId,
              toolCallId: t.toolCallId,
              toolName: t.toolName,
              output: t.output,
              isError: t.isError ?? false,
            })
            rt.messages.push({
              role: 'tool_result',
              content: t.output,
              timestamp: NOW(),
              id: nextId(),
              toolCallId: t.toolCallId,
              isError: t.isError ?? false,
            })
          }
          if (turn.errorAfter === 'tools') throw new Error('scripted error after tools')
          if (turn.abortAfter === 'tools') {
            rt.aborted = true
            throw new Error('aborted')
          }
        }

        // -- final text
        if (turn.text) {
          // Stream text in small chunks to exercise the renderer-side accumulator
          const chunks = chunkString(turn.text, 16)
          for (const c of chunks) {
            this.broadcast('stream:agent:text', { sessionId, content: c })
          }
          rt.messages.push({
            role: 'assistant',
            content: turn.text,
            timestamp: NOW(),
            id: nextId(),
          })
          if (turn.errorAfter === 'text') throw new Error('scripted error after text')
          if (turn.abortAfter === 'text') {
            rt.aborted = true
            throw new Error('aborted')
          }
        }

        totalUsage.inputTokens += 100
        totalUsage.outputTokens += 50

        // turn_end persist
        await this.persistRuntimeDelta(sessionId, rt)
        this.broadcast('stream:agent:turn_end', { sessionId })
      }

      // final done persist (no counter delete — that was the bug!)
      await this.persistRuntimeDelta(sessionId, rt)
      this.broadcast('stream:agent:done', { sessionId, usage: totalUsage })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // best-effort persist tail (mirrors production catch path)
      try {
        await this.persistRuntimeDelta(sessionId, rt)
      } catch {
        // ignore
      }
      this.broadcast('stream:agent:error', {
        sessionId,
        error: message,
        recoverable: false,
      })
    } finally {
      this.broadcast('stream:agent:running_changed', { sessionId, isRunning: false })
      this.persistLocks.delete(sessionId)
    }
  }

  /** Snapshot of in-memory runtime messages for a session (for asserts). */
  runtimeMessages(sessionId: string): ChatMessageLike[] {
    return [...(this.runtimes.get(sessionId)?.messages ?? [])]
  }

  /** Drop a session's runtime entirely (simulate /clear). Also clears counter. */
  dropRuntime(sessionId: string): void {
    this.runtimes.delete(sessionId)
    this.persistedCounts.delete(sessionId)
  }

  async close(): Promise<void> {
    if (!this.ws) return
    return new Promise<void>((resolve) => {
      this.ws!.once('close', () => resolve())
      this.ws!.close()
      setTimeout(() => resolve(), 1000)
    })
  }
}

function chunkString(s: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out.length > 0 ? out : ['']
}
