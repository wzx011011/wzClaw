// ============================================================
// FloatingBar — 浮动通知容器
//
// 定位在 BottomTabBar 上方，内容区下方。
// 渲染 PermissionBar / PlanModeBar（当前为 UI 骨架）。
// ============================================================

import React from 'react'
import PermissionBar from './PermissionBar'
import PlanModeBar from './PlanModeBar'

export default function FloatingBar(): React.ReactElement {
  return (
    <div className="floating-bar">
      <PermissionBar />
      <PlanModeBar />
    </div>
  )
}
