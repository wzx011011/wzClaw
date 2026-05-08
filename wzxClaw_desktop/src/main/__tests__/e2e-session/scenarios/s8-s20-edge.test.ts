// ============================================================
// L4 E2E Scenarios S8, S10, S11, S19, S20
// ============================================================
// S8  Delete a session, then create a new session with the SAME id —
//     no leakage from the old session
// S10 Rename a session — title persists, message body unchanged
// S11 Sending to two sessions in rapid alternation — counters not crossed
// S19 agent:error path — next send to the same session does not duplicate
// S20 abortAfter mid-stream — next send to the same session does not duplicate
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

const TOKEN = 'e2e-test-token-edge'

describe('E2E edge-case session sync scenarios', () => {
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
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-edge-'))
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-edge-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(() => {
    delete process.env.WZXCLAW_TEST_USER_DATA
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }) } catch {}
  })

  // ----------------------------------------------------------------
  // S8: Delete + recreate with same ID — no leakage
  // ----------------------------------------------------------------
  it('S8: deleting a session and reusing the same id starts a clean history', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's8-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'old-data', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      // Delete the session via SessionStore directly + drop runtime
      const store = new SessionStore(workspaceRoot)
      const deleted = await store.deleteSession(SID)
      expect(deleted).toBe(true)
      desktop.dropRuntime(SID)

      // Reuse same id
      await mobile.sendUserMessage({ sessionId: SID, content: 'fresh-data', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['fresh-data']) // no leakage from old session
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S10: Rename session — meta updated, body unchanged
  // ----------------------------------------------------------------
  it('S10: renaming a session updates meta without altering message history', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's10-session'

    try {
      await mobile.sendUserMessage({ sessionId: SID, content: 'msg-A', timestamp: 100 })
      await mobile.waitForDone(SID, 5000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'msg-B', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 50))

      const store = new SessionStore(workspaceRoot)
      const before = await store.loadSession(SID)
      const renamed = await store.renameSession(SID, 'Renamed Title')
      expect(renamed).toBe(true)
      const after = await store.loadSession(SID)

      // loadSession skips meta lines, so before==after for actual messages
      expect(after.length).toBe(before.length)
      const userMsgs = after.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['msg-A', 'msg-B'])
      assertNoJsonlDuplicates(after)

      // Verify meta line was actually written by reading raw file
      const sessions = await store.listSessions()
      const meta = sessions.find((s) => s.id === SID)
      expect(meta?.title).toBe('Renamed Title')
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 20000)

  // ----------------------------------------------------------------
  // S11: Rapid alternation between two sessions — counters never cross
  // ----------------------------------------------------------------
  it('S11: rapid A/B/A/B alternation keeps counters and persistence isolated', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage }) => ({ turns: [{ text: `r:${userMessage}` }] }),
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const A = 's11-A'
    const B = 's11-B'

    try {
      // Send four interleaved messages, waiting only for done before alternating
      const sequence: Array<[string, string]> = [
        [A, 'A1'], [B, 'B1'], [A, 'A2'], [B, 'B2'],
      ]
      for (const [sid, content] of sequence) {
        await mobile.sendUserMessage({ sessionId: sid, content, timestamp: Date.now() })
        await mobile.waitForDone(sid, 5000)
      }
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonlA = await store.loadSession(A)
      const jsonlB = await store.loadSession(B)
      expect(jsonlA.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['A1', 'A2'])
      expect(jsonlB.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['B1', 'B2'])
      assertNoJsonlDuplicates(jsonlA)
      assertNoJsonlDuplicates(jsonlB)
      // Cross-leakage check
      expect(jsonlA.find((m) => /^B\d/.test(m.content ?? ''))).toBeUndefined()
      expect(jsonlB.find((m) => /^A\d/.test(m.content ?? ''))).toBeUndefined()
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 30000)

  // ----------------------------------------------------------------
  // S19: agent:error path — next send to same session must not duplicate prior history
  // ----------------------------------------------------------------
  it('S19: error mid-stream then re-send does not re-append prior messages', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage, callIndex }) => {
        if (callIndex === 1) {
          // First call: error after thinking
          return { turns: [{ thinking: 'oops', errorAfter: 'thinking' }] }
        }
        return { turns: [{ text: `recovered:${userMessage}` }] }
      },
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's19-session'

    try {
      // First send — will error
      const errPromise = mobile.waitForEvent('stream:agent:error', 5000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'first-q', timestamp: 100 })
      await errPromise
      await new Promise((r) => setTimeout(r, 100))

      // Second send — should succeed, no duplication of first user msg
      await mobile.sendUserMessage({ sessionId: SID, content: 'second-q', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs.sort()).toEqual(['first-q', 'second-q'].sort())
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)

  // ----------------------------------------------------------------
  // S20: abort mid-stream then re-send does not re-append
  // ----------------------------------------------------------------
  it('S20: abort mid-stream then re-send keeps history clean', async () => {
    const desktop = new DesktopFixture({
      url: relay.url, token: TOKEN, workspaceRoot,
      script: ({ userMessage, callIndex }) => {
        if (callIndex === 1) {
          return { turns: [{ tools: [{ toolCallId: 't', toolName: 'X', output: 'o', delayMs: 100 }], abortAfter: 'tools' }] }
        }
        return { turns: [{ text: `resume:${userMessage}` }] }
      },
    })
    await desktop.connect()
    const mobile = new MobileClient({ url: relay.url, token: TOKEN })
    await mobile.connect()
    const SID = 's20-session'

    try {
      const errPromise = mobile.waitForEvent('stream:agent:error', 5000)
      await mobile.sendUserMessage({ sessionId: SID, content: 'q1-aborted', timestamp: 100 })
      await errPromise
      await new Promise((r) => setTimeout(r, 100))

      await mobile.sendUserMessage({ sessionId: SID, content: 'q2-resume', timestamp: 200 })
      await mobile.waitForDone(SID, 5000)
      await new Promise((r) => setTimeout(r, 100))

      const store = new SessionStore(workspaceRoot)
      const jsonl = await store.loadSession(SID)
      const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
      expect(userMsgs).toEqual(['q1-aborted', 'q2-resume'])
      assertNoJsonlDuplicates(jsonl)
    } finally {
      await mobile.close()
      await desktop.close()
    }
  }, 25000)
})
