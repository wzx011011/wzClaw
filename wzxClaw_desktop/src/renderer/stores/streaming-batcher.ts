// ============================================================
// StreamingBatcher — rAF 文本批处理，减少逐 token 重渲染
// 从 chat-store.ts 模块级变量提取为显式类
// ============================================================

/**
 * 将流式文本/思考事件通过 requestAnimationFrame 合并，
 * 避免每个 token 触发一次 Zustand set → React 重渲染。
 */
export class StreamingBatcher {
  textBuffer = ''
  textFrame: number | null = null
  thinkingBuffer = ''
  thinkingFrame: number | null = null

  reset(): void {
    this.textBuffer = ''
    this.thinkingBuffer = ''
    if (this.textFrame !== null) {
      cancelAnimationFrame(this.textFrame)
      this.textFrame = null
    }
    if (this.thinkingFrame !== null) {
      cancelAnimationFrame(this.thinkingFrame)
      this.thinkingFrame = null
    }
  }
}
