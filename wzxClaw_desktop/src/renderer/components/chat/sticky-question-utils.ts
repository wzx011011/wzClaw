// ============================================================
// Sticky Question Bar — 纯逻辑工具函数（与 DOM 无关，可单元测试）
// ============================================================

export interface BubbleInfo {
  /** 气泡的文字内容（已去除 mention-blocks 部分） */
  text: string
  /** 气泡底部相对于文档顶部的 y 坐标（BoundingClientRect.bottom） */
  bottom: number
}

/**
 * 从用户气泡列表里找出"最后一个已完全滚出视口顶部"的气泡文字。
 *
 * 规则：
 *   - 气泡按从上到下排列（bottom 递增）
 *   - bottom < viewportTop + tolerance 表示已完全滚出视口
 *   - 取所有符合条件中最靠下（bottom 最大）的那条 → 就是当前对应回复的问题
 *
 * @param bubbles       所有用户气泡信息，按文档顺序（从上到下）
 * @param viewportTop   消息容器顶部的 y 坐标
 * @param tolerance     允许气泡底部超出容器顶部的像素容差（默认 8px）
 * @returns 问题文字，或 null（没有气泡滚出去）
 */
export function findLastQuestionAboveViewport(
  bubbles: BubbleInfo[],
  viewportTop: number,
  tolerance = 8
): string | null {
  let result: string | null = null
  for (const bubble of bubbles) {
    if (bubble.bottom < viewportTop + tolerance) {
      result = bubble.text
    } else {
      // 气泡按顺序排列，一旦不满足条件就可以停止
      break
    }
  }
  return result
}

/**
 * 从 HTMLElement 中提取纯文字（去掉 .mention-blocks 子树）。
 * 在测试外使用；测试时直接构造 BubbleInfo 即可。
 */
export function extractBubbleText(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement
  const mb = clone.querySelector('.mention-blocks')
  if (mb) mb.remove()
  return clone.textContent?.trim() ?? ''
}
