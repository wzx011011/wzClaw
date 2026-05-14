// ============================================================
// ToolCallGroup — 工具调用分组容器
// 从桌面端提取，简化版：
// - 保留：WorkflowHeader（工具数 >= 3 时显示摘要行）
// - 保留：左侧竖线连接（始终显示）
// - 保留：折叠/展开逻辑、自动折叠
// - 移除：嵌套子工具（children 渲染）
//
// 视觉结构：
//   [WorkflowHeader]  ← toolCalls.length >= 3 时显示
//   │
//   ├─ ▌ [ToolCard A]   ← 左侧竖线
//   ├─ ▌ [ToolCard B]
//   └─ ▌ [ToolCard C]
// ============================================================

import React, { useState, useEffect, useRef } from 'react'
import ToolCard from './ToolCard'
import type { ToolCallInfo } from '../../stores/streaming-batcher'

interface ToolCallGroupProps {
  toolCalls: ToolCallInfo[]
}

// ---- Workflow Header ----------------------------------------

interface WorkflowHeaderProps {
  toolCalls: ToolCallInfo[]
  collapsed: boolean
  onToggle: () => void
}

/** 构建摘要行 — 统计工具类型和数量 */
function buildSummary(toolCalls: ToolCallInfo[]): string {
  const counts: Record<string, number> = {}
  for (const tc of toolCalls) {
    counts[tc.name] = (counts[tc.name] ?? 0) + 1
  }
  const parts = Object.entries(counts)
    .slice(0, 4)
    .map(([name, n]) => (n > 1 ? `${name}(${n})` : name))
  return parts.join(', ')
}

function WorkflowHeader({ toolCalls, collapsed, onToggle }: WorkflowHeaderProps): React.ReactElement {
  const doneCount = toolCalls.filter((tc) => tc.status !== 'running').length
  const totalCount = toolCalls.length
  const allDone = doneCount === totalCount
  const hasError = toolCalls.some((tc) => tc.status === 'error')

  return (
    <div
      className="tool-workflow-header"
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle()
        }
      }}
    >
      <span className="tool-workflow-toggle">{collapsed ? '▶' : '▼'}</span>

      <span className="tool-workflow-label">
        {allDone ? (
          buildSummary(toolCalls)
        ) : (
          <span className="tool-workflow-shimmer">
            执行中... ({doneCount}/{totalCount})
          </span>
        )}
      </span>

      <span className="tool-workflow-status">
        {hasError ? (
          <span style={{ color: 'var(--tool-error)' }}>⚠</span>
        ) : allDone ? (
          <span style={{ color: 'var(--tool-completed)' }}>✓</span>
        ) : (
          <span className="tool-workflow-spinner" />
        )}
      </span>
    </div>
  )
}

// ---- 主组件 ----------------------------------------

export default function ToolCallGroup({ toolCalls }: ToolCallGroupProps): React.ReactElement {
  const showHeader = toolCalls.length >= 3
  const showRail = true  // 始终显示左侧竖线

  const allDone = toolCalls.every((tc) => tc.status !== 'running')
  const prevAllDoneRef = useRef(allDone)

  // 自动折叠：全部完成时折叠；有工具开始 running 时展开
  const [collapsed, setCollapsed] = useState(false)

  // 工具列表入场动画 key
  const [enterKey, setEnterKey] = useState(0)

  useEffect(() => {
    const wasAllDone = prevAllDoneRef.current
    prevAllDoneRef.current = allDone

    if (allDone && !wasAllDone) {
      // 刚刚全部完成 → 自动折叠
      if (showHeader) setCollapsed(true)
    } else if (!allDone && wasAllDone) {
      // 重新有工具 running → 自动展开
      setCollapsed(false)
    }
  }, [allDone, showHeader])

  const handleToggle = () => {
    setCollapsed((prev) => {
      if (prev) {
        // 即将展开 → 触发入场动画
        setEnterKey((k) => k + 1)
      }
      return !prev
    })
  }

  const toolsVisible = !collapsed || !showHeader

  return (
    <div className="tool-call-group">
      {showHeader && (
        <WorkflowHeader
          toolCalls={toolCalls}
          collapsed={collapsed}
          onToggle={handleToggle}
        />
      )}

      {toolsVisible && (
        showRail ? (
          <div className="tool-call-group-rail">
            <div className={`tool-call-group-line${allDone ? ' done' : ''}`} />
            <div
              key={enterKey}
              className={`tool-call-group-tools${enterKey > 0 ? ' tool-call-group-tools-enter' : ''}`}
            >
              {toolCalls.map((tc) => (
                <ToolCard key={tc.id} toolCall={tc} />
              ))}
            </div>
          </div>
        ) : (
          // 单工具：无竖线（不会到这里，showRail 始终 true）
          <div>
            {toolCalls.map((tc) => (
              <ToolCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )
      )}
    </div>
  )
}
