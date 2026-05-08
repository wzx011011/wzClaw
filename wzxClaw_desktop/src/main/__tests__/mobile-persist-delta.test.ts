import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// ============================================================
// P0 回归测试：mobile 同 session 连发不得重复持久化
// ============================================================
// 复现 src/main/index.ts 中 persistRuntimeDelta 的核心逻辑：
//   - 持有 mobilePersistedMessageCounts: Map<sessionId, count>
//   - 每次调用 slice(persistedCount) 后 append 并更新 count
//
// Bug：在 agent:done 时 .delete(sessionId) 导致 counter 归零，
// 而 runtime 仍持有全部历史 → 下一次 send 时 slice(0) 把整段历史重写一遍。
//
// 此测试模拟两次 mobile send 的完整生命周期，断言：
//   1) JSONL 中每条用户消息恰好出现一次
//   2) 三方一致：counter == runtime.length == JSONL.length
//   3) 任意 message 内容/timestamp 在 JSONL 中均无重复
// ============================================================

interface MsgLike {
  role: 'user' | 'assistant' | 'tool_result' | 'tool_call'
  content: string
  timestamp: number
  id?: string
}

class FakeRuntime {
  private messages: MsgLike[] = []
  getMessages(): MsgLike[] {
    return [...this.messages]
  }
  appendUser(content: string, timestamp: number) {
    this.messages.push({ role: 'user', content, timestamp })
  }
  appendAssistant(content: string, timestamp: number) {
    this.messages.push({ role: 'assistant', content, timestamp })
  }
  appendTool(content: string, timestamp: number) {
    this.messages.push({ role: 'tool_result', content, timestamp })
  }
  reset() {
    this.messages = []
  }
}

class FakeJsonlStore {
  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
  }
  appendMessages(messages: MsgLike[]): void {
    if (messages.length === 0) return
    const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n'
    fs.appendFileSync(this.filePath, lines, 'utf-8')
  }
  load(): MsgLike[] {
    if (!fs.existsSync(this.filePath)) return []
    return fs
      .readFileSync(this.filePath, 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as MsgLike)
  }
}

/** 镜像 src/main/index.ts 的 persistRuntimeDelta 行为（去掉 lock，单测同步使用） */
function makePersister(
  store: FakeJsonlStore,
  counters: Map<string, number>,
) {
  return function persistRuntimeDelta(sessionId: string, runtime: FakeRuntime): number {
    const allMsgs = runtime.getMessages()
    const persistedCount = counters.get(sessionId) ?? 0
    const newMessages = allMsgs.slice(persistedCount)
    if (newMessages.length > 0) {
      store.appendMessages(newMessages)
      counters.set(sessionId, allMsgs.length)
    }
    return allMsgs.length
  }
}

describe('mobile persist delta counter — same session, multiple sends', () => {
  let tmpDir: string
  let store: FakeJsonlStore
  let counters: Map<string, number>
  let runtime: FakeRuntime
  let persistDelta: (sessionId: string, runtime: FakeRuntime) => number
  const SESSION_ID = 'sess-test-1'

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-persist-test-'))
    store = new FakeJsonlStore(path.join(tmpDir, `${SESSION_ID}.jsonl`))
    counters = new Map<string, number>()
    runtime = new FakeRuntime()
    persistDelta = makePersister(store, counters)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /** 模拟单次 mobile send 完整生命周期（按修复后代码顺序）: */
  function simulateMobileSend(userText: string, ts: number) {
    runtime.appendUser(userText, ts)
    persistDelta(SESSION_ID, runtime) // first-event 钩子
    runtime.appendAssistant(`reply to ${userText}`, ts + 1)
    persistDelta(SESSION_ID, runtime) // turn_end
    persistDelta(SESSION_ID, runtime) // done
    // 关键：done 路径**不**清除 counter（修复点）
  }

  it('two consecutive sends in the same session must not duplicate the user message', () => {
    simulateMobileSend('用的什么模型', 1778210042120)
    simulateMobileSend('任务什么进展了', 1778210042200)

    const persisted = store.load()
    const userMsgs = persisted.filter((m) => m.role === 'user')

    expect(userMsgs).toHaveLength(2)
    const contents = userMsgs.map((m) => m.content)
    expect(contents).toContain('用的什么模型')
    expect(contents).toContain('任务什么进展了')

    // 整段无重复行
    const seen = new Set<string>()
    for (const m of persisted) {
      const key = `${m.role}|${m.content}|${m.timestamp}`
      expect(seen.has(key), `duplicate message detected: ${key}`).toBe(false)
      seen.add(key)
    }

    // 三方一致：counter == runtime.length == JSONL.length
    expect(counters.get(SESSION_ID)).toBe(runtime.getMessages().length)
    expect(persisted.length).toBe(runtime.getMessages().length)
  })

  it('regression guard: if counter is incorrectly cleared on done, the bug reproduces', () => {
    // 此测试**故意复现** bug，确保我们的修复方向是对的：
    // 当 counter 被错误清零（旧代码行为），第二次 send 会把全部历史重写一遍。
    function buggySend(userText: string, ts: number) {
      runtime.appendUser(userText, ts)
      persistDelta(SESSION_ID, runtime)
      runtime.appendAssistant(`reply to ${userText}`, ts + 1)
      persistDelta(SESSION_ID, runtime)
      persistDelta(SESSION_ID, runtime)
      counters.delete(SESSION_ID) // 旧代码 bug
    }

    buggySend('用的什么模型', 1778210042120)
    buggySend('任务什么进展了', 1778210042200)

    const persisted = store.load()
    const userMsgs = persisted.filter((m) => m.role === 'user' && m.content === '用的什么模型')
    // 旧 bug 行为：第一条用户消息被写入两次
    expect(userMsgs.length).toBeGreaterThan(1)
  })

  it('three sends with multi-turn tool calls also remain dedup-free', () => {
    function multiTurnSend(userText: string, ts: number) {
      runtime.appendUser(userText, ts)
      persistDelta(SESSION_ID, runtime)
      runtime.appendAssistant('thinking…', ts + 1)
      runtime.appendTool('tool output', ts + 2)
      persistDelta(SESSION_ID, runtime) // turn_end #1
      runtime.appendAssistant(`final answer to ${userText}`, ts + 3)
      persistDelta(SESSION_ID, runtime) // turn_end #2
      persistDelta(SESSION_ID, runtime) // done
    }

    multiTurnSend('q1', 1000)
    multiTurnSend('q2', 2000)
    multiTurnSend('q3', 3000)

    const persisted = store.load()
    const userContents = persisted.filter((m) => m.role === 'user').map((m) => m.content)
    expect(userContents.sort()).toEqual(['q1', 'q2', 'q3'])

    // 无重复
    const seen = new Set<string>()
    for (const m of persisted) {
      const key = `${m.role}|${m.content}|${m.timestamp}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }

    expect(counters.get(SESSION_ID)).toBe(persisted.length)
    expect(persisted.length).toBe(runtime.getMessages().length)
  })

  it('after /clear: counter MUST be reset together with runtime drop', () => {
    simulateMobileSend('first question', 100)
    expect(store.load().length).toBeGreaterThan(0)

    // 模拟 /clear: runtime 被销毁 + counter 清零
    runtime.reset()
    counters.delete(SESSION_ID)
    // 同时 JSONL 通常也会被重写 — 这里我们只验证 counter/runtime 重置后
    // 下一次 send 不会因为 counter > 新 runtime.length 而漏存
    const newSessionPath = path.join(path.dirname((store as unknown as { filePath: string }).filePath ?? ''), `${SESSION_ID}.jsonl`)
    if (newSessionPath && fs.existsSync(newSessionPath)) {
      fs.unlinkSync(newSessionPath)
    }

    simulateMobileSend('second question (after clear)', 200)
    const persisted = store.load()
    const userMsgs = persisted.filter((m) => m.role === 'user')
    expect(userMsgs.map((m) => m.content)).toEqual(['second question (after clear)'])
  })
})
