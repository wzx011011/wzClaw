// ============================================================
// L4 E2E Scenario S1 — Single user message, full happy path
// ============================================================
// Validates the L4 harness wiring end-to-end:
//   1. Real relay child process accepts mobile + desktop connections
//   2. Mobile sends `command:send` over WS
//   3. Desktop fixture receives, runs scripted runtime, persists JSONL,
//      and broadcasts stream events back through the relay
//   4. Mobile chatStore projects the events
//   5. JSONL on disk == runtime in-memory == mobile chatStore
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

const TEST_TOKEN = 'e2e-test-token-s1'
const SESSION_ID = 's1-session-001'

describe('E2E S1 — single user message round-trip', () => {
  let relay: RelayHandle
  let userDataDir: string
  let workspaceRoot: string
  let desktop: DesktopFixture
  let mobile: MobileClient

  beforeAll(async () => {
    relay = await startRelay()
  }, 15000)

  afterAll(async () => {
    await relay.close()
  })

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-e2e-s1-'))
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wzxclaw-ws-'))
    process.env.WZXCLAW_TEST_USER_DATA = userDataDir
  })

  afterEach(async () => {
    if (mobile) await mobile.close()
    if (desktop) await desktop.close()
    delete process.env.WZXCLAW_TEST_USER_DATA
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(workspaceRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('mobile send → desktop persist+stream → three-way consistency', async () => {
    desktop = new DesktopFixture({
      url: relay.url,
      token: TEST_TOKEN,
      workspaceRoot,
      script: ({ userMessage }) => ({
        turns: [{ text: `Echo: ${userMessage}` }],
      }),
    })
    await desktop.connect()

    mobile = new MobileClient({ url: relay.url, token: TEST_TOKEN })
    await mobile.connect()

    // Send the user message
    await mobile.sendUserMessage({
      sessionId: SESSION_ID,
      content: 'hello e2e',
      timestamp: 1000,
    })

    // Wait for the agent to finish
    await mobile.waitForDone(SESSION_ID, 5000)
    // Allow microtasks (final persist) to settle
    await new Promise((r) => setTimeout(r, 100))

    // Three-way consistency
    const store = new SessionStore(workspaceRoot)
    const jsonl = await store.loadSession(SESSION_ID)
    const runtime = desktop.runtimeMessages(SESSION_ID)
    const mobileMsgs = mobile.chatStore.get(SESSION_ID)

    expect(jsonl.length).toBeGreaterThan(0)
    expect(runtime.length).toBeGreaterThan(0)
    expect(mobileMsgs.length).toBeGreaterThan(0)

    assertNoJsonlDuplicates(jsonl)
    assertConsistent({ jsonl, runtime, mobile: mobileMsgs })

    // User message and assistant reply are present
    const userMsgs = jsonl.filter((m) => m.role === 'user').map((m) => m.content)
    const asstMsgs = jsonl.filter((m) => m.role === 'assistant').map((m) => m.content)
    expect(userMsgs).toEqual(['hello e2e'])
    expect(asstMsgs).toEqual(['Echo: hello e2e'])
  }, 15000)
})
