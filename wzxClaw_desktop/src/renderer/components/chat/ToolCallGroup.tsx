import React, { useState, useEffect, useRef } from 'react'
import ToolCard from './ToolCard'

// ============================================================
// ToolCallGroup — 工具调用分组容器
// 对标手机端 ToolCallGroup + _WorkflowHeader（tool_call_list.dart）
//
// 视觉结构：
//   [WorkflowHeader]  ← toolCalls.length >= 3 时显示
//   │
//   ├─ ▌ [ToolCard A]   ← 左侧 2px 竖线（toolCalls.length >= 2）
//   ├─ ▌ [ToolCard B]
//   └─ ▌ [ToolCard C]
// ============================================================

interface ToolCallInfo {
  id: string
  name: string
  status: 'running' | 'completed' | 'error'
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
  progress?: string
  children?: ToolCallInfo[]
  subText?: string
}

interface ToolCallGroupProps {
  toolCalls: ToolCallInfo[]
  originalContent?: string
}

// ---- Workflow Header ----------------------------------------

interface WorkflowHeaderProps {
  toolCalls: ToolCallInfo[]
  collapsed: boolean
  onToggle: () => void
}

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

function WorkflowHeader({ toolCalls, collapsed, onToggle }: WorkflowHeaderProps): JSX.Element {
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
            Working... ({doneCount}/{totalCount})
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

// ---- Main Component ----------------------------------------

export default function ToolCallGroup({ toolCalls, originalContent }: ToolCallGroupProps): JSX.Element {
  const showHeader = toolCalls.length >= 3
  const showRail = toolCalls.length >= 1  // 对标手机端：始终显示左侧竖线

  const allDone = toolCalls.every((tc) => tc.status !== 'running')
  const prevAllDoneRef = useRef(allDone)

  // 自动折叠：全部完成时 → 折叠；有工具开始 running → 展开
  const [collapsed, setCollapsed] = useState(false)

  // 工具列表入场动画 key：展开时重置动画
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
                <ToolCard key={tc.id} toolCall={tc} originalContent={originalContent} />
              ))}
            </div>
          </div>
        ) : (
          // 单工具：无竖线，直接渲染
          <div>
            {toolCalls.map((tc) => (
              <ToolCard key={tc.id} toolCall={tc} originalContent={originalContent} />
            ))}
          </div>
        )
      )}
    </div>
  )
}
