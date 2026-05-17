// ============================================================
// AnimatedMessageItem — 消息进入动画包裹器
//
// 纯 CSS slideInUp 动画，200ms ease-out。
// 仅在首次 mount 时触发。
// ============================================================

import React from 'react'

interface AnimatedMessageItemProps {
  children: React.ReactNode
}

export default function AnimatedMessageItem({ children }: AnimatedMessageItemProps): React.ReactElement {
  return (
    <div className="animated-message-item">
      {children}
    </div>
  )
}
