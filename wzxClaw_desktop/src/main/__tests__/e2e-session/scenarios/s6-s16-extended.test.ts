// ============================================================
// L4 E2E Scenarios S6, S7, S9, S12, S13, S15, S16
// ============================================================
// S6  Two mobile clients on same room — both receive stream events
// S7  /clear discards runtime; next send starts fresh, no leakage
// S9  Desktop "restart" (recreate fixture w/ same workspaceRoot) preserves JSONL,
//     then mobile send appends without duplicating prior history
// S12 Large content + tool chain — no truncation/dup at protocol layer
// S13 Mobile disconnects mid-tool; reconnect; history matches JSONL
// S15 Three concurrent sessions stay isolated
// S16 Corrupted JSONL line is skipped, valid lines are loaded
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

import { startRelay, type RelayHandle } from '../harness/relay-fixture'
import { MobileClient } from '../harness/mobile-client'
import { DesktopFixture } from '../harness/desktop-fixture'
import { assertConsistent, assertNoJsonlDuplicates } from '../harness/assert-consistent'
import { SessionStore } from '../../../persistence/session-store'

const TOKEN = 'e2e-test-token-extended'

function projectHashFor(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(workspaceRoot).digest('hex').substring(0, 16)
}

describe('E2E extended session sync scenarios', () => {
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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-ext-'))
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-ext-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(() => {
    delete process.env.WZXCLAW_TEST_USER_DATA
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
  })

  // ----------------------------------------------------------------
  // S6: Two mobile clients in the same room receive the same broadcasts
  // ----------------------------------------------------------------
  it('S6: two mobile clients on same token both receive stream events', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `multi-mobile reply: ${userMessage}` }] }),
    })
    await desktop.connect()
    const m1 = new MobileClient({ url: relay.url, token: TOKEN })
    const m2 = new MobileClient({ url: relay.url, token: TOKEN })
    await m1.connect()
    await m2.connect()
    const SID = 's6-session'

    try {
      const m2Done = m2.waitForEvent('stream:agent:done', 5000)
      await m1.sendUserMessage({ sessionId: SID, content: 'hello multi', timestamp: 100 })
      await m1.waitForDone(SID, 5000)
      await m2Done
      await new Promise((r) => setTimeout(r, 50))

      // Both mobile chatStores should be populated identically
      const a = m1.chatStore.get(SID).filter((m) => m.role === 'assistant').map((m) => m.content)
      const b = m2.chatStore.get(SID).filter((m) => m.role === 'assistant').map((m) => m.content)
      expect(a).toEqual(['multi-mobile reply: hello multi'])
      expect(b).toEqual(['multi-mobile reply: hello multi'])

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await m1.close()
      await m2.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S7: /clear (dropRuntime) drops counter; next send starts fresh
  // ----------------------------------------------------------------
  it('S7: dropping runtime resets counter and next send appends only new messages', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's7-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'before-clear', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      // Simulate /clear: drop runtime (in production, also rewrites JSONL to meta-only)
      desktop.dropRuntime(SID)
      // Erase JSONL too, mimicking session:clear:request behavior
      const sessPath = path.join(userDataDir, 'sessions', projectHashFor(workspaceRoot), `${SID}.jsonl`)
      if (fs.existsSync(sessPath)) fs.writeFileSync(sessPath, '', 'utf-8')

      await mobile.sendUserMessage({ sessionId: SID, content: 'after-clear', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['after-clear'])
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S9: Desktop "restart" (new fixture, same workspaceRoot) — JSONL is the source of truth
  // ----------------------------------------------------------------
  it('S9: desktop restart preserves JSONL and next mobile send does not duplicate', async () => {
    const SID = 's9-session'

    // Phase 1
    {
      const desktop = new DesktopFixture({
        url: relay.url,
        token: TOKEN,
        workspaceRoot,
        script: ({ userMessage }) => ({ turns: [{ text: `r1:${userMessage}` }] }),
      })
      await desktop.connect()
      const mobile = new MobileClient({ url: relay.url, token: TOKEN })
      await mobile.connect()
      await mobile.sendUserMessage({ sessionId: SID, content: 'q1-pre-restart', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))
      await mobile.close()
      await desktop.close()
    }

    // Phase 2: brand-new desktop fixture (simulates desktop restart) on the SAME workspaceRoot
    const desktop2 = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r2:${userMessage}` }] }),
    })
    await desktop2.connect()
    const mobile2 = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile2.connect()

    try {
      await mobile2.sendUserMessage({ sessionId: SID, content: 'q2-post-restart', timestamp: 200 })
      await mobile2.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      // Both questions must be present, each exactly once
      expect(userMsgs.sort()).toEqual(['q1-pre-restart', 'q2-post-restart'].sort())
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile2.close()
      await desktop2.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S12: Large content + multi-tool turn — no truncation at protocol layer
  // ----------------------------------------------------------------
  it('S12: large message with multi-tool turn round-trips intact', async () => {
    const big = 'X'.repeat(20_000)
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: () => ({
        turns: [
          {
            tools: [
              { toolCallId: 't1', toolName: 'ToolA', output: 'A-out' },
              { toolCallId: 't2', toolName: 'ToolB', output: big },
            ],
          },
          { text: 'final answer' },
        ],
      }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's12-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'big test', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const toolResults = jsonl.filter((m) => m.role === 'tool_result')
      expect(toolResults.length).toBe(2)
      const toolBOut = toolResults.find((m) => m.toolCallId === 't2')
      expect(toolBOut?.content).toBe(big)
      expect(toolBOut?.content?.length).toBe(20_000)

      assertNoJsonlDuplicates(jsonl)
      assertConsistent({ jsonl, runtime: desktop.runtimeMessages(SID), mobile: mobile.chatStore.get(SID) })
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S13: Disconnect during tool execution — desktop completes, history matches
  // ----------------------------------------------------------------
  it('S13: mobile disconnects during tool, desktop completes, reload matches JSONL', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: () => ({
        turns: [
          { tools: [{ toolCallId: 'tc1', toolName: 'SlowTool', output: 'slow-out', delayMs: 300 }] },
          { text: 'final' },
        ],
      }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's13-session'

    try {
      const tcEvent = mobile.waitForEvent('stream:agent:tool_call', 3000)
      await mobile.sendUserMessage({ sessionId: SID, content: 's13-q', timestamp: 100 })
      await tcEvent
      await mobile.forceDisconnect()

      // Wait for desktop to finish
      await new Promise((r) => setTimeout(r, 1500))

      await mobile.reconnect()
      const loaded = (await mobile.loadSessionHistory(SID, 3000)) as Array<{ role: string; content: string }>
      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)

      expect(loaded.length).toBe(jsonl.length)
      assertNoJsonlDuplicates(jsonl)
      const asst = jsonl.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
      expect(asst).toContain('final')
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S15: Three concurrent sessions stay isolated
  // ----------------------------------------------------------------
  it('S15: three concurrent sessions remain isolated under interleaved sends', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({
        turns: [{ tools: [{ toolCallId: 'x', toolName: 'T', output: 'out', delayMs: 50 }] }, { text: `done:${userMessage}` }],
      }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()

    try {
      const sids = ['s15-A', 's15-B', 's15-C']
      // Send to all three before any completes
      await Promise.all(
        sids.map((sid, i) =>
          mobile.sendUserMessage({ sessionId: sid, content: `msg-${sid}`, timestamp: 100 + i }),
        ),
      )
      // Wait for all done events
      await Promise.all(sids.map((sid) => mobile.waitForDone(sid, 8000)))
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      for (const sid of sids) {
        const jsonl = await store.loadSession(sid)
        assertNoJsonlDuplicates(jsonl)
        const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
        expect(userMsgs).toEqual([`msg-${sid}`])
        // Each session must NOT contain content from other sessions
        for (const other of sids) {
          if (other === sid) continue
          expect(jsonl.find((m) => m.content === `msg-${other}` || m.content === `done:msg-${other}`)).toBeUndefined()
        }
      }
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 30000)

  // ----------------------------------------------------------------
  // S16: Corrupted JSONL line is skipped on load
  // ----------------------------------------------------------------
  it('S16: corrupted JSONL line is skipped, valid messages still load', async () => {
    const desktop = new DesktopFixture({
      url: relay.url,
      token: TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's16-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'normal-msg', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      // Append a corrupted line directly to the JSONL file
      const sessPath = path.join(userDataDir, 'sessions', projectHashFor(workspaceRoot), `${SID}.jsonl`)
      expect(fs.existsSync(sessPath)).toBe(true)
      fs.appendFileSync(sessPath, '{this is not valid json}\n', 'utf-8')

      // Load via SessionStore — corrupted line must be skipped
      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['normal-msg'])
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)
})
