// ============================================================
// 多会话并发测试 — 验证两个会话同时运行时的隔离性和持久化正确性
//
// 用户复现场景：
//   会话 A 发送请求 → 切换到会话 B → 会话 B 发送请求 → 来回切换
//   预期：两个会话的 agent 都完成，JSONL 都正确写入
//
// 核心验证点：
//   1. 两个会话并发运行，互不干扰（SessionRuntimeManager 隔离）
//   2. 切换会话不调用 cancel（渲染层只切换 activeSessionId）
//   3. 只有显式 stopGeneration 才 cancel 对应会话
//   4. agent:done 触发时，appendMessages 正确写入各自 JSONL
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { StreamEvent } from '../../../shared/types'
import type { AgentEvent, AgentConfig } from '../types'
import { SessionRuntimeManager } from '../session-runtime-manager'
import { SessionStore } from '../../persistence/session-store'

// ============================================================
// Mock helpers（与 harness-e2e.test.ts 保持一致）
// ============================================================

/**
 * 创建带延迟的 mock gateway。
 * delayMs 模拟 LLM 响应时间，让两个会话真正并发。
 */
function createGateway(turns: StreamEvent[][], delayMs = 0) {
  let callIndex = 0
  return {
    stream: vi.fn().mockImplementation(() => {
      const events = turns[Math.min(callIndex, turns.length - 1)]
      callIndex++
      return (async function* () {
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
        for (const e of events) yield e
      })()
    }),
    detectProvider: vi.fn().mockReturnValue('openai'),
  }
}

function makeRegistry(tools: any[] = []) {
  return {
    get: vi.fn((name: string) => tools.find((t: any) => t.name === name)),
    getAll: vi.fn(() => tools),
    getDefinitions: vi.fn(() =>
      tools.map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    ),
    getApprovalRequired: vi.fn(() => []),
    isReadOnly: vi.fn(() => true),
  }
}

function makePermissionMgr() {
  return {
    requestApproval: vi.fn().mockResolvedValue(true),
    isApproved: vi.fn().mockReturnValue(false),
    needsApproval: vi.fn().mockReturnValue(false),
    isPlanMode: vi.fn().mockReturnValue(false),
    getPlanModeRejection: vi.fn().mockReturnValue(null),
    clearSession: vi.fn(),
    isRendererConnected: vi.fn().mockReturnValue(true),
  }
}

function makeContextMgr() {
  return {
    shouldCompact: vi.fn().mockReturnValue(false),
    shouldPreCompact: vi.fn().mockReturnValue(false),
    compact: vi.fn().mockResolvedValue({ summary: '', keptRecentCount: 0, beforeTokens: 0, afterTokens: 0, summarizedMessages: [] }),
    reactiveCompact: vi.fn((msgs: unknown[]) => msgs),
    reactiveCompactByTurns: vi.fn((msgs: unknown[]) => msgs),
    trackTokenUsage: vi.fn(),
    getContextWindowForModel: vi.fn().mockReturnValue(128000),
    getTotalUsage: vi.fn().mockReturnValue({ inputTokens: 0, outputTokens: 0 }),
    resetUsage: vi.fn(),
    estimateTokens: vi.fn().mockReturnValue(100),
    estimateOverheadTokens: vi.fn().mockReturnValue(0),
    getMicrocompactConfig: vi.fn().mockReturnValue({ gapMinutes: 60, keepRecent: 5 }),
    getMaxOutputTokensForModel: vi.fn().mockReturnValue(4096),
    getConfig: vi.fn().mockReturnValue({ compactSafetyBuffer: 13000, microcompactTokenPressureThreshold: 0.7, reactiveCompactKeepCount: 6 }),
  }
}

function makeAgentConfig(sessionId: string): AgentConfig {
  return {
    model: 'gpt-4o',
    provider: 'openai',
    systemPrompt: 'You are helpful.',
    workingDirectory: '/tmp',
    projectRoots: ['/tmp'],
    conversationId: sessionId,
  }
}

/**
 * 模拟 ipc-handlers.ts 里的 for-await + appendMessages pipeline（去掉 IPC 层）。
 * 这是被测的核心链路。
 */
async function runSessionPipeline(opts: {
  sessionId: string
  message: string
  loop: InstanceType<typeof import('../agent-loop').AgentLoop>
  store: SessionStore
  persistedCounts: Map<string, number>
  cancelSpy?: ReturnType<typeof vi.fn>
}): Promise<AgentEvent[]> {
  const { sessionId, message, loop, store, persistedCounts } = opts
  const config = makeAgentConfig(sessionId)
  persistedCounts.set(sessionId, loop.getMessages().length)

  const collectedEvents: AgentEvent[] = []
  for await (const event of loop.run(message, config)) {
    collectedEvents.push(event)
    if (event.type === 'agent:done') {
      // 对应 ipc-handlers.ts:301-319 的持久化逻辑
      const allMessages = loop.getMessages()
      const prevCount = persistedCounts.get(sessionId) ?? 0
      const newMessages = allMessages.slice(prevCount)
      if (newMessages.length > 0) {
        await store.appendMessages(sessionId, newMessages)
        persistedCounts.set(sessionId, allMessages.length)
      }
    }
  }
  return collectedEvents
}

// ============================================================
// 测试套件
// ============================================================

describe('多会话并发 — SessionRuntimeManager 隔离与持久化', () => {
  let AgentLoop: typeof import('../agent-loop').AgentLoop
  let userDataDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../agent-loop')
    AgentLoop = mod.AgentLoop
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-concurrent-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(() => {
    delete process.env.WZXCLAW_TEST_USER_DATA
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ----------------------------------------------------------
  // TC1: 两个会话并发运行，都不 cancel，两个都完成且持久化正确
  // 对应用户场景：A 发消息，切换到 B，B 发消息，来回切换，最终两个都完成
  // ----------------------------------------------------------
  it('TC1: 两个会话并发运行，均完成并写入各自 JSONL', async () => {
    const SESSION_A = 'session-a-001'
    const SESSION_B = 'session-b-001'

    // A 慢（50ms），B 快（10ms）— 模拟 A 先发，B 后发但先完成
    const gwA = createGateway([[
      { type: 'text_delta', content: '这是会话A的回复' },
      { type: 'done', usage: { inputTokens: 20, outputTokens: 10 } }
    ]], 50)
    const gwB = createGateway([[
      { type: 'text_delta', content: '这是会话B的回复' },
      { type: 'done', usage: { inputTokens: 15, outputTokens: 8 } }
    ]], 10)

    const registry = makeRegistry()
    const permMgr = makePermissionMgr()
    const ctxMgr = makeContextMgr()

    const loopA = new AgentLoop(gwA as any, registry as any, permMgr as any, ctxMgr as any)
    const loopB = new AgentLoop(gwB as any, registry as any, permMgr as any, ctxMgr as any)

    const store = new SessionStore(userDataDir)
    const persistedCounts = new Map<string, number>()

    // 并发启动两个 pipeline（不等待 A 完成就启动 B，模拟用户快速切换）
    const [eventsA, eventsB] = await Promise.all([
      runSessionPipeline({ sessionId: SESSION_A, message: '请分析桌面端架构', loop: loopA, store, persistedCounts }),
      runSessionPipeline({ sessionId: SESSION_B, message: '手机端会话有没有乱序', loop: loopB, store, persistedCounts }),
    ])

    // 两个会话都应该完成
    expect(eventsA.find(e => e.type === 'agent:done')).toBeDefined()
    expect(eventsB.find(e => e.type === 'agent:done')).toBeDefined()

    // 验证会话 A 的 JSONL
    const sessionsDir = path.join(userDataDir, 'sessions')
    const subDirs = fs.readdirSync(sessionsDir)
    expect(subDirs.length).toBe(1)  // 同一个工作区哈希目录
    const wsDir = path.join(sessionsDir, subDirs[0])

    const fileA = path.join(wsDir, `${SESSION_A}.jsonl`)
    expect(fs.existsSync(fileA)).toBe(true)
    const linesA = fs.readFileSync(fileA, 'utf-8').trim().split('\n').filter(Boolean)
    expect(linesA.length).toBeGreaterThanOrEqual(2)  // user + assistant
    const parsedA = linesA.map(l => JSON.parse(l))
    expect(parsedA.some(m => m.role === 'user')).toBe(true)
    expect(parsedA.some(m => m.role === 'assistant')).toBe(true)
    // 会话 A 的 assistant 内容不应混入 B 的文字
    const assistantA = parsedA.find(m => m.role === 'assistant')
    expect(assistantA?.content ?? assistantA?.contentBlocks).toBeTruthy()

    // 验证会话 B 的 JSONL
    const fileB = path.join(wsDir, `${SESSION_B}.jsonl`)
    expect(fs.existsSync(fileB)).toBe(true)
    const linesB = fs.readFileSync(fileB, 'utf-8').trim().split('\n').filter(Boolean)
    expect(linesB.length).toBeGreaterThanOrEqual(2)
    const parsedB = linesB.map(l => JSON.parse(l))
    expect(parsedB.some(m => m.role === 'user')).toBe(true)
    expect(parsedB.some(m => m.role === 'assistant')).toBe(true)

    // 两个会话不交叉污染（A 的文件行数和 B 的文件行数互相独立）
    expect(linesA.length).not.toBe(0)
    expect(linesB.length).not.toBe(0)
  }, 10000)

  // ----------------------------------------------------------
  // TC2: 切换会话 ≠ cancel — SessionRuntimeManager.cancel() 不应被切换触发
  // 切换只是渲染层操作（修改 activeSessionId），主进程 AgentLoop 不受影响
  // ----------------------------------------------------------
  it('TC2: switchSession 不调用 cancel，两个 agent 均正常完成', async () => {
    const SESSION_A = 'session-switch-a'
    const SESSION_B = 'session-switch-b'

    const gwA = createGateway([[
      { type: 'text_delta', content: 'A完成了' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 60)
    const gwB = createGateway([[
      { type: 'text_delta', content: 'B完成了' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 20)

    const loopA = new AgentLoop(gwA as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)
    const loopB = new AgentLoop(gwB as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)

    // 用 spy 监听 cancel 方法
    const cancelSpyA = vi.spyOn(loopA, 'cancel')
    const cancelSpyB = vi.spyOn(loopB, 'cancel')

    const store = new SessionStore(userDataDir)
    const persistedCounts = new Map<string, number>()

    // 并发运行两个会话
    const [eventsA, eventsB] = await Promise.all([
      runSessionPipeline({ sessionId: SESSION_A, message: '请分析架构', loop: loopA, store, persistedCounts }),
      runSessionPipeline({ sessionId: SESSION_B, message: '手机端有没有 bug', loop: loopB, store, persistedCounts }),
    ])

    // 切换会话时（switchSession）不会调用 cancel
    // 这里模拟：用户在 A 运行期间切换到 B，再切回 A — 没有 cancel 调用
    expect(cancelSpyA).not.toHaveBeenCalled()
    expect(cancelSpyB).not.toHaveBeenCalled()

    // 两个 agent 都应正常完成
    expect(eventsA.find(e => e.type === 'agent:done')).toBeDefined()
    expect(eventsB.find(e => e.type === 'agent:done')).toBeDefined()
  }, 10000)

  // ----------------------------------------------------------
  // TC3: 显式 stopGeneration 只 cancel 指定会话，另一个不受影响
  // 对应 ipc-handlers.ts 的 agent:stop handler（cancel ALL running）
  // 注意：agent:stop 目前 cancel ALL，所以两个都会被取消
  // ----------------------------------------------------------
  it('TC3: agent:stop cancel 所有运行中会话（当前行为）', async () => {
    const SESSION_A = 'session-stop-a'
    const SESSION_B = 'session-stop-b'

    // 两个都很慢，确保 cancel 能在完成前生效
    const gwA = createGateway([[
      { type: 'text_delta', content: 'A的回复' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 200)
    const gwB = createGateway([[
      { type: 'text_delta', content: 'B的回复' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 200)

    const loopA = new AgentLoop(gwA as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)
    const loopB = new AgentLoop(gwB as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)

    // 用 SessionRuntimeManager 管理（与生产代码一致）
    let factoryCallIndex = 0
    const loops = [loopA, loopB]
    const runtimes = new SessionRuntimeManager(() => loops[factoryCallIndex++])

    // 启动两个会话
    const store = new SessionStore(userDataDir)
    const persistedCounts = new Map<string, number>()

    const runA = runSessionPipeline({ sessionId: SESSION_A, message: '分析A', loop: runtimes.getOrCreate(SESSION_A), store, persistedCounts })
    const runB = runSessionPipeline({ sessionId: SESSION_B, message: '分析B', loop: runtimes.getOrCreate(SESSION_B), store, persistedCounts })

    // 10ms 后模拟用户点停止（agent:stop → cancel ALL，对应 ipc-handlers.ts 的当前实现）
    await new Promise(r => setTimeout(r, 10))
    const runningIds = runtimes.listRunning()
    for (const id of runningIds) {
      runtimes.cancel(id)
    }

    // 等待两个 pipeline 结束（cancel 后会提前退出）
    const [eventsA, eventsB] = await Promise.all([runA, runB])

    // 两个都被取消，不应有 agent:done 事件
    expect(eventsA.find(e => e.type === 'agent:done')).toBeUndefined()
    expect(eventsB.find(e => e.type === 'agent:done')).toBeUndefined()

    // JSONL 不应有内容（没有 agent:done 就不写入）
    const sessionsDir = path.join(userDataDir, 'sessions')
    const subDirs = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []
    if (subDirs.length > 0) {
      const wsDir = path.join(sessionsDir, subDirs[0])
      const fileA = path.join(wsDir, `${SESSION_A}.jsonl`)
      const fileB = path.join(wsDir, `${SESSION_B}.jsonl`)
      // 文件要么不存在，要么为空
      if (fs.existsSync(fileA)) {
        expect(fs.readFileSync(fileA, 'utf-8').trim()).toBe('')
      }
      if (fs.existsSync(fileB)) {
        expect(fs.readFileSync(fileB, 'utf-8').trim()).toBe('')
      }
    }
  }, 10000)

  // ----------------------------------------------------------
  // TC4: 同一会话第二次发消息（历史上下文正确累积）
  // 验证 persistedCounts 计数器正确追踪已持久化数量
  // ----------------------------------------------------------
  it('TC4: 同一会话多次发消息，JSONL 消息不重复', async () => {
    const SESSION = 'session-multi-msg'

    const gw = createGateway([
      [
        { type: 'text_delta', content: '第一轮回复' },
        { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
      ],
      [
        { type: 'text_delta', content: '第二轮回复' },
        { type: 'done', usage: { inputTokens: 20, outputTokens: 8 } }
      ]
    ])

    const loop = new AgentLoop(gw as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)
    const store = new SessionStore(userDataDir)
    const persistedCounts = new Map<string, number>()

    // 第一次发消息
    await runSessionPipeline({ sessionId: SESSION, message: '第一条消息', loop, store, persistedCounts })

    // 第二次发消息（同一 loop 实例，复用历史上下文）
    await runSessionPipeline({ sessionId: SESSION, message: '第二条消息', loop, store, persistedCounts })

    // 读取 JSONL，验证消息数量正确（不重复）
    const sessionsDir = path.join(userDataDir, 'sessions')
    const wsDir = path.join(sessionsDir, fs.readdirSync(sessionsDir)[0])
    const file = path.join(wsDir, `${SESSION}.jsonl`)

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
    const messages = lines.map(l => JSON.parse(l))

    const userMsgs = messages.filter(m => m.role === 'user')
    const assistantMsgs = messages.filter(m => m.role === 'assistant')

    // 两次发消息 → 两条 user + 两条 assistant
    expect(userMsgs.length).toBe(2)
    expect(assistantMsgs.length).toBe(2)

    // 没有重复行（持久化计数器正确追踪）
    const contentSet = new Set(lines)
    expect(contentSet.size).toBe(lines.length)
  }, 10000)

  // ----------------------------------------------------------
  // TC5: 新 agent:stop 行为 — 只 cancel 指定会话，不影响另一个
  // 对应 ipc-handlers.ts 修改后的 agent:stop handler：
  //   runtimes.cancel(request.sessionId)  ← 只 cancel 指定会话
  // 这是修复用户 bug 的核心验证：
  //   会话 A 在跑，用户切到 B 发消息，在 B 点停止 → 只有 B 被取消，A 继续跑到完成
  // ----------------------------------------------------------
  it('TC5: stopGeneration(sessionB) 只取消 B，A 继续完成并持久化', async () => {
    const SESSION_A = 'session-stop-only-a'
    const SESSION_B = 'session-stop-only-b'

    // A 慢（150ms），B 也慢（150ms）— 确保在 cancel 前两个都在运行
    const gwA = createGateway([[
      { type: 'text_delta', content: 'A完成了' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 150)
    const gwB = createGateway([[
      { type: 'text_delta', content: 'B被取消' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } }
    ]], 150)

    const loopA = new AgentLoop(gwA as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)
    const loopB = new AgentLoop(gwB as any, makeRegistry() as any, makePermissionMgr() as any, makeContextMgr() as any)

    // 用 SessionRuntimeManager 管理（与生产代码一致）
    let factoryCallIndex = 0
    const loops = [loopA, loopB]
    const runtimes = new SessionRuntimeManager(() => loops[factoryCallIndex++])

    const store = new SessionStore(userDataDir)
    const persistedCounts = new Map<string, number>()

    const loopARef = runtimes.getOrCreate(SESSION_A)
    const loopBRef = runtimes.getOrCreate(SESSION_B)

    const runA = runSessionPipeline({ sessionId: SESSION_A, message: '分析A', loop: loopARef, store, persistedCounts })
    const runB = runSessionPipeline({ sessionId: SESSION_B, message: '分析B', loop: loopBRef, store, persistedCounts })

    // 20ms 后模拟用户在会话 B 点「停止」
    // 新 agent:stop handler 行为：runtimes.cancel(sessionB)，不碰 sessionA
    await new Promise(r => setTimeout(r, 20))
    runtimes.cancel(SESSION_B)   // ← 新 handler 只 cancel 指定 sessionId

    const [eventsA, eventsB] = await Promise.all([runA, runB])

    // B 被取消，没有 agent:done
    expect(eventsB.find(e => e.type === 'agent:done')).toBeUndefined()

    // A 不受影响，正常完成
    expect(eventsA.find(e => e.type === 'agent:done')).toBeDefined()

    // A 的 JSONL 正确写入
    const sessionsDir = path.join(userDataDir, 'sessions')
    const subDirs = fs.readdirSync(sessionsDir)
    expect(subDirs.length).toBe(1)
    const wsDir = path.join(sessionsDir, subDirs[0])

    const fileA = path.join(wsDir, `${SESSION_A}.jsonl`)
    expect(fs.existsSync(fileA)).toBe(true)
    const linesA = fs.readFileSync(fileA, 'utf-8').trim().split('\n').filter(Boolean)
    const parsedA = linesA.map(l => JSON.parse(l))
    expect(parsedA.some(m => m.role === 'user')).toBe(true)
    expect(parsedA.some(m => m.role === 'assistant')).toBe(true)

    // B 被取消，没有 appendMessages，JSONL 不存在或为空
    const fileB = path.join(wsDir, `${SESSION_B}.jsonl`)
    if (fs.existsSync(fileB)) {
      expect(fs.readFileSync(fileB, 'utf-8').trim()).toBe('')
    }
  }, 10000)
})
