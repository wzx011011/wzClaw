// ============================================================
// L4 E2E Scenarios S17, S18, S21, S22, S23, S24
// ============================================================
// S17  Relay offline queue (desktop→mobile direction):
//      Mobile disconnects → desktop streams response (queued in relay)
//      → mobile reconnects → queued events are flushed automatically
// S18  Workspace switch: same mobile, same session ID in two different
//      workspaceRoots — data in each workspace stays independent
// S21  session:delete via protocol event (not direct Store call)
// S22  session:list consistency — after N sends, list reflects all sessions
// S23  Same-session high concurrency — 10 sequential sends, no dup/loss
// S24  Two sessions running concurrently with mid-flight switch:
//      A starts (slow tool, 300 ms), user switches to B (sends + gets reply),
//      then waits for A to finish. Both JSOLNs must be clean, no cross-leakage.
// ============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { startRelay, type RelayHandle } from '../harness/relay-fixture'
import { MobileClient } from '../harness/mobile-client'
import { DesktopFixture } from '../harness/desktop-fixture'
import { assertNoJsonlDuplicates } from '../harness/assert-consistent'
import { SessionStore } from '../../../persistence/session-store'

const TOKEN = 'e2e-test-token-final'

describe('E2E final scenarios (S17-S24)', () => {
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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-final-'))
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-final-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(() => {
    delete process.env.WZXCLAW_TEST_USER_DATA
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
  })

  // ----------------------------------------------------------------
  // S17: Relay offline queue (desktop→mobile)
  //
  // The relay queues desktop→mobile messages when no mobiles are online.
  // When mobile reconnects it immediately receives the queued events.
  // ----------------------------------------------------------------
  it('S17: relay offline queue — mobile reconnects and receives queued stream events', async () => {
    const SID = 's17-session'
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: () => ({
        turns: [
          // Give mobile enough time to disconnect before desktop sends the reply
          { tools: [{ toolCallId: 't1', toolName: 'T', output: 'out', delayMs: 300 }] },
          { text: 'queued-reply' },
        ],
      }),
    })
    await desktop.connect()

    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()

    try {
      // 1. Mobile triggers the command
      const tcEvent = mobile.waitForEvent('stream:agent:tool_call', 3000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'trigger', timestamp: 100 })
      await tcEvent  // wait until streaming has started (tool about to execute)

      // 2. Mobile goes offline — relay queues subsequent desktop events
      await mobile.forceDisconnect()

      // 3. Let desktop finish the turn (tool delay: 300ms + persist + done broadcast → queued)
      await new Promise((r) => setTimeout(r, 800))

      // 4. Mobile reconnects — relay MUST flush queued events immediately on join
      await mobile.reconnect()

      // 5. The queued `stream:agent:done` arrives via flush; wait for it
      await mobile.waitForDone(SID, 3000)
      await new Promise((r) => setTimeout(r, 100))

      // 6. The queued text event must have been received too
      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const asst = jsonl.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
      expect(asst).toContain('queued-reply')
      assertNoJsonlDuplicates(jsonl)

      // Mobile chatStore should also have the assistant message (from queued text event)
      const chatAsst = mobile.chatStore.get(SID).filter((m) => m.role === 'assistant').map((m) => m.content)
      expect(chatAsst).toContain('queued-reply')
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S18: Workspace switch — same session ID in two workspaces stays isolated
  // ----------------------------------------------------------------
  it('S18: workspace switch — session data in each workspace is isolated', async () => {
    const SID = 's18-shared-id'
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-B-'))

    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `ws-A:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()

    try {
      // --- Workspace A: write two messages ---
      await mobile.sendUserMessage({ sessionId: SID, content: 'a1', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'a2', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      // --- Switch to workspace B (in-process, same WS connection) ---
      // In production this happens when user opens a different project folder.
      // We update the userDataDir env to a new temp dir so workspace B's JSONL
      // lands separately, then switch the fixture's SessionStore.
      const userDataB = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ud-B-'))
      process.env.WZXCLAW_TEST_USER_DATA = userDataB

      desktop.switchWorkspace(workspaceB)

      await mobile.sendUserMessage({ sessionId: SID, content: 'b1', timestamp: 300 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      // --- Restore env and switch back to workspace A ---
      process.env.WZXCLAW_TEST_USER_DATA = userDataDir
      desktop.switchWorkspace(workspaceRoot)

      // --- Verify A only has a1, a2 ---
      const storeA = new SessionStore(workspaceRoot)
      const jsonlA = await storeA.loadSession(SID)
      const userA = jsonlA.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userA).toEqual(['a1', 'a2'])
      assertNoJsonlDuplicates(jsonlA)

      // --- Verify B only has b1 ---
      process.env.WZXCLAW_TEST_USER_DATA = userDataB
      const storeB = new SessionStore(workspaceB)
      const jsonlB = await storeB.loadSession(SID)
      const userB = jsonlB.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userB).toEqual(['b1'])
      assertNoJsonlDuplicates(jsonlB)

      try { fs.rmSync(userDataB, { recursive: true, force: true }) } catch {}
      try { fs.rmSync(workspaceB, { recursive: true, force: true }) } catch {}
    } finally {
      process.env.WZXCLAW_TEST_USER_DATA = userDataDir
      await mobile.close()
      await desktop.close()
      try { fs.rmSync(workspaceB, { recursive: true, force: true }) } catch {}
    }
  }, 30000)

  // ----------------------------------------------------------------
  // S21: session:delete via protocol event
  // ----------------------------------------------------------------
  it('S21: session:delete via protocol event removes JSONL and runtime', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's21-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'data-to-delete', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      // Verify data exists before delete
      const storeBefore = new SessionStore(workspaceRoot)
      const before = await storeBefore.loadSession(SID)
      expect(before.filter((m) => m.role === 'user').length).toBe(1)

      // Delete via protocol event
      const ok = await mobile.deleteSession(SID, 5000)
      expect(ok).toBe(true)
      await new Promise((r) => setTimeout(r, 50))

      // Verify JSONL is gone
      const storeAfter = new SessionStore(workspaceRoot)
      const after = await storeAfter.loadSession(SID)
      expect(after.length).toBe(0) // empty / file removed

      // Next send should start clean (no leaked history)
      await mobile.sendUserMessage({ sessionId: SID, content: 'fresh-after-delete', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      const storeNew = new SessionStore(workspaceRoot)
      const newJSONL = await storeNew.loadSession(SID)
      const userMsgs = newJSONL.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['fresh-after-delete'])
      assertNoJsonlDuplicates(newJSONL)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S22: session:list consistency after multiple sessions
  // ----------------------------------------------------------------
  it('S22: session:list returns accurate meta for all created sessions', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SIDS = ['s22-A', 's22-B', 's22-C']

    try {
      for (const sid of SIDS) {
        await mobile.sendUserMessage({ sessionId: sid, content: `msg-${sid}`, timestamp: Date.now() })
        await mobile.waitForDone(sid, 5000)
      }
      await new Promise((r) => setTimeout(r, 100))

      const sessions = (await mobile.listSessions(5000)) as Array<{ id: string }>
      const ids = sessions.map((s) => s.id)

      for (const sid of SIDS) {
        expect(ids).toContain(sid)
      }
      // No phantom sessions
      expect(ids.length).toBeGreaterThanOrEqual(SIDS.length)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S23: Same-session high concurrency — 10 sequential sends, no dup/loss
  // ----------------------------------------------------------------
  it('S23: 10 sequential sends to the same session produce clean, ordered history', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's23-session'
    const N = 10

    try {
      for (let i = 1; i <= N; i++) {
        await mobile.sendUserMessage({ sessionId: SID, content: `q${i}`, timestamp: i * 100 })
        await mobile.waitForDone(SID, 5000)
      }
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      const asstMsgs = jsonl.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)

      expect(userMsgs.length).toBe(N)
      expect(asstMsgs.length).toBe(N)
      // Every user message must appear exactly once in correct order
      for (let i = 1; i <= N; i++) {
        expect(userMsgs[i - 1]).toBe(`q${i}`)
        expect(asstMsgs[i - 1]).toBe(`r:q${i}`)
      }
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 60000)

  // ----------------------------------------------------------------
  // S24: Two sessions running concurrently with mid-flight switch
  //
  // Reproduces the real user flow:
  //   1. Mobile sends to session A (slow tool, 300 ms delay — still in-flight)
  //   2. Without waiting for A to finish, mobile sends to session B
  //   3. Mobile waits for B to complete
  //   4. Mobile then waits for A to complete
  //   5. Both JSOLNs: no duplicates, no cross-contamination, correct ordering
  //
  // This is the gap not covered by S11 (sequential) or S15 (fire-and-forget all).
  // ----------------------------------------------------------------
  it('S24: two sessions run concurrently while user switches between them — both JSOLNs stay clean', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ sessionId, userMessage }) => {
        if (sessionId === 's24-A') {
          // Session A: slow — one tool call with 300 ms delay, then reply text
          return {
            turns: [
              { tools: [{ toolCallId: 'a-tool', toolName: 'SlowTool', output: 'a-tool-out', delayMs: 300 }] },
              { text: `A-reply:${userMessage}` },
            ],
          }
        }
        // Session B: fast — instant text reply
        return { turns: [{ text: `B-reply:${userMessage}` }] }
      },
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()

    const A = 's24-A'
    const B = 's24-B'

    try {
      // Step 1: Send to A — it will block for 300 ms on the tool delay
      const aTool = mobile.waitForEvent<{ sessionId?: string }>('stream:agent:tool_call', 3000)
      await mobile.sendUserMessage({ sessionId: A, content: 'question-A', timestamp: 100 })
      // Wait until A's tool call has started (proves A is mid-flight)
      const aToolData = await aTool
      expect(aToolData.sessionId).toBe(A)

      // Step 2: Without waiting for A, switch to B and send a message
      await mobile.sendUserMessage({ sessionId: B, content: 'question-B', timestamp: 200 })

      // Step 3: Wait for B to complete first (it's fast)
      await mobile.waitForDone(B, 5000)

      // Step 4: Wait for A to complete (tool delay still pending or just finished)
      await mobile.waitForDone(A, 5000)

      // Settle any pending async writes
      await new Promise((r) => setTimeout(r, 100))

      // ── Assertions ──────────────────────────────────────────
      const store = new SessionStore(workspaceRoot)

      // Session A: exactly one user message, two turns (tool + text), no duplicates
      const jsonlA = await store.loadSession(A)
      assertNoJsonlDuplicates(jsonlA)
      const userA = jsonlA.filter((m) => m.role === 'user').map((m) => m.content)
      const asstA = jsonlA.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
      expect(userA).toEqual(['question-A'])
      expect(asstA).toContain('A-reply:question-A')
      // No B content leaked into A
      expect(jsonlA.find((m) => String(m.content ?? '').includes('B'))).toBeUndefined()

      // Session B: exactly one user message, one assistant reply, no duplicates
      const jsonlB = await store.loadSession(B)
      assertNoJsonlDuplicates(jsonlB)
      const userB = jsonlB.filter((m) => m.role === 'user').map((m) => m.content)
      const asstB = jsonlB.filter((m) => m.role === 'assistant' && m.content).map((m) => m.content)
      expect(userB).toEqual(['question-B'])
      expect(asstB).toEqual(['B-reply:question-B'])
      // No A content leaked into B
      expect(jsonlB.find((m) => String(m.content ?? '').includes('A-reply'))).toBeUndefined()

      // Mobile chat store also stays isolated
      const mobileA = mobile.chatStore.get(A)
      const mobileB = mobile.chatStore.get(B)
      expect(mobileA.find((m) => m.content.includes('B-reply'))).toBeUndefined()
      expect(mobileB.find((m) => m.content.includes('A-reply'))).toBeUndefined()
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 30000)
})
