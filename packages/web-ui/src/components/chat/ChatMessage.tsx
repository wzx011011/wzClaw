// ============================================================
// ChatMessage — 单条消息渲染
// 从桌面端提取，移除 MentionPicker / rewind 等桌面端专属功能
// 保留 Markdown 渲染、流式文本、thinking 折叠、工具调用占位
// ============================================================

import React, { lazy, Suspense } from 'react'
import type { ChatMessage as ChatMessageType } from '../../stores/streaming-batcher'
import CodeBlock from './CodeBlock'
import ThinkingIndicator from './ThinkingIndicator'

// 懒加载 react-markdown — 仅在非流式渲染时需要
const ReactMarkdown = lazy(() => import('react-markdown'))
// 插件在 ReactMarkdown 加载时一起加载（同一 chunk）
const rehypeRawPromise = import('rehype-raw').then(m => m.default)
const remarkGfmPromise = import('remark-gfm').then(m => m.default)

// 预加载完成的插件引用（resolve 后不变）
let _rehypeRaw: unknown = null
let _remarkGfm: unknown = null
rehypeRawPromise.then(v => { _rehypeRaw = v })
remarkGfmPromise.then(v => { _remarkGfm = v })

// ---- 辅助函数 ----

/** 获取 rehype 插件集 */
const getRehypePlugins = () => _rehypeRaw ? [_rehypeRaw] : []
/** 获取 remark 插件集 */
const getRemarkPlugins = () => _remarkGfm ? [_remarkGfm] : []

/** 从 React 子节点中提取纯文本 */
const extractText = (nodes: React.ReactNode): string => {
  if (typeof nodes === 'string') return nodes
  if (typeof nodes === 'number') return String(nodes)
  if (Array.isArray(nodes)) return nodes.map(extractText).join('')
  if (React.isValidElement(nodes) && (nodes.props as { children?: React.ReactNode }).children) {
    return extractText((nodes.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** 查找 <code> 子元素 */
const findCode = (nodes: React.ReactNode): React.ReactElement | null => {
  const arr = React.Children.toArray(nodes)
  for (const child of arr) {
    if (React.isValidElement(child)) {
      if (child.type === 'code') return child as React.ReactElement
      const nested = findCode((child.props as { children?: React.ReactNode }).children)
      if (nested) return nested
    }
  }
  return null
}

// Markdown 自定义渲染组件
const MD_COMPONENTS = {
  pre({ children }: { children?: React.ReactNode }) {
    const codeEl = findCode(children)
    const className = codeEl ? (codeEl.props as { className?: string }).className ?? '' : ''
    const match = /language-(\w+)/.exec(className)
    const codeString = extractText(children).replace(/\n$/, '')
    return <CodeBlock code={codeString} language={match ? match[1] : undefined} />
  },
  code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

// ---- MarkdownContent ----

/**
 * React.memo 包裹的 ReactMarkdown 渲染器
 * 仅在非流式状态下使用，content 不变时跳过重解析
 */
const MarkdownContent = React.memo(function MarkdownContent({ content }: { content: string }) {
  return (
    <Suspense fallback={<div className="streaming-text">{content}</div>}>
      <ReactMarkdown
        rehypePlugins={getRehypePlugins()}
        remarkPlugins={getRemarkPlugins()}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </Suspense>
  )
})

// ---- ChatMessage 组件 ----

interface ChatMessageProps {
  message: ChatMessageType
}

/**
 * ChatMessage — 单条消息渲染
 *
 * 支持三种消息类型：
 * - user: 用户消息气泡
 * - assistant: 助手消息（Markdown + 流式文本 + thinking + 工具调用）
 * - tool_result: 通过 toolCalls 合并到 assistant 消息中
 */
function ChatMessage({ message }: ChatMessageProps): React.ReactElement {
  const { role, content, thinkingContent, isStreaming, toolCalls, usage, model } = message

  // ---- 用户消息 ----
  if (role === 'user') {
    return (
      <div className="chat-message chat-message-user">
        {content}
      </div>
    )
  }

  // ---- 压缩通知消息 ----
  if (message.isCompacted) {
    return (
      <div className={content.includes('Auto-compacted') ? 'compact-result-auto' : 'compact-result'}>
        {content}
      </div>
    )
  }

  // ---- 助手消息 ----
  const streamingClass = isStreaming ? ' chat-message-streaming' : ''

  // 去除 <details>...</details> 块 — 工具输出已通过 ToolCard 单独展示
  const displayContent = content
    ? content.replace(/<details[\s\S]*?<\/details>/g, '').trim()
    : ''
  const displayThinking = thinkingContent?.trim() ?? ''

  return (
    <div className={`chat-message chat-message-assistant${streamingClass}`}>
      {/* 思考中指示器 — 流式且无内容时显示 */}
      {isStreaming && !displayContent && !displayThinking && (!toolCalls || toolCalls.length === 0) && (
        <ThinkingIndicator />
      )}

      {/* 思考内容折叠区 */}
      {displayThinking && (
        <details className="chat-message-thinking" open>
          <summary>思考过程</summary>
          <div className="chat-message-thinking-content">{displayThinking}</div>
        </details>
      )}

      {/* 内容区 — 流式期间渲染纯文本，流式结束后 Markdown 解析 */}
      {displayContent && (
        <div className={`chat-message-content${isStreaming ? ' chat-message-content-streaming' : ''}`}>
          {isStreaming ? (
            <div className="streaming-text">{displayContent}</div>
          ) : (
            <MarkdownContent content={displayContent} />
          )}
        </div>
      )}

      {/* 工具调用 — 占位显示工具名（完整 ToolCallGroup 留给 Plan 04d） */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="chat-message-tools">
          {toolCalls.map((tc) => (
            <div key={tc.id} className="tool-card">
              <div className="tool-card-header">
                <div className="tool-card-header-left">
                  <span className="tool-card-icon">
                    {tc.status === 'running' ? '⟳' : tc.status === 'error' ? '✕' : '✓'}
                  </span>
                  <span className={`tool-card-verb${tc.status === 'running' ? ' tool-card-verb-running' : ''}`}>
                    {tc.name}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Token 使用信息 */}
      {!isStreaming && usage && (
        <div className="chat-usage-info">
          <span>输入 {usage.inputTokens}</span>
          <span>输出 {usage.outputTokens}</span>
          {model && <span className="chat-usage-model">{model}</span>}
        </div>
      )}
    </div>
  )
}

const MemoizedChatMessage = React.memo(ChatMessage)
MemoizedChatMessage.displayName = 'ChatMessage'

export default MemoizedChatMessage
