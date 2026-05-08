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

  // ── SM2: Home page renders ─────────────────────────────────
  test('SM2: workspace home page renders key UI elements', async () => {
    // The WorkspaceHomePage renders h1.workspace-home-title = "工作区"
    const heading = win.locator('h1.workspace-home-title')
    await expect(heading).toBeVisible({ timeout: 12_000 })
    await expect(heading).toHaveText('工作区')

    // No error boundary
    await expect(win.locator('text=Something went wrong')).not.toBeVisible()
  })

  // ── SM3: Create workspace ──────────────────────────────────
  test('SM3: can create a workspace and see it in the list', async () => {
    // Click "+ 新建工作区" button in header
    const newWsBtn = win.locator('button.workspace-btn-primary').filter({ hasText: '新建工作区' })
    await expect(newWsBtn).toBeVisible({ timeout: 8_000 })
    await newWsBtn.click()

    // Modal title "新建工作区" should appear
    await expect(win.locator('.workspace-modal-title')).toBeVisible({ timeout: 5_000 })

    // Fill the WORKSPACE NAME input (id="workspace-title") — NOT the folder path input
    const nameInput = win.locator('#workspace-title')
    await expect(nameInput).toBeVisible({ timeout: 5_000 })
    await nameInput.fill('Smoke Test')

    // The "创建" submit button should now be enabled
    const createBtn = win.locator('button[type="submit"].workspace-btn-primary')
    await expect(createBtn).toBeEnabled({ timeout: 3_000 })
    await createBtn.click()

    // Workspace appears in WorkspaceDetailPage (title is shown)
    await expect(win.locator('text=Smoke Test')).toBeVisible({ timeout: 8_000 })
  })

  // ── SM4: Enter IDE layout ──────────────────────────────────
  test('SM4: entering a workspace opens the IDE layout', async () => {
    // WorkspaceDetailPage shows "进入工作区" button (.workspace-detail-enter-btn)
    const enterBtn = win.locator('.workspace-detail-enter-btn')
    await expect(enterBtn).toBeVisible({ timeout: 8_000 })
    await enterBtn.click()

    // IDELayout has an activity bar
    await expect(win.locator('.activity-bar')).toBeVisible({ timeout: 15_000 })

    // Chat input should also be present
    await expect(win.locator('.chat-input-textarea, textarea.chat-input, .chat-input')).toBeVisible({ timeout: 10_000 })
  })

  // ── SM5: Session creation via sidebar ─────────────────────
  test('SM5: session sidebar panel is accessible and new-session button works', async () => {
    // Click the ActivityBar sessions icon (title="会话管理")
    const sessionsBtn = win.locator('.activity-bar-item[title="会话管理"]')
    await expect(sessionsBtn).toBeVisible({ timeout: 5_000 })
    await sessionsBtn.click()

    // Sessions panel should now be visible
    const sessionsPanel = win.locator('.sidebar-sessions')
    await expect(sessionsPanel).toBeVisible({ timeout: 5_000 })

    // New session button in sidebar header should be present and clickable
    const newSessionBtn = win.locator('.sidebar-new-session-btn')
    await expect(newSessionBtn).toBeVisible({ timeout: 5_000 })

    // Click it — createSession() resets conversationId but doesn't write to disk
    // until the first message is sent, so we only verify the click succeeds
    await newSessionBtn.click()

    // The sessions panel container remains visible after the click
    await expect(sessionsPanel).toBeVisible({ timeout: 3_000 })
  })

  // ── SM6: Workspace persistence via disk ─────────────────────
  test('SM6: workspace persists — workspaces.json written to userData dir', async () => {
    // The main process saves workspaces to {userData}/workspaces.json.
    // Reading the file directly (no IPC) is the most reliable verification.
    const wsJsonPath = path.join(userDataDir, 'workspaces.json')

    // Wait up to 5 s for the file to be flushed to disk
    await expect
      .poll(() => fs.existsSync(wsJsonPath), { timeout: 5_000, intervals: [200, 500, 1000] })
      .toBe(true)

    const raw = fs.readFileSync(wsJsonPath, 'utf-8')
    const list = JSON.parse(raw) as Array<{ title: string; archived?: boolean }>

    expect(Array.isArray(list)).toBe(true)
    expect(list.length).toBeGreaterThan(0)
    const titles = list.map((w) => w.title)
    expect(titles).toContain('Smoke Test')
  })
})
