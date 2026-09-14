// ============================================================
// app-server-engine — ZCode app-server 子进程引擎（v3 M3 Phase-0）
//
// 桌面换芯的地基：以 stdio NDJSON 协议驱动 ZCode 官方 app-server，
// 提供 请求/响应关联（超时兜底）、通知事件、崩溃重启（预算+退避）、
// 优雅停止。语义与 relay/zcode/brain-adapter.js 的 AppServerEngine
// 一致（该 JS 版本已在大脑网络端到端测试中验证）。
//
// 协议事实源：relay/zcode/APP-SERVER.md
// 帧格式：请求 {id, method, params} / 响应 {id, result|error} /
//         通知 {method, params}
// ============================================================

import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

export interface AppServerEngineOptions {
  /** 引擎可执行文件（如 node 或 ZCode CLI 路径） */
  command: string
  /** 追加参数（引擎会自动追加 app-server --cwd <cwd>） */
  args?: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  logger?: (event: string, detail?: string) => void
  /** 崩溃重启预算（默认 10 次） */
  maxRestarts?: number
  /** 重启退避基数 ms（默认 1000，按次数线性递增） */
  restartDelayMs?: number
  /** 单请求默认超时 ms（默认 30000） */
  requestTimeoutMs?: number
}

/** app-server 协议帧 */
export interface AppServerFrame {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number | string; message?: string }
}

interface PendingRequest {
  resolve: (frame: AppServerFrame) => void
  timer: NodeJS.Timeout
}

export class AppServerEngine extends EventEmitter {
  static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30000

  private readonly command: string
  private readonly args: string[]
  private readonly cwd: string
  private readonly env: NodeJS.ProcessEnv | undefined
  private readonly logger: (event: string, detail?: string) => void
  private readonly maxRestarts: number
  private readonly restartDelayMs: number
  private readonly requestTimeoutMs: number

  private child: ChildProcess | null = null
  private buffer = ''
  private restarts = 0
  private stopped = false
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1

  constructor(options: AppServerEngineOptions) {
    super()
    this.command = options.command
    this.args = options.args ?? []
    this.cwd = options.cwd
    this.env = options.env
    this.logger = options.logger ?? (() => {})
    this.maxRestarts = options.maxRestarts ?? 10
    this.restartDelayMs = options.restartDelayMs ?? 1000
    this.requestTimeoutMs = options.requestTimeoutMs ?? AppServerEngine.DEFAULT_REQUEST_TIMEOUT_MS
  }

  /** 引擎子进程是否存活 */
  get running(): boolean {
    return this.child !== null
  }

  /** 已发生的重启次数（测试断言用） */
  get restartCount(): number {
    return this.restarts
  }

  start(): void {
    this.stopped = false
    this.spawnChild()
  }

  private spawnChild(): void {
    const child = spawn(this.command, [...this.args, 'app-server', '--cwd', this.cwd], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    })
    this.child = child
    this.buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.feed(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => this.logger('engine-stderr', chunk.slice(0, 500)))
    child.on('error', (error: NodeJS.ErrnoException) => {
      this.logger('engine-spawn-error', error.code || error.message)
      this.scheduleRestart(`spawn-error:${error.code || error.message}`)
    })
    child.on('exit', (code) => {
      this.child = null
      this.scheduleRestart(`exit=${code}`)
    })
    this.logger('engine-started', '')
  }

  private scheduleRestart(why: string): void {
    if (this.stopped) return
    if (this.child !== null) return
    if (this.restarts >= this.maxRestarts) {
      this.logger('engine-dead', why)
      this.emit('dead', why)
      return
    }
    this.restarts += 1
    const delay = this.restartDelayMs * this.restarts
    const timer = setTimeout(() => {
      if (!this.stopped && this.child === null) this.spawnChild()
    }, delay)
    timer.unref?.()
    this.logger('engine-restart', `delay=${delay} attempt=${this.restarts}`)
  }

  /** 喂入 stdout 文本（按行切 NDJSON；公开便于测试注入） */
  feed(text: string): void {
    this.buffer += text
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let frame: AppServerFrame
      try {
        frame = JSON.parse(line) as AppServerFrame
      } catch {
        this.logger('engine-bad-line', '')
        continue
      }
      const id = frame.id
      if (id !== null && id !== undefined && this.pending.has(id as number)) {
        const entry = this.pending.get(id as number)!
        this.pending.delete(id as number)
        clearTimeout(entry.timer)
        entry.resolve(frame)
        continue
      }
      if (frame.method) this.emit('notification', frame)
    }
  }

  /** 发送请求并等待响应；超时/引擎未运行时以错误帧 resolve（不抛出） */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<AppServerFrame> {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) {
      return Promise.resolve({
        id: -1,
        error: { code: -32000, message: 'engine not running' },
      })
    }
    const id = this.nextId++
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs
    const frame: AppServerFrame = { id, method, ...(params === undefined ? {} : { params }) }
    return new Promise<AppServerFrame>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          resolve({ id, error: { code: -32022, message: `timeout: ${method}` } })
        }
      }, effectiveTimeout)
      this.pending.set(id, { resolve, timer })
      try {
        this.child!.stdin!.write(`${JSON.stringify(frame)}\n`)
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({ id, error: { code: -32000, message: String(error) } })
      }
    })
  }

  /** 成功回合后重置重启预算（长会话不应累积重启计数） */
  resetRestartBudget(): void {
    this.restarts = 0
  }

  /** 优雅停止：杀引擎子进程并清空待决请求 */
  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    this.child = null
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({ error: { code: -32000, message: 'engine stopped' } })
    }
    this.pending.clear()
    if (!child) return
    child.removeAllListeners('exit')
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已退出 */ }
        resolve()
      }, 2000).unref()
      try { child.kill() } catch { resolve() }
    })
  }

  /** 仅测试使用：直接注入一行引擎输出 */
  injectLine(line: string): void {
    this.feed(line.endsWith('\n') ? line : `${line}\n`)
  }
}
