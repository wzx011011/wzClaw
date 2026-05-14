// ============================================================
// ToolCard — 单个工具调用可视化卡片
// 从桌面端提取，简化版：
// - 保留：工具名 + 状态图标、输入参数折叠、输出截断、WebSearch/WebFetch 特殊渲染
// - 移除：DiffPreview、GoToDefinition/FindReferences、嵌套子工具、revert、i18n
// ============================================================

import React, { useState, useEffect, useRef } from 'react'
import type { ToolCallInfo } from '../../stores/streaming-batcher'

interface ToolCardProps {
  toolCall: ToolCallInfo
}

const OUTPUT_TRUNCATE_LENGTH = 500

// ============================================================
// URL 安全检查 — 防止 XSS via javascript: URI
// ============================================================

function isSafeUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

// ============================================================
// WebSearch 输出渲染器
// ============================================================

function renderWebSearchOutput(output: string): React.ReactElement {
  const entries = output.split('\n\n')
  return (
    <div>
      {entries.map((entry, i) => {
        const titleMatch = entry.match(/^Title:\s*(.+)$/m)
        const urlMatch = entry.match(/^URL:\s*(.+)$/m)
        const title = titleMatch?.[1] ?? ''
        const url = urlMatch?.[1] ?? ''

        if (!title && !url) return null

        return (
          <div key={i} className="tool-card-web-result">
            {url && isSafeUrl(url) && (
              <a
                className="tool-card-web-url"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {url}
              </a>
            )}
            {title && <div className="tool-card-web-title">{title}</div>}
          </div>
        )
      })}
    </div>
  )
}

// ============================================================
// WebFetch 输出渲染器
// ============================================================

function renderWebFetchOutput(output: string, expanded: boolean): React.ReactElement {
  const lines = output.split('\n')
  const sourceLine = lines[0]?.startsWith('Source: ') ? lines[0] : null
  const sourceUrl = sourceLine?.replace('Source: ', '') ?? ''
  const contentStart = sourceLine ? lines.slice(1).join('\n').trim() : output

  return (
    <div>
      {sourceUrl && (
        <div className="tool-card-web-source">
          来源:{' '}
          {isSafeUrl(sourceUrl) ? (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer">
              {sourceUrl}
            </a>
          ) : (
            <span>{sourceUrl}</span>
          )}
        </div>
      )}
      <div className={`tool-card-web-content ${expanded ? 'expanded' : ''}`}>
        {contentStart}
      </div>
    </div>
  )
}

// ============================================================
// 操作动词 — 中文版
// ============================================================

function actionVerb(toolName: string, status: 'running' | 'completed' | 'error'): string {
  const done = status !== 'running'
  const map: Record<string, [string, string]> = {
    'Bash':            ['执行中', '已执行'],
    'Terminal':        ['执行中', '已执行'],
    'Read':            ['读取中', '已读取'],
    'FileRead':        ['读取中', '已读取'],
    'Write':           ['写入中', '已写入'],
    'FileWrite':       ['写入中', '已写入'],
    'Edit':            ['编辑中', '已编辑'],
    'FileEdit':        ['编辑中', '已编辑'],
    'Glob':            ['搜索中', '已搜索'],
    'Grep':            ['搜索中', '已搜索'],
    'WebSearch':       ['搜索中', '已搜索'],
    'WebFetch':        ['获取中', '已获取'],
    'Agent':           ['运行代理中', '已运行代理'],
    'TodoWrite':       ['更新待办', '已更新待办'],
    'ExitPlanMode':    ['应用计划中', '已应用计划'],
  }
  const pair = map[toolName]
  if (pair) return done ? pair[1] : pair[0]
  return done ? `已使用 ${toolName}` : `使用 ${toolName} 中`
}

// ============================================================
// 工具图标
// ============================================================

function toolIcon(toolName: string): string {
  const icons: Record<string, string> = {
    'Bash': '⚡', 'Terminal': '⚡',
    'Read': '≡', 'FileRead': '≡',
    'Write': '✎', 'FileWrite': '✎',
    'Edit': '✎', 'FileEdit': '✎',
    'Glob': '◫', 'Grep': '⊙',
    'WebSearch': '⊕', 'WebFetch': '↓',
    'Agent': '◈',
    'TodoWrite': '☑',
    'ExitPlanMode': '✔',
  }
  return icons[toolName] ?? '⚙'
}

// ============================================================
// 输入徽章 — 对标手机端 _buildInputBadge()
// ============================================================

function inputBadgeLabel(toolName: string, input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  const pathStr = input.path ? String(input.path) : input.filePath ? String(input.filePath) : null
  if (pathStr) {
    const parts = pathStr.replace(/\\/g, '/').split('/')
    const name = parts[parts.length - 1] ?? pathStr
    return name.length > 40 ? name.slice(0, 37) + '...' : name
  }
  if (toolName === 'Bash' || toolName === 'Terminal') {
    const cmd = input.command ? String(input.command) : null
    if (cmd) return cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd
  }
  if ((toolName === 'Grep' || toolName === 'WebSearch') && input.pattern) {
    const p = String(input.pattern)
    return p.length > 40 ? p.slice(0, 37) + '...' : p
  }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    const url = input.url ?? input.query
    if (url) { const s = String(url); return s.length > 40 ? s.slice(0, 37) + '...' : s }
  }
  return null
}

function inputBadgeColor(filename: string): string {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return '#4dd0e1'
  if (filename.endsWith('.js') || filename.endsWith('.jsx')) return '#ffd54f'
  if (filename.endsWith('.css') || filename.endsWith('.scss')) return '#ce93d8'
  if (filename.endsWith('.json')) return '#a5d6a7'
  if (filename.endsWith('.md')) return '#90caf9'
  if (filename.endsWith('.py')) return '#81c784'
  if (filename.endsWith('.dart')) return '#64b5f6'
  if (filename.endsWith('.rs')) return '#ffab91'
  if (filename.endsWith('.go')) return '#80cbc4'
  return 'var(--text-secondary)'
}

// ============================================================
// 结果摘要 — 从工具输出提取一行摘要
// ============================================================

function extractResultSummary(toolName: string, output: string, isError?: boolean): string | null {
  if (!output) return null
  if (isError) {
    const firstLine = output.split('\n')[0]!.trim()
    return firstLine.length > 60 ? firstLine.slice(0, 57) + '...' : firstLine
  }
  const lineCount = (output.match(/\n/g) || []).length + 1
  switch (toolName) {
    case 'Read':
    case 'FileRead':
      return `${lineCount} 行`
    case 'Bash':
    case 'Terminal': {
      const trimmed = output.trim()
      if (!trimmed) return '执行完成'
      const fl = trimmed.split('\n')[0]!.trim()
      return fl.length > 50 ? fl.slice(0, 47) + '...' : fl
    }
    case 'Grep':
      return `${lineCount} 个匹配`
    case 'Glob':
      return `${lineCount} 个文件`
    case 'FileWrite':
    case 'Write':
      return '已写入'
    case 'FileEdit':
    case 'Edit':
      return '已应用'
    case 'WebSearch':
      return `${(output.match(/\n\n/g) || []).length + 1} 条结果`
    default: {
      const fl = output.split('\n')[0]!.trim()
      return fl.length > 50 ? fl.slice(0, 47) + '...' : (fl || null)
    }
  }
}

// ============================================================
// ToolCard 主组件
// ============================================================

function ToolCard({ toolCall }: ToolCardProps): React.ReactElement {
  const prevStatusRef = useRef(toolCall.status)
  const startTimeRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)

  // 运行中自动展开，完成后折叠
  const [expanded, setExpanded] = useState(toolCall.status === 'running')
  const [outputExpanded, setOutputExpanded] = useState(false)
  const [webFetchExpanded, setWebFetchExpanded] = useState(false)

  // 状态变化时自动展开/折叠
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = toolCall.status
    if (prev === 'running' && toolCall.status === 'completed') {
      setExpanded(false)
    } else if (toolCall.status === 'error') {
      setExpanded(true)
    }
  }, [toolCall.status])

  // 计时器 — running 状态下每 250ms 更新一次
  useEffect(() => {
    if (toolCall.status !== 'running') return
    startTimeRef.current = Date.now()
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current)
    }, 250)
    return () => clearInterval(interval)
  }, [toolCall.status])

  const formatElapsed = (ms: number): string => {
    if (ms < 1000) return ''
    const sec = ms / 1000
    if (sec >= 60) return `${Math.floor(sec / 60)}m${Math.floor(sec % 60)}s`
    if (sec >= 10) return `${Math.floor(sec)}s`
    return `${sec.toFixed(1)}s`
  }

  const { name, status, input, output } = toolCall

  // 特殊工具类型判断
  const isWebSearch = name === 'WebSearch'
  const isWebFetch = name === 'WebFetch'
  const hasSpecialOutput = isWebSearch || isWebFetch

  // 输出截断
  const outputText = output ?? ''
  const shouldTruncate = outputText.length > OUTPUT_TRUNCATE_LENGTH && !outputExpanded
  const displayedOutput = shouldTruncate
    ? outputText.slice(0, OUTPUT_TRUNCATE_LENGTH) + '...'
    : outputText

  const resultSummary = extractResultSummary(name, outputText, toolCall.isError)

  // 渲染特殊输入区域
  const renderSpecialInput = (): React.ReactElement | null => {
    if (isWebSearch && input?.query) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">查询</div>
          <div className="tool-card-section-content" style={{ fontSize: 'var(--font-size-xs)', fontFamily: 'Consolas, Courier New, monospace' }}>
            {String(input.query)}
          </div>
        </div>
      )
    }
    if (isWebFetch && input?.url) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">URL</div>
          <div
            className="tool-card-section-content"
            style={{
              fontSize: 'var(--font-size-xs)',
              fontFamily: 'Consolas, Courier New, monospace',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis'
            }}
          >
            {String(input.url)}
          </div>
        </div>
      )
    }
    return null
  }

  // 渲染特殊输出区域
  const renderSpecialOutput = (): React.ReactElement | null => {
    if (!outputText) return null

    if (isWebSearch) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">结果</div>
          {renderWebSearchOutput(outputText)}
        </div>
      )
    }
    if (isWebFetch) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">内容</div>
          {renderWebFetchOutput(outputText, webFetchExpanded)}
          <button
            className="tool-card-show-more"
            onClick={() => setWebFetchExpanded(!webFetchExpanded)}
          >
            {webFetchExpanded ? '收起' : '展开更多'}
          </button>
        </div>
      )
    }
    return null
  }

  return (
    <div className="tool-card">
      <div
        className="tool-card-header"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      >
        <div className="tool-card-header-left">
          <span className="tool-card-icon">{toolIcon(name)}</span>
          <span className={`tool-card-verb${status === 'running' ? ' tool-card-verb-running' : ''}`}>
            {actionVerb(name, status)}
          </span>
          {(() => {
            const badge = inputBadgeLabel(name, input)
            if (!badge) return null
            const color = inputBadgeColor(badge)
            return (
              <span
                className="tool-card-input-badge"
                style={{ color, background: color.startsWith('var') ? 'rgba(120,120,120,0.12)' : `${color}1a` }}
              >
                {badge}
              </span>
            )
          })()}
          {resultSummary && status !== 'running' && !expanded && (
            <span className="tool-card-summary">— {resultSummary}</span>
          )}
        </div>
        <div className="tool-card-header-right">
          {status === 'running' && elapsed >= 1000 && (
            <span className="tool-card-timer">{formatElapsed(elapsed)}</span>
          )}
          <span className={`tool-status-dot tool-status-dot-${status}`} />
          <span className={`tool-card-toggle ${expanded ? 'expanded' : ''}`}>
            &#9654;
          </span>
        </div>
      </div>

      {/* 始终渲染 body — CSS max-height/opacity 控制展开/折叠动画 */}
      <div className={`tool-card-body${expanded ? ' expanded' : ''}`}>
        <div className="tool-card-details">
          {hasSpecialOutput ? (
            <>
              {renderSpecialInput()}
              {renderSpecialOutput()}
            </>
          ) : (
            <>
              {/* 通用输入参数展示 */}
              {input && Object.keys(input).length > 0 && (
                <div className="tool-card-section">
                  <div className="tool-card-section-label">输入</div>
                  <div className="tool-card-section-content">
                    {JSON.stringify(input, null, 2)}
                  </div>
                </div>
              )}
              {/* 通用输出结果展示（截断显示） */}
              {outputText && (
                <div className="tool-card-section">
                  <div className="tool-card-section-label">输出</div>
                  <div className={`tool-card-section-content ${shouldTruncate ? 'truncated' : ''}`}>
                    {displayedOutput}
                  </div>
                  {outputText.length > OUTPUT_TRUNCATE_LENGTH && (
                    <button
                      className="tool-card-show-more"
                      onClick={() => setOutputExpanded(!outputExpanded)}
                    >
                      {outputExpanded ? '收起' : '展开更多'}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * ToolCard memo 比较器 — 避免文本流更新时已完成的 ToolCard 重渲染
 */
function areToolCardPropsEqual(prev: ToolCardProps, next: ToolCardProps): boolean {
  const p = prev.toolCall
  const n = next.toolCall
  if (p === n) return true
  return (
    p.id === n.id &&
    p.status === n.status &&
    p.output === n.output &&
    p.isError === n.isError &&
    p.progress === n.progress
  )
}

const MemoizedToolCard = React.memo(ToolCard, areToolCardPropsEqual)
MemoizedToolCard.displayName = 'ToolCard'
export default MemoizedToolCard
