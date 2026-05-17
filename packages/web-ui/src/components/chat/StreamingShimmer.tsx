// ============================================================
// StreamingShimmer — LLM 流式占位动效
//
// 流式响应等待时显示 3 行 shimmer 动画。
// 纯 CSS 动画，无 JS 依赖。
// ============================================================

import React from 'react'

interface StreamingShimmerProps {
  visible: boolean
}

export default function StreamingShimmer({ visible }: StreamingShimmerProps): React.ReactElement | null {
  if (!visible) return null

  return (
    <div className="streaming-shimmer">
      <div className="shimmer-line" style={{ width: '80%' }} />
      <div className="shimmer-line" style={{ width: '60%' }} />
      <div className="shimmer-line" style={{ width: '40%' }} />
    </div>
  )
}
