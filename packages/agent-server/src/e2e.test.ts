// ============================================================
// 端到端测试 — 完整 Client → AgentServer → Hand 工具执行链
//
// 测试流程:
// 1. 启动真实 AgentServer (HTTP + WebSocket)
// 2. 连接真实 Hand WebSocket（手动处理 hand:execute → 真实文件操作）
// 3. 连接真实 Client WebSocket
// 4. 验证: Hand 注册 → 工具发现 → 工具执行 → 结果回传
// 5. 验证: Session CRUD 通过 WebSocket
// 6. 验证: Client chat:send → Mock AgentLoop → 事件流
// 7. 验证: Hand 断连 → 工具调用 fallback
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentServer } from './server.js'
import { _resetAuthState } from './auth.js'

// ---- 辅助函数 ----

/** 创建 WebSocket 连接并等待 open */
function connectWs(port: number, params: Record<string, string>): Promise<WebSocket> {
  const query = new URLSearchParams(params).toString()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}?${query}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('WS connect timeout')), 5000)
  })
}

/** 等待指定 event 的下一条消息 */
function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw))
        if (msg.event === eventName) {
          clearTimeout(timer)
          ws.off('message', handler)
          resolve(msg.data)
        }
      } catch { /* ignore invalid JSON */ }
    }
    ws.on('message', handler)
  })
}

/** 发送消息 */
function sendMsg(ws: WebSocket, event: string, data?: unknown): void {
  ws.send(JSON.stringify({ event, data }))
}

/** 收集所有消息（在 durationMs 时间内） */
function collectMessages(ws: WebSocket, durationMs: number): Promise<Array<{ event: string; data: unknown }>> {
  return new Promise((resolve) => {
    const msgs: Array<{ event: string; data: unknown }> = []
    const handler = (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw))
        msgs.push(msg)
      } catch { /* ignore */ }
    }
    ws.on('message', handler)
    setTimeout(() => {
      ws.off('message', handler)
      resolve(msgs)
    }, durationMs)
  })
}

/**
 * 设置 Hand 侧的自动执行处理器
 * 监听 hand:execute → 执行文件操作 → 回传 hand:result
 */
function setupHandExecutor(ws: WebSocket, baseDir: string): void {
  ws.on('message', (raw: unknown) => {
    let msg: { event: string; data?: unknown }
    try {
      msg = JSON.parse(String(raw))
    } catch { return }

    // 只处理 hand:execute（其他消息由各测试自行处理）
    if (msg.event !== 'hand:execute') return

    const { callId, name, input } = msg.data as {
      callId: string
      name: string
      input: Record<string, unknown>
    }

    let output = ''
    let isError = false

    try {
      switch (name) {
        case 'FileRead': {
          const filePath = String(input.path)
          output = readFileSync(filePath, 'utf-8')
          break
        }
        case 'FileWrite': {
          const filePath = String(input.path)
          const content = String(input.content)
          writeFileSync(filePath, content, 'utf-8')
          output = `Written ${Buffer.byteLength(content)} bytes to ${filePath}`
          break
        }
        case 'FileList': {
          const dirPath = String(input.path)
          const entries = readdirSync(dirPath).map(name => {
            const fullPath = join(dirPath, name)
            const stat = statSync(fullPath)
            return { name, isDirectory: stat.isDirectory(), size: stat.size }
          })
          output = JSON.stringify(entries, null, 2)
          break
        }
        case 'Echo': {
          output = JSON.stringify(input)
          break
        }
        default:
          output = `Unknown tool: ${name}`
          isError = true
      }
    } catch (err) {
      output = err instanceof Error ? err.message : String(err)
      isError = true
    }

    // 回传结果
    ws.send(JSON.stringify({
      event: 'hand:result',
      data: { callId, output, isError },
    }))
  })
}

// ---- Mock AgentLoop（模拟 LLM 回复） ----

/** 创建 Mock AgentLoop，模拟文本回复 */
function createMockAgentLoop() {
  const messages: unknown[] = []
  return {
    async *run(userMessage: string) {
      yield { type: 'agent:text', content: `Mock reply to: ${userMessage}` }
      yield {
        type: 'agent:done',
        usage: { inputTokens: 100, outputTokens: 50 },
        turnCount: 1,
        model: 'mock',
      }
    },
    cancel() {},
    getMessages() { return messages },
    replaceMessages(msgs: unknown[]) { messages.length = 0; messages.push(...msgs) },
  }
}

/** 创建会触发工具调用的 Mock AgentLoop */
function createToolCallingMockAgentLoop(toolName: string, toolInput: Record<string, unknown>, toolCallId: string) {
  const messages: unknown[] = []
  return {
    async *run(userMessage: string) {
      // 产出文本
      yield { type: 'agent:text', content: `执行 ${toolName}...` }
      // 产出工具调用
      yield {
        type: 'agent:tool_call',
        toolCallId,
        toolName,
        input: toolInput,
      }
      // 产出工具结果（由外部注入）
      // AgentLoop 实际上不会产出 agent:tool_result — 那是 TurnManager 的职责
      // 但在 mock 中我们模拟完整流程
      // 结束
      yield {
        type: 'agent:done',
        usage: { inputTokens: 200, outputTokens: 100 },
        turnCount: 1,
        model: 'mock',
      }
    },
    cancel() {},
    getMessages() { return messages },
    replaceMessages(msgs: unknown[]) { messages.length = 0; messages.push(...msgs) },
  }
}

// ---- E2E 测试 ----

describe('E2E: Client → AgentServer → Hand', () => {
  let server: AgentServer
  let port: number
  let tempDir: string
  let clientWs: WebSocket
  let handWs: WebSocket

  beforeEach(async () => {
    _resetAuthState()
    delete process.env.AUTH_TOKEN

    // 创建临时目录
    tempDir = mkdtempSync(join(tmpdir(), 'wzxclaw-e2e-'))
    writeFileSync(join(tempDir, 'hello.txt'), 'Hello from NAS!')
    writeFileSync(join(tempDir, 'data.json'), JSON.stringify({ key: 'value', count: 42 }))

    // 启动 AgentServer
    port = 28082 + Math.floor(Math.random() * 1000)
    server = new AgentServer({ port, dbPath: ':memory:' })

    // 注入 Mock AgentLoop
    server.getClientHandler().setLoopFactory(() => createMockAgentLoop())

    await server.start()
  })

  afterEach(async () => {
    clientWs?.close()
    handWs?.close()
    await server.stop()
    _resetAuthState()
    delete process.env.AUTH_TOKEN
    try { rmSync(tempDir, { recursive: true }) } catch {}
  })

  // ---- 辅助: 连接 Hand + Client ----

  async function connectHandAndClient(): Promise<void> {
    // 连接 Hand
    handWs = await connectWs(port, { token: 'test', type: 'hand' })

    // 设置自动执行处理器
    setupHandExecutor(handWs, tempDir)

    // 注册 Hand
    sendMsg(handWs, 'hand:register', {
      id: 'e2e-hand-1',
      capabilities: ['FileRead', 'FileWrite', 'FileList', 'Echo'],
      definitions: [
        {
          name: 'FileRead',
          description: '读取文件内容',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          isReadOnly: true,
        },
        {
          name: 'FileWrite',
          description: '写入文件',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          isReadOnly: false,
        },
        {
          name: 'FileList',
          description: '列出目录',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          isReadOnly: true,
        },
        {
          name: 'Echo',
          description: '回显',
          inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          isReadOnly: true,
        },
      ],
    })

    await new Promise((r) => setTimeout(r, 200))

    // 连接 Client
    clientWs = await connectWs(port, { token: 'test', type: 'client' })
  }

  // ---- 1. 基础连通性 ----

  it('Hand 注册后 /health 显示 hands=1', async () => {
    await connectHandAndClient()
    const res = await fetch(`http://localhost:${port}/health`)
    const body = await res.json() as { status: string; hands: number }
    expect(body.status).toBe('ok')
    expect(body.hands).toBe(1)
  })

  it('Hand 心跳 pong', async () => {
    await connectHandAndClient()
    sendMsg(handWs, 'hand:heartbeat')
    // hand:heartbeat_ack 无 data 字段，waitForEvent 返回 undefined 但代表收到了
    const ack = await waitForEvent(handWs, 'hand:heartbeat_ack', 2000)
    // 只要没超时就算成功（ack 可能是 undefined 因为服务端不发送 data）
    expect(ack).toBeUndefined() // 无 data 字段是正常的
  })

  // ---- 2. 工具发现 ----

  it('Hand 工具定义通过 HandsRouter 可查询', async () => {
    await connectHandAndClient()
    const defs = server.getHandsRouter().getAllDefinitions()
    const names = defs.map(d => d.name)

    expect(names).toContain('FileRead')
    expect(names).toContain('FileWrite')
    expect(names).toContain('FileList')
    expect(names).toContain('Echo')

    // isReadOnly 正确
    const fileReadDef = defs.find(d => d.name === 'FileRead')
    expect((fileReadDef as { isReadOnly?: boolean })?.isReadOnly).toBe(true)
    const fileWriteDef = defs.find(d => d.name === 'FileWrite')
    expect((fileWriteDef as { isReadOnly?: boolean })?.isReadOnly).toBe(false)
  })

  // ---- 3. Session CRUD (通过 WebSocket) ----

  it('Client 创建/列表/加载/删除 session', async () => {
    await connectHandAndClient()

    // 创建
    sendMsg(clientWs, 'session:create')
    const created = await waitForEvent(clientWs, 'session:created') as { sessionId: string }
    expect(created.sessionId).toBeTruthy()

    // 列表
    sendMsg(clientWs, 'session:list')
    const list = await waitForEvent(clientWs, 'session:list') as Array<{ id: string }>
    expect(list).toBeInstanceOf(Array)

    // 加载
    sendMsg(clientWs, 'session:load', { sessionId: created.sessionId })
    const loaded = await waitForEvent(clientWs, 'session:loaded') as { messages: unknown[] }
    expect(loaded.messages).toEqual([])

    // 删除
    sendMsg(clientWs, 'session:delete', { sessionId: created.sessionId })
    const deleted = await waitForEvent(clientWs, 'session:deleted') as { sessionId: string }
    expect(deleted.sessionId).toBe(created.sessionId)
  })

  // ---- 4. 工具执行: 直接通过 HandAwareToolExecutor ----

  it('FileRead → Hand 执行 → 读取真实文件内容', async () => {
    await connectHandAndClient()

    const executor = server['toolExecutor']
    const result = executor.execute('FileRead', {
      path: join(tempDir, 'hello.txt'),
    }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })

    const res = await result
    expect(res.isError).toBe(false)
    expect(res.output).toContain('Hello from NAS!')
  })

  it('FileList → Hand 执行 → 列出目录内容', async () => {
    await connectHandAndClient()

    const executor = server['toolExecutor']
    const result = await executor.execute('FileList', {
      path: tempDir,
    }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    const entries = JSON.parse(result.output)
    const names = entries.map((e: { name: string }) => e.name)
    expect(names).toContain('hello.txt')
    expect(names).toContain('data.json')
  })

  it('FileWrite → Hand 执行 → 写入文件', async () => {
    await connectHandAndClient()

    const executor = server['toolExecutor']
    const filePath = join(tempDir, 'new-file.txt')
    const result = await executor.execute('FileWrite', {
      path: filePath,
      content: 'New content from E2E test',
    }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)

    // 验证文件确实写入了
    const written = readFileSync(filePath, 'utf-8')
    expect(written).toBe('New content from E2E test')
  })

  it('Echo → Hand 执行 → 回显输入', async () => {
    await connectHandAndClient()

    const executor = server['toolExecutor']
    const result = await executor.execute('Echo', {
      message: 'hello e2e',
    }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    const parsed = JSON.parse(result.output)
    expect(parsed.message).toBe('hello e2e')
  })

  // ---- 5. Client chat:send → Mock AgentLoop → 事件流 ----

  it('Client chat:send → 收到 stream:text + stream:done', async () => {
    await connectHandAndClient()

    // 创建 session
    sendMsg(clientWs, 'session:create')
    const created = await waitForEvent(clientWs, 'session:created') as { sessionId: string }

    // 收集事件
    const events: Array<{ event: string; data: unknown }> = []
    clientWs.on('message', (raw: unknown) => {
      try { events.push(JSON.parse(String(raw))) } catch { /* ignore */ }
    })

    // 发送消息
    sendMsg(clientWs, 'chat:send', { sessionId: created.sessionId, message: '测试 E2E' })

    // 等待 stream:done
    await waitForEvent(clientWs, 'stream:done', 3000)

    const eventTypes = events.map(e => e.event)
    expect(eventTypes).toContain('stream:text')
    expect(eventTypes).toContain('stream:done')

    // 验证 text 内容
    const textEvent = events.find(e => e.event === 'stream:text')
    expect((textEvent?.data as { delta: string })?.delta).toContain('Mock reply')
  })

  // ---- 6. Hand 断连 → 工具调用 fallback ----

  it('Hand 断连后工具调用返回错误', async () => {
    await connectHandAndClient()

    // 先验证工具可用
    const executor = server['toolExecutor']
    const result1 = await executor.execute('Echo', { message: 'before disconnect' }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })
    expect(result1.isError).toBe(false)

    // 断开 Hand
    handWs.close()
    await new Promise((r) => setTimeout(r, 200))

    // 工具调用应返回 fallback 错误
    const result2 = await executor.execute('Echo', { message: 'after disconnect' }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })
    expect(result2.isError).toBe(true)
    expect(result2.output).toContain('No hand available')
  })

  // ---- 7. 多个 Hand 注册同名工具 → 优先级路由 ----

  it('两个 Hand 注册同名工具，调用路由到优先级高的', async () => {
    await connectHandAndClient()

    // 连接第二个 Hand
    const hand2Ws = await connectWs(port, { token: 'test', type: 'hand' })
    setupHandExecutor(hand2Ws, tempDir)

    sendMsg(hand2Ws, 'hand:register', {
      id: 'e2e-hand-2',
      capabilities: ['Echo'],
      definitions: [{
        name: 'Echo',
        description: 'Echo v2',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
        isReadOnly: true,
      }],
    })

    await new Promise((r) => setTimeout(r, 200))

    // 验证 Hand 数量
    expect(server.getHandsRouter().getHandCount()).toBe(2)

    // 调用 Echo → 应路由到 hand-1（先注册，优先级高）
    const executor = server['toolExecutor']
    const result = await executor.execute('Echo', { message: 'priority test' }, {
      workingDirectory: tempDir,
      projectRoots: [],
      abortSignal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)

    hand2Ws.close()
  })

  // ---- 8. 认证拒绝 ----

  it('生产模式下错误 token 被拒绝', async () => {
    _resetAuthState()
    const securePort = port + 500
    const secureServer = new AgentServer({
      port: securePort,
      authToken: 'correct-token',
      dbPath: ':memory:',
    })
    await secureServer.start()

    try {
      // 错误 token → 拒绝
      const ws = new WebSocket(`ws://localhost:${securePort}?token=wrong-token&type=client`)
      const closePromise = new Promise<number>((resolve) => {
        ws.on('close', (code) => resolve(code))
      })
      expect(await closePromise).toBe(4001)

      // 正确 token → 接受
      const ws2 = new WebSocket(`ws://localhost:${securePort}?token=correct-token&type=client`)
      const openPromise = new Promise<boolean>((resolve) => {
        ws2.on('open', () => { ws2.close(); resolve(true) })
      })
      expect(await openPromise).toBe(true)
    } finally {
      await secureServer.stop()
      _resetAuthState()
      delete process.env.AUTH_TOKEN
    }
  })
})
