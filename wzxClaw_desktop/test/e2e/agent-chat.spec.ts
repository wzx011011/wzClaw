// ============================================================
// E2E Agent Chat Tests — wzxClaw Desktop
// ============================================================
// 驱动真实打包的 Electron 应用，注入 Mock LLM 服务器替代真实 API。
// 测试完整的用户 → UI → IPC → AgentLoop → LLM → UI 链路。
//
// 前提：
//   npm run build:win   (或至少 npm run build)
//   npx playwright test test/e2e/agent-chat.spec.ts
//
// 跳过条件：dist/win-unpacked/wzxClaw.exe 不存在时自动跳过
// ============================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { MockLLMServer, textScript, toolScript } from './helpers/mock-llm-server'

// ── Constants ─────────────────────────────────────────────────

const EXE_PATH = path.resolve(__dirname, '../../dist/win-unpacked/wzxClaw.exe')
// ── Helpers ───────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function launchAppWithMockLLM(
  userDataDir: string,
  llmBaseUrl: string
): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    executablePath: EXE_PATH,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      WZXCLAW_SMOKE_TEST: '1',
      // Route all LLM calls to the mock server
      ANTHROPIC_API_KEY: 'e2e-test-key',
      ANTHROPIC_BASE_URL: llmBaseUrl,
    },
    timeout: 30_000,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

/** Wait for the current web-ui chat surface to be ready. */
async function waitForChatReady(win: Page): Promise<void> {
  await expect(win.locator('textarea.chat-input')).toBeVisible({ timeout: 20_000 })
  await expect(win.locator('button.chat-send-btn')).toBeVisible({ timeout: 10_000 })
}

/** Set permission mode via renderer IPC (no UI interaction needed). */
async function setPermissionMode(win: Page, mode: string): Promise<void> {
  await win.evaluate(async (m) => {
    await (window as any).wzxclaw.setPermissionMode?.({ mode: m })
  }, mode)
}

/** Route the desktop LLM gateway to the mock Anthropic server. */
async function configureMockLlm(win: Page, llmBaseUrl: string): Promise<void> {
  await win.evaluate(async (baseURL) => {
    await (window as any).wzxclaw.updateSettings({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      apiKey: 'e2e-test-key',
      baseURL,
    })
  }, llmBaseUrl)
}

/** Type a message and send it (press Enter). */
async function sendChatMessage(win: Page, text: string): Promise<void> {
  const input = win.locator('textarea.chat-input')
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

/** Wait for the last assistant message content to contain expected text. */
async function waitForAssistantText(win: Page, expected: string, timeout = 20_000): Promise<void> {
  const msg = win.locator('.chat-message-assistant .chat-message-content').last()
  await expect(msg).toContainText(expected, { timeout })
}

// ── Test Suite ────────────────────────────────────────────────

test.describe('E2E Agent Chat', () => {
  let mockLLM: MockLLMServer
  let userDataDir: string
  let workspaceDir: string
  let app: ElectronApplication
  let win: Page

  test.beforeAll(async () => {
    // Skip when build hasn't been run
    if (!fs.existsSync(EXE_PATH)) {
      test.skip()
      return
    }

    // Start mock LLM server first so we have the port before launching app
    mockLLM = new MockLLMServer()
    await mockLLM.start()

    // Set a safe default: respond with an error message if tests forget to enqueue
    mockLLM.setDefault(textScript('[MOCK] No script enqueued for this request'))

    // Create isolated temp dirs
    userDataDir = makeTempDir('wzxclaw-e2e-ud-')
    workspaceDir = makeTempDir('wzxclaw-e2e-ws-')

    // Launch Electron with mock LLM
    ;({ app, win } = await launchAppWithMockLLM(userDataDir, mockLLM.baseUrl))

    // Wait for the shared web-ui chat surface to mount
    await waitForChatReady(win)

    // The persisted/default desktop settings include a real baseURL. Override it
    // through IPC so this test never talks to a live provider.
    await configureMockLlm(win, mockLLM.baseUrl)

    // Set bypass permission mode so tools run without approval dialogs
    await setPermissionMode(win, 'bypass')
  })

  test.afterAll(async () => {
    await app?.close()
    await mockLLM?.stop()
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  // ── EC-1: Simple text response ─────────────────────────────

  test('EC-1: mock LLM text response appears in chat', async () => {
    const expectedText = 'E2E verification: The agent loop works end-to-end!'
    mockLLM.enqueue(textScript(expectedText))

    await sendChatMessage(win, 'Hello, are you working?')

    // User message should appear first
    await expect(win.locator('.chat-message-user').last()).toContainText('Hello, are you working?', {
      timeout: 8_000,
    })

    // Assistant response should appear
    await waitForAssistantText(win, expectedText)
  })

  // ── EC-2: Tool call round trip (FileRead) ──────────────────

  test('EC-2: tool call round trip with FileRead completes without errors', async () => {
    // Write a temp file for FileRead to read
    const testFilePath = path.join(workspaceDir, 'e2e-test.txt')
    fs.writeFileSync(testFilePath, 'E2E test file content 42\n')

    // Turn 1: LLM calls FileRead
    mockLLM.enqueue(
      toolScript('FileRead', { path: testFilePath }, 'toolu_e2e_fileread_01')
    )

    // Turn 2: LLM gives final answer after seeing file content
    const finalAnswer = 'I read the file. It contains E2E test content.'
    mockLLM.enqueue(textScript(finalAnswer))

    await sendChatMessage(win, 'Read the test file and tell me what is in it.')

    // Tool call card should appear in the message
    await expect(win.locator('.chat-message-tools').last()).toBeVisible({ timeout: 15_000 })

    // Final assistant text should appear after tool result is processed
    await waitForAssistantText(win, finalAnswer, 25_000)
  })

  // ── EC-3: Send button state during streaming ───────────────

  test('EC-3: send button is disabled while streaming, becomes stop button', async () => {
    // Use a slow-streaming script so we can catch the in-flight state
    const slowScript = textScript(
      'This is a slow streaming response for stop-button testing. '.repeat(5),
      30 // 30ms delay between chunks — long enough to observe state changes
    )
    mockLLM.enqueue(slowScript)

    await sendChatMessage(win, 'Give me a slow response')

    // During streaming the stop button should appear
    const stopBtn = win.locator('button.chat-stop-btn')
    await expect(stopBtn).toBeVisible({ timeout: 10_000 })

    // Click stop to abort
    await stopBtn.click()

    // After stopping, the send button should reappear
    await expect(win.locator('button.chat-send-btn')).toBeVisible({ timeout: 8_000 })

    // Clear any leftover queue from the aborted request
    mockLLM.clearQueue()
  })

  // ── EC-4: Multiple turns in the same session ───────────────

  test('EC-4: second message in same session works correctly', async () => {
    const reply = 'Second turn response: session history is intact.'
    mockLLM.enqueue(textScript(reply))

    await sendChatMessage(win, 'This is the second message in the session.')

    await waitForAssistantText(win, reply)
  })
})
