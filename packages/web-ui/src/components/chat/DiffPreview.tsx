// ============================================================
// DiffPreview — 内联文件差异预览
//
// 展示 Agent 对文件的增删改差异（类似 GitHub diff 视图）。
// 使用纯 CSS 渲染，无外部 diff 库依赖。
// diff 计算在此组件内部完成（逐行对比）。
// ============================================================

import React, { useMemo } from 'react'

export interface DiffPreviewProps {
  /** 文件路径 */
  filePath: string
  /** 原始内容 */
  originalContent: string
  /** 修改后内容 */
  modifiedContent: string
  /** 最大显示行数（超出折叠） */
  maxLines?: number
}

type LineType = 'context' | 'added' | 'removed'

interface DiffLine {
  type: LineType
  content: string
  lineNum?: number
}

/** 简单 LCS diff 算法（逐行，无需外部依赖） */
function computeDiff(original: string, modified: string): DiffLine[] {
  const origLines = original.split('\n')
  const modiLines = modified.split('\n')

  // 建 LCS 表
  const m = origLines.length
  const n = modiLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      if (origLines[i - 1]! === modiLines[j - 1]!) dp[i]![j] = dp[i - 1]![j - 1]! + 1
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      else dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
    }
  }

  // 回溯 diff
  const result: DiffLine[] = []
  let i = m; let j = n
  while (i > 0 || j > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    if (i > 0 && j > 0 && origLines[i - 1]! === modiLines[j - 1]!) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      result.unshift({ type: 'context', content: origLines[i - 1]!, lineNum: i })
      i--; j--
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      result.unshift({ type: 'added', content: modiLines[j - 1]! })
      j--
    } else {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      result.unshift({ type: 'removed', content: origLines[i - 1]!, lineNum: i })
      i--
    }
  }
  return result
}

/** 仅保留变更行 ± CONTEXT 行的上下文 */
function filterContext(lines: DiffLine[], context = 3): DiffLine[] {
  const changed = new Set<number>()
  lines.forEach((l, i) => { if (l.type !== 'context') changed.add(i) })
  const visible = new Set<number>()
  changed.forEach((idx) => {
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      visible.add(k)
    }
  })
  const result: DiffLine[] = []
  let last = -1
  for (const idx of Array.from(visible).sort((a, b) => a - b)) {
    if (last !== -1 && idx > last + 1) {
      result.push({ type: 'context', content: '...' })
    }
    if (lines[idx] !== undefined) result.push(lines[idx]!)
    last = idx
  }
  return result
}

const BG: Record<LineType, string> = {
  context: 'transparent',
  added:   '#22c55e12',
  removed: '#ef444412',
}
const COLOR: Record<LineType, string> = {
  context: 'var(--text-secondary, #888)',
  added:   'var(--tool-completed, #22c55e)',
  removed: 'var(--tool-error, #ef4444)',
}
const PREFIX: Record<LineType, string> = {
  context: ' ',
  added:   '+',
  removed: '-',
}

export default function DiffPreview({ filePath, originalContent, modifiedContent, maxLines = 200 }: DiffPreviewProps): React.ReactElement {
  const diffLines = useMemo(() => {
    const all = computeDiff(originalContent, modifiedContent)
    const filtered = filterContext(all)
    return filtered.slice(0, maxLines)
  }, [originalContent, modifiedContent, maxLines])

  const addedCount = diffLines.filter((l) => l.type === 'added').length
  const removedCount = diffLines.filter((l) => l.type === 'removed').length

  return (
    <div style={{
      border: '1px solid var(--border, #333)',
      borderRadius: 'var(--radius-sm, 4px)',
      overflow: 'hidden',
      fontSize: '12px',
      fontFamily: 'monospace',
    }}>
      {/* 文件头 */}
      <div style={{
        padding: '6px 12px',
        background: 'var(--bg-secondary, #2a2a3e)',
        borderBottom: '1px solid var(--border, #333)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
      }}>
        <span style={{ color: 'var(--text-primary, #e0e0e0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {filePath}
        </span>
        <div style={{ display: 'flex', gap: '8px', flexShrink: 0, fontSize: '11px' }}>
          {addedCount > 0 && <span style={{ color: 'var(--tool-completed, #22c55e)' }}>+{addedCount}</span>}
          {removedCount > 0 && <span style={{ color: 'var(--tool-error, #ef4444)' }}>-{removedCount}</span>}
        </div>
      </div>

      {/* diff 内容 */}
      <div style={{ overflow: 'auto', maxHeight: '400px', background: 'var(--bg-primary, #1a1a2e)' }}>
        {diffLines.map((line, idx) => (
          <div
            key={idx}
            style={{
              display: 'flex',
              background: BG[line.type],
              borderLeft: `2px solid ${line.type !== 'context' ? COLOR[line.type] : 'transparent'}`,
              minHeight: '20px',
            }}
          >
            <span style={{
              width: '20px',
              flexShrink: 0,
              color: COLOR[line.type],
              textAlign: 'center',
              userSelect: 'none',
              opacity: 0.8,
            }}>
              {PREFIX[line.type]}
            </span>
            <span style={{
              flex: 1,
              color: line.type === 'context' ? 'var(--text-secondary, #888)' : 'var(--text-primary, #e0e0e0)',
              padding: '1px 8px 1px 4px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              lineHeight: 1.6,
            }}>
              {line.content}
            </span>
          </div>
        ))}
        {diffLines.length === 0 && (
          <div style={{ padding: '12px', color: 'var(--text-secondary, #888)', textAlign: 'center' }}>
            无差异
          </div>
        )}
      </div>
    </div>
  )
}
