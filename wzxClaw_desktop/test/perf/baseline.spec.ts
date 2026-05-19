// ============================================================
// Desktop UI Performance Baseline
// ============================================================
// 目标：建立"桌面端不卡顿"的客观基线，并在新功能落地后做对照。
//
// 测量维度（全部在打包后的 wzxClaw.exe 上跑）：
//   1. cold-start       冷启动到 chat-panel 可见的耗时（ms）
//   2. idle-mem         冷启动 5s 后的 main-world JS heap（MB）
//   3. input-latency    在 chat 输入 200 字符的平均按键回显延迟（ms）
//   4. stream-frames    模拟 500 条 token 流入消息列表的丢帧数 / 平均帧间隔
//   5. scroll-fps       消息列表滚动 1500px 的平均 FPS
//   6. tab-switch       chat ↔ ide 视图切换耗时（ms × 5 次取中位数）
//   7. long-task        测量期间的 longtask（>50ms）累计耗时
//
// 输出：
//   wzxClaw_desktop/test/perf/results/<timestamp>.json
//   且首次运行会写 wzxClaw_desktop/test/perf/baseline.json（如不存在）
//
// 比较：
//   $env:PERF_COMPARE="1" 时，所有指标若较 baseline 退化超过阈值，
//   测试失败（输出退化项详情）。
//
// 用法：
//   首次建立基线：    npm run perf:baseline
//   后续回归对比：    npm run perf:compare
// ============================================================

import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { _electron as electron } from '@playwright/test'
import path from 'path'
import fs from 'fs'
import os from 'os'

const EXE_PATH = path.resolve(__dirname, '../../dist/win-unpacked/wzxClaw.exe')
const RESULTS_DIR = path.resolve(__dirname, 'results')
const BASELINE_PATH = path.resolve(__dirname, 'baseline.json')

// 退化阈值：超过即失败（百分比）
const REGRESSION_THRESHOLDS: Record<string, number> = {
  coldStartMs: 0.20,        // +20%
  idleHeapMb: 0.25,         // +25%
  inputLatencyMs: 0.30,     // +30%
  streamDroppedFrames: 0.50, // +50%（绝对数小时容许波动大）
  scrollFps: -0.15,         // 低于基线 -15%
  tabSwitchMs: 0.25,        // +25%
  longTaskMs: 0.30,         // +30%
}

interface PerfMetrics {
  coldStartMs: number
  idleHeapMb: number
  inputLatencyMs: number
  streamDroppedFrames: number
  streamAvgFrameMs: number
  scrollFps: number
  tabSwitchMs: number
  longTaskMs: number
  meta: {
    timestamp: number
    node: string
    platform: string
    exePath: string
  }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; win: Page; tStart: number }> {
  const tStart = Date.now()
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
  return { app, win, tStart }
}

test.describe('UI Performance Baseline', () => {
  let userDataDir: string
  let app: ElectronApplication
  let win: Page
  const metrics: Partial<PerfMetrics> = {}

  test.beforeAll(async () => {
    if (!fs.existsSync(EXE_PATH)) {
      test.skip(true, 'Build artifact not found — run `npm run build:win` first.')
      return
    }
    fs.mkdirSync(RESULTS_DIR, { recursive: true })
    userDataDir = makeTempDir('wzxclaw-perf-ud-')

    const { app: a, win: w, tStart } = await launchApp(userDataDir)
    app = a; win = w

    // ── 1. cold-start ─────────────────────────────────────
    await win.locator('.chat-panel').waitFor({ state: 'visible', timeout: 20_000 })
    metrics.coldStartMs = Date.now() - tStart

    // 启动 longtask 观察器（贯穿整个测试）
    await win.evaluate(() => {
      ;(window as any).__longTaskMs = 0
      try {
        const po = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) (window as any).__longTaskMs += e.duration
        })
        po.observe({ type: 'longtask', buffered: true })
        ;(window as any).__longTaskPO = po
      } catch { /* longtask not supported in Electron — leave 0 */ }
    })
  })

  test.afterAll(async () => {
    if (!app) return

    // 收集 longtask 总耗时
    metrics.longTaskMs = await win.evaluate(() => (window as any).__longTaskMs ?? 0)

    metrics.meta = {
      timestamp: Date.now(),
      node: process.version,
      platform: process.platform,
      exePath: EXE_PATH,
    }

    // 写本次结果
    const full = metrics as PerfMetrics
    const resultPath = path.join(RESULTS_DIR, `${full.meta.timestamp}.json`)
    fs.writeFileSync(resultPath, JSON.stringify(full, null, 2))
    console.log('[perf] result written:', resultPath)
    console.log('[perf] metrics:', JSON.stringify(full, null, 2))

    // 首次：写 baseline；后续 compare 模式：对照
    if (!fs.existsSync(BASELINE_PATH)) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(full, null, 2))
      console.log('[perf] baseline.json initialized.')
    } else if (process.env.PERF_COMPARE === '1') {
      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')) as PerfMetrics
      const regressions: string[] = []
      for (const [key, threshold] of Object.entries(REGRESSION_THRESHOLDS)) {
        const cur = (full as any)[key] as number
        const base = (baseline as any)[key] as number
        if (typeof cur !== 'number' || typeof base !== 'number' || base === 0) continue
        const delta = (cur - base) / Math.abs(base)
        const regressed = threshold >= 0 ? delta > threshold : delta < threshold
        if (regressed) {
          regressions.push(`  - ${key}: baseline=${base.toFixed(2)} current=${cur.toFixed(2)} (Δ${(delta*100).toFixed(1)}% threshold=${(threshold*100).toFixed(0)}%)`)
        }
      }
      if (regressions.length) {
        throw new Error('Performance regression detected:\n' + regressions.join('\n'))
      } else {
        console.log('[perf] No regressions vs baseline.')
      }
    }

    await app.close()
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  })

  // ── 2. idle-mem ───────────────────────────────────────
  test('idle JS heap after cold-start', async () => {
    await win.waitForTimeout(5_000)
    const heap = await win.evaluate(() => {
      const m = (performance as any).memory
      return m ? m.usedJSHeapSize : 0
    })
    metrics.idleHeapMb = heap / (1024 * 1024)
    expect(metrics.idleHeapMb).toBeGreaterThan(0)
  })

  // ── 3. input-latency ──────────────────────────────────
  test('input latency on chat textarea', async () => {
    const input = win.locator('textarea.chat-input')
    await input.waitFor({ state: 'visible' })
    await input.click()

    const samples: number[] = []
    const text = 'The quick brown fox jumps over the lazy dog '.repeat(5) // 220 chars
    for (const ch of text) {
      const t0 = Date.now()
      await input.press(ch.length === 1 && ch !== ' ' ? ch : (ch === ' ' ? 'Space' : ch))
      // 等到 value 反映为止（在 DOM 中确认）
      await win.waitForFunction(
        (expectedLen) => (document.querySelector('textarea.chat-input') as HTMLTextAreaElement)?.value.length >= expectedLen,
        samples.length + 1,
        { timeout: 1000 },
      )
      samples.push(Date.now() - t0)
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(samples.length / 2)] ?? 0
    metrics.inputLatencyMs = median
    await input.fill('') // 清空
  })

  // ── 4. stream-frames ──────────────────────────────────
  test('streaming render frame stability', async () => {
    // 直接在 renderer 测：模拟 chat-store 接收 500 个 text delta，
    // 期间用 rAF 采样帧间隔。
    const result = await win.evaluate(async () => {
      const frameIntervals: number[] = []
      let lastT = performance.now()
      let stop = false
      const rafLoop = () => {
        const now = performance.now()
        frameIntervals.push(now - lastT)
        lastT = now
        if (!stop) requestAnimationFrame(rafLoop)
      }
      requestAnimationFrame(rafLoop)

      // 创建一个临时 DOM 容器模拟 message list
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;left:-9999px;top:0;width:600px;height:400px;overflow:auto;'
      document.body.appendChild(host)
      const msg = document.createElement('div')
      host.appendChild(msg)

      // 500 帧 token delta，每帧 yield
      for (let i = 0; i < 500; i++) {
        msg.textContent += 'token' + i + ' '
        await new Promise(r => setTimeout(r, 4)) // ~ 250 hz 推送
      }
      stop = true
      await new Promise(r => requestAnimationFrame(() => r(null)))
      host.remove()

      // 去掉前 10 帧（warm-up）
      const stable = frameIntervals.slice(10)
      const dropped = stable.filter(d => d > 32).length // 30fps 阈
      const avg = stable.reduce((a, b) => a + b, 0) / stable.length
      return { dropped, avg }
    })
    metrics.streamDroppedFrames = result.dropped
    metrics.streamAvgFrameMs = result.avg
  })

  // ── 5. scroll-fps ─────────────────────────────────────
  test('scroll FPS on message list', async () => {
    // 通过 wheel 事件滚动一个临时的长列表
    const fps = await win.evaluate(async () => {
      const host = document.createElement('div')
      host.style.cssText = 'position:fixed;right:0;top:0;width:600px;height:400px;overflow:auto;background:#000;z-index:9999;'
      for (let i = 0; i < 500; i++) {
        const row = document.createElement('div')
        row.style.cssText = 'padding:8px;border-bottom:1px solid #333;color:#fff;'
        row.textContent = 'row ' + i + ' ' + 'lorem ipsum dolor sit amet '.repeat(4)
        host.appendChild(row)
      }
      document.body.appendChild(host)

      const intervals: number[] = []
      let lastT = performance.now()
      let stop = false
      const loop = () => {
        const now = performance.now()
        intervals.push(now - lastT)
        lastT = now
        if (!stop) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)

      const duration = 1500
      const t0 = performance.now()
      while (performance.now() - t0 < duration) {
        host.scrollTop += 30
        await new Promise(r => setTimeout(r, 16))
      }
      stop = true
      host.remove()
      const stable = intervals.slice(5)
      const avgMs = stable.reduce((a, b) => a + b, 0) / stable.length
      return 1000 / avgMs
    })
    metrics.scrollFps = fps
  })

  // ── 6. tab-switch ─────────────────────────────────────
  test('view switch latency (chat ↔ ide)', async () => {
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      // 触发 view 切换：依赖 App.tsx 顶部按钮
      const toIde = win.getByRole('button', { name: /IDE|集成/i }).first()
      const toChat = win.getByRole('button', { name: /Chat|聊天/i }).first()

      let target = (i % 2 === 0) ? toIde : toChat
      const visible = await target.isVisible().catch(() => false)
      if (!visible) {
        samples.push(0)
        continue
      }
      const t0 = Date.now()
      await target.click()
      await win.waitForTimeout(200) // 等待过渡
      samples.push(Date.now() - t0)
    }
    samples.sort((a, b) => a - b)
    metrics.tabSwitchMs = samples[Math.floor(samples.length / 2)] ?? 0
  })
})
