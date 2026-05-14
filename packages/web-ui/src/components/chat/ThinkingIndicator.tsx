// ============================================================
// ThinkingIndicator — 流式等待首 token 时的脉冲动画
// 从桌面端提取，移除 i18n 依赖，直接使用中文文本
// ============================================================

import React, { useState, useEffect } from 'react'

/** 思考中轮播短语 */
const PHRASES = [
  '正在思考...',
  '分析问题中...',
  '整理思路...',
  '生成回复...',
]

const CYCLE_MS = 3000

/**
 * ThinkingIndicator — 脉冲动画 + 轮播短语
 * 使用 CSS 动画替代 JS 状态控制透明度过渡
 */
export default function ThinkingIndicator(): React.ReactElement {
  const [phraseIndex, setPhraseIndex] = useState(
    () => Math.floor(Math.random() * PHRASES.length)
  )

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % PHRASES.length)
    }, CYCLE_MS)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="thinking-indicator">
      <span className="thinking-dot" />
      <span className="thinking-phrase thinking-fade">
        {PHRASES[phraseIndex]}
      </span>
    </div>
  )
}
