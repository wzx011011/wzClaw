// ============================================================
// L4 E2E Scenarios S2–S5 — Core session sync invariants
// ============================================================
// S2: Same-session consecutive sends — no JSONL duplication
//     (Direct regression for the 用的什么模型 bug fixed in P0)
// S3: Switch session and switch back — no cross-talk
// S4: Mobile connects late and loads history of an existing session
// S5: Mobile disconnects mid-stream then reconnects — three-way still consistent
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { startRelay, type RelayHandle } from '../harness/relay-fixture'
import { MobileClient } from '../harness/mobile-client'
import { DesktopFixture } from '../harness/desktop-fixture'
import { assertConsistent, assertNoJsonlDuplicates } from '../harness/assert-consistent'
import { SessionStore } from '../../../persistence/session-store'

const TOKEN = 'e2e-test-token-core'

describe('E2E core session sync', () => {
  let relay: RelayHandle
  let userDataDir: string
  let workspaceRoot: string

  beforeAll(async () => {
    relay = await startRelay()
  }, 15000)

  afterAll(async () => {
    await relay.close()
  })

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-core-'))
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(() => {
    delete process.env.WZXCLAW_TEST_USER_DATA
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
  })

  // ----------------------------------------------------------------
  // S2: Same-session consecutive sends — no JSONL duplication
  // ----------------------------------------------------------------
  it('S2: two consecutive mobile sends in the same session must not duplicate persistence', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `reply: ${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's2-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: '用的什么模型', timestamp: 1000 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      await mobile.sendUserMessage({ sessionId: SID, content: '任务什么进展了', timestamp: 2000 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const runtime = desktop.runtimeMessages(SID)

      // 关键断言：两条用户消息各自只出现一次
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs.sort()).toEqual(['任务什么进展了', '用的什么模型'].sort())

      assertNoJsonlDuplicates(jsonl)
      assertConsistent({ jsonl, runtime, mobile: mobile.chatStore.get(SID) })
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S3: Switch session and switch back — no cross-talk
  // ----------------------------------------------------------------
  it('S3: switching sessions A→B→A keeps each session isolated', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `reply to ${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const A = 's3-A'
    const B = 's3-B'

    try {
      await mobile.sendUserMessage({ sessionId: A, content: 'A1', timestamp: 100 })
      await mobile.waitForDone(A, 5000)
      await mobile.sendUserMessage({ sessionId: B, content: 'B1', timestamp: 200 })
      await mobile.waitForDone(B, 5000)
      await mobile.sendUserMessage({ sessionId: A, content: 'A2', timestamp: 300 })
      await mobile.waitForDone(A, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonlA = await store.loadSession(A)
      const jsonlB = await store.loadSession(B)

      // A 包含 A1 和 A2；B 仅包含 B1；无串台
      expect(jsonlA.filter((m) => m.role === 'user').map((m) => m.content).sort()).toEqual(['A1', 'A2'])
      expect(jsonlB.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['B1'])

      // 不能有任何 A 的内容出现在 B，反之亦然
      expect(jsonlA.find((m) => m.content === 'B1')).toBeUndefined()
      expect(jsonlB.find((m) => m.content === 'A1' || m.content === 'A2')).toBeUndefined()

      assertNoJsonlDuplicates(jsonlA)
      assertNoJsonlDuplicates(jsonlB)
      assertConsistent({ jsonl: jsonlA, runtime: desktop.runtimeMessages(A), mobile: mobile.chatStore.get(A) })
      assertConsistent({ jsonl: jsonlB, runtime: desktop.runtimeMessages(B), mobile: mobile.chatStore.get(B) })
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S4: Mobile connects late and loads existing-session history
  // ----------------------------------------------------------------
  it('S4: mobile connects after history exists, session:load brings full JSONL', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `reply to ${userMessage}` }] }),
    })
    await desktop.connect()

    // Phase 1: mobile-A talks first (creates history)
    const mobileA = new MobileClient({ url: relay.url, token: TOKEN })
    await mobileA.connect()
    const SID = 's4-session'
    await mobileA.sendUserMessage({ sessionId: SID, content: 'first historical msg', timestamp: 100 })
    await mobileA.waitForDone(SID, 5000)
    await mobileA.sendUserMessage({ sessionId: SID, content: 'second historical msg', timestamp: 200 })
    await mobileA.waitForDone(SID, 5000)
    await new Promise((r) => setTimeout(r, 100))
    await mobileA.close()

    // Phase 2: mobile-B connects fresh, requests history
    const mobileB = new MobileClient({ url: relay.url, token: TOKEN })
    await mobileB.connect()
    try {
      const messages = (await mobileB.loadSessionHistory(SID, 3000)) as Array<{ role: string; content: string }>
      const userOnly = messages.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userOnly).toEqual(['first historical msg', 'second historical msg'])

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      assertNoJsonlDuplicates(jsonl)
      // After load, mobileB has the full JSONL view; runtime still in desktop
      // (skip strict three-way assert here; mobile's chatStore is empty until session:load applies)
      expect(messages.length).toBe(jsonl.length)
    } finally {
      await mobileB.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S5: Mobile disconnects mid-stream and reconnects — state still consistent
  // ----------------------------------------------------------------
  it('S5: mobile force-disconnects mid-stream, reconnects, session:load matches JSONL', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      // Slow tool call so we have time to disconnect mid-stream
      script: ({ userMessage }) => ({
        turns: [
          {
            tools: [{ toolCallId: 'tc1', toolName: 'SlowTool', output: 'tool-out', delayMs: 200 }],
          },
          { text: `final reply to ${userMessage}` },
        ],
      }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's5-session'

    try {
      // Send and immediately force-disconnect after the first stream events arrive
      const firstToolCall = mobile.waitForEvent('stream:agent:tool_call', 3000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'mid-stream test', timestamp: 100 })
      await firstToolCall
      await mobile.forceDisconnect()

      // Wait long enough for desktop to finish the run uninterrupted
      await new Promise((r) => setTimeout(r, 1500))

      // Reconnect and load history
      await mobile.reconnect()
      const messages = (await mobile.loadSessionHistory(SID, 3000)) as Array<{ role: string; content: string }>

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      assertNoJsonlDuplicates(jsonl)

      // Loaded history must equal disk JSONL
      expect(messages.length).toBe(jsonl.length)

      // The desktop still produced a full final assistant reply
      const asst = jsonl.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
      expect(asst).toContain('final reply to mid-stream test')
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)
})
