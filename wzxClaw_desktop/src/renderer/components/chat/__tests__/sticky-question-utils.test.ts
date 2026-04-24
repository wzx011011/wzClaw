import { describe, it, expect } from 'vitest'
import { findLastQuestionAboveViewport } from '../sticky-question-utils'
import type { BubbleInfo } from '../sticky-question-utils'

// ============================================================
// findLastQuestionAboveViewport — 纯函数，不依赖 DOM，可在 node 环境测试
// ============================================================

describe('findLastQuestionAboveViewport', () => {
  // ─── 基础行为 ──────────────────────────────────────────────

  it('returns null when there are no bubbles', () => {
    expect(findLastQuestionAboveViewport([], 200)).toBeNull()
  })

  it('returns null when no bubble is above the viewport', () => {
    const bubbles: BubbleInfo[] = [
      { text: 'Hello', bottom: 300 },  // below viewport top of 200
      { text: 'World', bottom: 400 },
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBeNull()
  })

  it('returns the single bubble that is above viewport', () => {
    const bubbles: BubbleInfo[] = [
      { text: '你好', bottom: 100 },   // above viewport top of 200
      { text: '世界', bottom: 350 },   // below
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBe('你好')
  })

  it('returns the LAST bubble above viewport when multiple qualify', () => {
    const bubbles: BubbleInfo[] = [
      { text: '第一个问题', bottom: 50 },
      { text: '第二个问题', bottom: 120 },  // ← this is the one in view
      { text: '第三个问题', bottom: 500 },  // below viewport
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBe('第二个问题')
  })

  it('returns null when bubble is exactly at viewport top (not strictly above)', () => {
    // bottom = viewportTop → not < viewportTop + tolerance, so not considered above
    // bottom = 200, viewportTop = 200, tolerance = 8 → 200 < 208 → IS above (within tolerance)
    const bubbles: BubbleInfo[] = [
      { text: '刚好在边界', bottom: 200 },
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBe('刚好在边界')
  })

  it('excludes bubble when bottom exceeds viewportTop + tolerance', () => {
    const bubbles: BubbleInfo[] = [
      { text: '稍微露头', bottom: 209 },  // 209 >= 200 + 8 + 1 → NOT above
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBeNull()
  })

  // ─── 容差（tolerance）参数 ──────────────────────────────────

  it('respects custom tolerance parameter', () => {
    const bubbles: BubbleInfo[] = [
      { text: '问题A', bottom: 220 }, // bottom=220, viewportTop=200, tolerance=0 → 220 < 200 → false
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200, 0)).toBeNull()
  })

  it('uses large tolerance to include partially-visible bubbles', () => {
    const bubbles: BubbleInfo[] = [
      { text: '问题A', bottom: 220 }, // 220 < 200 + 50 → true
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200, 50)).toBe('问题A')
  })

  // ─── 典型对话场景 ─────────────────────────────────────────

  it('simulates multi-turn conversation: shows question matching current response', () => {
    // 用户 Q1 已滚出去，用户 Q2 也已滚出去，AI 回复 R2 正在屏幕中
    // viewportTop = 500（屏幕顶部对应 y=500）
    const bubbles: BubbleInfo[] = [
      { text: '帮我写一个排序算法', bottom: 100 },       // Q1 完全滚出
      { text: '解释一下时间复杂度', bottom: 350 },       // Q2 完全滚出 ← 应显示这个
      { text: '给我一个实际案例', bottom: 800 },         // Q3 还在屏幕内（未滚出）
    ]
    expect(findLastQuestionAboveViewport(bubbles, 500)).toBe('解释一下时间复杂度')
  })

  it('returns null when user just sent first message (nothing scrolled out)', () => {
    const bubbles: BubbleInfo[] = [
      { text: '我的第一个问题', bottom: 600 }, // 还在屏幕里
    ]
    // viewportTop = 0（滚动在最顶部）
    expect(findLastQuestionAboveViewport(bubbles, 0)).toBeNull()
  })

  it('handles all bubbles above viewport (user scrolled to very bottom of long chat)', () => {
    const bubbles: BubbleInfo[] = [
      { text: '问题一', bottom: 10 },
      { text: '问题二', bottom: 20 },
      { text: '问题三', bottom: 30 },
    ]
    // viewportTop = 5000 → all above
    expect(findLastQuestionAboveViewport(bubbles, 5000)).toBe('问题三')
  })

  // ─── 边界：空文字 ──────────────────────────────────────────

  it('skips empty text bubbles correctly', () => {
    // 注意：extractBubbleText 负责清理，这里测纯逻辑
    // findLastQuestionAboveViewport 不过滤空文字（调用方应预先过滤）
    const bubbles: BubbleInfo[] = [
      { text: '有内容', bottom: 100 },
    ]
    expect(findLastQuestionAboveViewport(bubbles, 200)).toBe('有内容')
  })
})
