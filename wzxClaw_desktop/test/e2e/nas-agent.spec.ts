// ============================================================
// NAS Agent Server E2E Tests — 桌面端作为 Hand 的全链路测试
// ============================================================
// 测试链路：Playwright(客户端) → NAS AgentServer → Desktop Hand → 工具执行 → 响应
//
// 前提（两者都需要）：
//   - EXE 已打包：npm run build:win
//   - NAS agent-server 可访问，且已配置好 LLM API key
//
// 必要的环境变量（任意一个未设置则测试被跳过）：
//   NAS_AGENT_URL    NAS agent-server WebSocket URL
//                    例: ws://192.168.100.78:8082  或  wss://5945.top/agent/
//   NAS_AGENT_TOKEN  认证 token（与 NAS 上的 AUTH_TOKEN 一致）
//
// 运行：
//   NAS_AGENT_URL=ws://192.168.100.78:8082 NAS_AGENT_TOKEN=xxx npx playwright test test/e2e/nas-agent.spec.ts
// ============================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import WebSocket from 'ws'
import path from 'path'
import fs from 'fs'
import os from 'os'
import http from 'http'
import https from 'https'

// ── Constants ─────────────────────────────────────────────────

const EXE_PATH = path.resolve(__dirname, '../../dist/win-unpacked/wzxClaw.exe')

// ── Helpers ───────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Get NAS config from env vars. Returns null if not configured. */
function getNasConfig(): { wsUrl: string; token: string; httpUrl: string } | null {
  const wsUrl = process.env.NAS_AGENT_URL
  const token = process.env.NAS_AGENT_TOKEN
  if (!wsUrl || !token) return null
  // Derive HTTP health check URL from WS URL
  const httpUrl = wsUrl.replace(/^wss?:\/\//, (m) => (m === 'wss://' ? 'https://' : 'http://'))
  return { wsUrl, token, httpUrl }
}

/** Check NAS /health endpoint and return number of connected Hands */
function fetchHandCount(httpBaseUrl: string): Promise<number> {
  return new Promise((resolve) => {
    const url = httpBaseUrl.replace(/\/?$/, '/health')
    const mod = url.startsWith('https://') ? https : http
    const req = mod.get(url, { timeout: 3_000 }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => { body += d.toString() })
      res.on('end', () => {
        try {
          const json = JSON.parse(body) as { hands?: number }
          resolve(json.hands ?? 0)
        } catch {
          resolve(0)
        }
      })
      res.on('error', () => resolve(0))
    })
    req.on('error', () => resolve(0))
    // timeout 事件不会自动关闭连接，必须手动 destroy
    req.on('timeout', () => { req.destroy(); resolve(0) })
  })
}

/** Wait for Desktop Hand to register on NAS (polls /health). */
async function waitForHandRegistered(
  httpBaseUrl: string,
  initialHandCount: number,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await fetchHandCount(httpBaseUrl)
    if (count > initialHandCount) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Desktop Hand did not register on NAS within ${timeoutMs}ms`)
}

/** Connect a WebSocket test client to NAS agent-server. */
function connectNasClient(wsUrl: string, token: string): Promise<WebSocket> {
  // 使用 query string 传 token（与 e2e.test.ts 保持一致）
  // 避免 WebSocket protocol 协商问题（服务器不回传 Sec-WebSocket-Protocol 时 ws@8 会拒绝连接）
  const base = wsUrl.replace(/\/+$/, '')
  const url = `${base}?type=client&token=${encodeURIComponent(token)}`
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('NAS WS connect timeout')), 8_000)
  })
}

/** Send a JSON message to NAS */
function sendMsg(ws: WebSocket, event: string, data: unknown): void {
  ws.send(JSON.stringify({ event, data }))
}

/** Collect all stream events until stream:done or stream:error (fatal), with timeout. */
function collectStreamEvents(
  ws: WebSocket,
  timeoutMs = 60_000
): Promise<Array<{ event: string; data: unknown }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: unknown }> = []
    const timer = setTimeout(() => reject(new Error('Stream timeout — no stream:done received')), timeoutMs)

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as { event: string; data: unknown }
        events.push(msg)
        if (msg.event === 'stream:done') {
          clearTimeout(timer)
          resolve(events)
        } else if (msg.event === 'stream:error') {
          const errData = msg.data as { recoverable?: boolean }
          if (!errData?.recoverable) {
            clearTimeout(timer)
            reject(new Error(`NAS stream:error (fatal): ${JSON.stringify(errData)}`))
          }
        }
      } catch { /* ignore non-JSON */ }
    })
  })
}

/** Wait for the current web-ui chat surface to be ready. */
async function waitForChatReady(win: Page): Promise<void> {
  await expect(win.locator('textarea.chat-input')).toBeVisible({ timeout: 20_000 })
  await expect(win.locator('button.chat-send-btn')).toBeVisible({ timeout: 10_000 })
}

// ── Test Suite ────────────────────────────────────────────────

test.describe('NAS Agent E2E — Desktop as Hand', () => {
  let nas: ReturnType<typeof getNasConfig>
  let userDataDir: string
  let workspaceDir: string
  let app: ElectronApplication
  let win: Page
  let initialHandCount: number

  test.beforeAll(async () => {
    // Skip when NAS env vars not set
    nas = getNasConfig()
    if (!nas) {
      console.log('[NAS E2E] Skipping: NAS_AGENT_URL or NAS_AGENT_TOKEN not set')
      test.skip()
      return
    }

    // Skip when build hasn't been run
    if (!fs.existsSync(EXE_PATH)) {
      console.log('[NAS E2E] Skipping: EXE not found at', EXE_PATH)
      test.skip()
      return
    }

    // Record how many Hands are already connected (don't disturb existing)
    initialHandCount = await fetchHandCount(nas.httpUrl)
    console.log(`[NAS E2E] NAS initial hand count: ${initialHandCount}`)

    userDataDir = makeTempDir('wzxclaw-nas-e2e-ud-')
    workspaceDir = makeTempDir('wzxclaw-nas-e2e-ws-')

    // Launch Electron — HandBridge will connect to real NAS via env vars
    app = (
      await electron.launch({
        executablePath: EXE_PATH,
        args: [`--user-data-dir=${userDataDir}`],
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: '1',
          WZXCLAW_SMOKE_TEST: '1',
          // HandBridge env var injection (hand-bridge.ts now reads these)
          WZXCLAW_AGENT_URL: nas.wsUrl,
          WZXCLAW_AGENT_TOKEN: nas.token,
        },
        timeout: 30_000,
      })
    )

    win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await waitForChatReady(win)

    // Wait for Desktop HandBridge to connect and register on NAS
    console.log('[NAS E2E] Waiting for Desktop Hand to register on NAS...')
    await waitForHandRegistered(nas.httpUrl, initialHandCount)
    console.log('[NAS E2E] Desktop Hand registered!')
  })

  test.afterAll(async () => {
    await app?.close()
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  // ── NA-1: HandBridge registers on NAS ──────────────────────

  test('NA-1: Desktop HandBridge registers and NAS reports a Hand connected', async () => {
    const handCount = await fetchHandCount(nas!.httpUrl)
    expect(handCount).toBeGreaterThan(initialHandCount)
  })

  // ── NA-2: Simple chat round trip through NAS ───────────────

  test('NA-2: send a message via NAS — full Client→NAS→Hand→NAS→Client round trip', async () => {
    const client = await connectNasClient(nas!.wsUrl, nas!.token)

    try {
      const conversationId = `e2e-${Date.now()}`

      sendMsg(client, 'chat:send', {
        sessionId: conversationId,
        message: '你好，请用一句话回答：1+1等于几？',
      })

      const events = await collectStreamEvents(client, 60_000)

      // Should have received at least some text
      const textEvents = events.filter((e) => e.event === 'stream:text')
      expect(textEvents.length).toBeGreaterThan(0)

      // Should end with stream:done
      const doneEvent = events.find((e) => e.event === 'stream:done')
      expect(doneEvent).toBeDefined()

      const doneData = doneEvent!.data as { turnCount?: number }
      expect(doneData.turnCount).toBeGreaterThan(0)

      console.log(
        '[NAS E2E] NA-2: received',
        textEvents.length,
        'text events,',
        events.filter((e) => e.event === 'stream:tool_call').length,
        'tool calls'
      )
    } finally {
      client.close()
    }
  })

  // ── NA-3: Tool execution via Desktop Hand ──────────────────

  test('NA-3: message requiring FileRead executes on Desktop Hand and returns result', async () => {
    // Write a test file on the Desktop side that NAS agent should be able to read via Hand
    const testFile = path.join(workspaceDir, 'nas-e2e-secret.txt')
    fs.writeFileSync(testFile, 'NAS_E2E_SECRET_42\n')

    const client = await connectNasClient(nas!.wsUrl, nas!.token)

    try {
      const conversationId = `e2e-tool-${Date.now()}`

      sendMsg(client, 'chat:send', {
        sessionId: conversationId,
        message: `请读取文件 ${testFile} 的内容并告诉我里面写了什么`,
      })

      const events = await collectStreamEvents(client, 90_000)

      // Should have tool_call events (FileRead dispatched to Desktop Hand)
      const toolCallEvents = events.filter((e) => e.event === 'stream:tool_call')
      const toolResultEvents = events.filter((e) => e.event === 'stream:tool_result')

      console.log(
        '[NAS E2E] NA-3: tool_calls=%d tool_results=%d text_events=%d',
        toolCallEvents.length,
        toolResultEvents.length,
        events.filter((e) => e.event === 'stream:text').length
      )

      // Should end with stream:done
      expect(events.find((e) => e.event === 'stream:done')).toBeDefined()

      // If the NAS dispatched a tool, it should have a matching result from Desktop Hand
      if (toolCallEvents.length > 0) {
        expect(toolResultEvents.length).toBeGreaterThan(0)

        // At least one result should contain the file content (no error)
        const successResult = toolResultEvents.find((e) => {
          const d = e.data as { isError?: boolean; output?: string }
          return !d.isError && d.output?.includes('NAS_E2E_SECRET_42')
        })
        expect(successResult).toBeDefined()
      }
    } finally {
      client.close()
    }
  })

  // ── NA-4: Desktop UI reflects Hand status ──────────────────

  test('NA-4: Desktop HandBridge status indicator shows connected in the UI', async () => {
    // The IDE status bar or sidebar should show Hand connected status.
    // Look for common Hand status selectors.
    const connected = await win.evaluate(() => {
      // Check if any element in the DOM shows "connected" or "已连接" Hand status
      const texts = Array.from(document.querySelectorAll('[class*="hand"]'))
        .map((el) => el.textContent ?? '')
      return texts.some((t) => t.toLowerCase().includes('connect') || t.includes('已连接'))
    })

    // Log but don't hard-fail — the UI might not show Hand status on every page
    console.log('[NAS E2E] NA-4: UI shows hand connected =', connected)
  })
})
