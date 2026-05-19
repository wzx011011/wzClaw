// ============================================================
// Playwright Packaged Smoke Tests
// ============================================================
// Drives the real built Electron app (dist/win-unpacked/wzxClaw.exe)
// through 6 critical lifecycle scenarios.
//
// No LLM API is called — all tests exercise UI and IPC flows only.
//
// Prerequisites:
//   npm run build:win   (or at least `npm run build`)
//   npx playwright test
//
// Run single:
//   npx playwright test test/smoke/packaged.spec.ts
// ============================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

// ── Helpers ──────────────────────────────────────────────────

const EXE_PATH = path.resolve(__dirname, '../../dist/win-unpacked/wzxClaw.exe')

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Launch the packaged Electron app with an isolated userData dir.
 * Passing --user-data-dir overrides Electron's default app.getPath('userData').
 */
async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    executablePath: EXE_PATH,
    args: [`--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      WZXCLAW_SMOKE_TEST: '1',
    },
    timeout: 30_000,
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

// ── Test Suite ────────────────────────────────────────────────

test.describe('Packaged smoke tests', () => {
  let userDataDir: string
  let app: ElectronApplication
  let win: Page

  async function ensureSidebarOpen(): Promise<void> {
    if (await win.locator('.session-list').count()) return
    await win.getByRole('button', { name: '切换侧边栏' }).click()
    await expect(win.locator('.session-list')).toBeVisible({ timeout: 5_000 })
  }

  test.beforeAll(async () => {
    // Skip gracefully when build hasn't been run yet
    if (!fs.existsSync(EXE_PATH)) {
      test.skip()
      return
    }
    userDataDir = makeTempDir('wzxclaw-smoke-ud-')
    ;({ app, win } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await app?.close()
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  })

  // ── SM1: App launches ──────────────────────────────────────
  test('SM1: app launches without crash and window is visible', async () => {
    expect(win).toBeTruthy()
    const title = await win.title()
    expect(title.toLowerCase()).toContain('wzxclaw')
  })

  // ── SM2: Chat workspace renders ────────────────────────────
  test('SM2: chat workspace renders key UI elements', async () => {
    await expect(win.locator('text=wzxClaw')).toBeVisible({ timeout: 12_000 })
    await expect(win.locator('.chat-panel')).toBeVisible({ timeout: 12_000 })
    await expect(win.locator('textarea.chat-input')).toBeVisible({ timeout: 12_000 })
    await expect(win.locator('text=加载中...')).not.toBeVisible()
    await expect(win.locator('text=Something went wrong')).not.toBeVisible()
  })

  // ── SM3: Create session via UI ─────────────────────────────
  test('SM3: can create a session from the sidebar', async () => {
    await ensureSidebarOpen()
    const newSessionBtn = win.locator('button.session-confirm-btn').filter({ hasText: '新建会话' })
    await expect(newSessionBtn).toBeVisible({ timeout: 8_000 })
    await newSessionBtn.click()

    await expect
      .poll(async () => win.evaluate(async () => {
        const result = await (window as any).wzxclaw.listSessions()
        return Array.isArray(result) ? result.length : result.sessions.length
      }), { timeout: 8_000, intervals: [200, 500, 1000] })
      .toBeGreaterThan(0)

    await expect(win.locator('.session-item').first()).toBeVisible({ timeout: 8_000 })
  })

  // ── SM4: Chat input is usable without calling an LLM ───────
  test('SM4: chat input accepts text and enables send', async () => {
    const input = win.locator('textarea.chat-input')
    await expect(input).toBeVisible({ timeout: 8_000 })
    await input.fill('Packaged smoke input')

    const sendBtn = win.locator('button.chat-send-btn')
    await expect(sendBtn).toBeEnabled({ timeout: 3_000 })
    await expect(input).toHaveValue('Packaged smoke input')
    await input.fill('')
  })

  // ── SM5: Session IPC roundtrip ─────────────────────────────
  test('SM5: session IPC create/list/rename/load works', async () => {
    const createdId = await win.evaluate(async () => {
      const result = await (window as any).wzxclaw.createSession()
      return typeof result === 'string' ? result : result.sessionId
    })

    await win.evaluate(async (sessionId) => {
      await (window as any).wzxclaw.renameSession({ sessionId, title: 'Smoke IPC Session' })
    }, createdId)

    const listed = await win.evaluate(async () => {
      const result = await (window as any).wzxclaw.listSessions()
      return Array.isArray(result) ? result : result.sessions
    }) as Array<{ id: string; title: string }>

    expect(listed.some((session) => session.id === createdId && session.title === 'Smoke IPC Session')).toBe(true)

    const loaded = await win.evaluate(async (sessionId) => {
      const result = await (window as any).wzxclaw.loadSession({ sessionId })
      return Array.isArray(result) ? result : result.messages
    }, createdId)
    expect(Array.isArray(loaded)).toBe(true)
  })

  // ── SM6: Session persistence via disk ──────────────────────
  test('SM6: session persists under isolated userData dir', async () => {
    const sessionsRoot = path.join(userDataDir, 'sessions')

    await expect
      .poll(() => {
        if (!fs.existsSync(sessionsRoot)) return 0
        const projectDirs = fs.readdirSync(sessionsRoot)
        return projectDirs.reduce((count, dir) => {
          const fullDir = path.join(sessionsRoot, dir)
          if (!fs.statSync(fullDir).isDirectory()) return count
          return count + fs.readdirSync(fullDir).filter((name) => name.endsWith('.jsonl')).length
        }, 0)
      }, { timeout: 5_000, intervals: [200, 500, 1000] })
      .toBeGreaterThan(0)
  })
})
