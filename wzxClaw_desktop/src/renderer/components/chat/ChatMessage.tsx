import React, { useState, lazy, Suspense } from 'react'
import { useT } from '../../i18n/useT'
import type { ChatMessage as ChatMessageType } from '../../stores/chat-store'
import CodeBlock from './CodeBlock'
import ThinkingIndicator from './ThinkingIndicator'
import ToolCallGroup from './ToolCallGroup'

// Lazy-load react-markdown — 仅在非流式渲染时需要
const ReactMarkdown = lazy(() => import('react-markdown'))
// 插件在 ReactMarkdown 加载时一起加载（同一 chunk）
const rehypeRawPromise = import('rehype-raw').then(m => m.default)
const remarkGfmPromise = import('remark-gfm').then(m => m.default)

// 预加载完成的插件引用（resolve 后不变）
let _rehypeRaw: unknown = null
let _remarkGfm: unknown = null
rehypeRawPromise.then(v => { _rehypeRaw = v })
remarkGfmPromise.then(v => { _remarkGfm = v })

// ============================================================
// 模块级稳定引用 — 不随每次渲染重建
// 注：rehypeHighlight 已移除。MD_COMPONENTS.pre 用 extractText() 提取纯文本后
// 传给 CodeBlock（CodeBlock 自行做语法高亮），因此 rehypeHighlight 的输出
// 在渲染路径上被 100% 丢弃——保留它只会产生 O(content) 的无用开销。
// ============================================================

/** 动态获取 rehype 插件集（首次渲染时可能为空，此时 ReactMarkdown 降级为纯文本） */
const getRehypePlugins = () => _rehypeRaw ? [_rehypeRaw] as const : [] as const
const getRemarkPlugins = () => _remarkGfm ? [_remarkGfm] as const : [] as const
const extractText = (nodes: React.ReactNode): string => {
  if (typeof nodes === 'string') return nodes
  if (typeof nodes === 'number') return String(nodes)
  if (Array.isArray(nodes)) return nodes.map(extractText).join('')
  if (React.isValidElement(nodes) && (nodes.props as { children?: React.ReactNode }).children) {
    return extractText((nodes.props as { children?: React.ReactNode }).children)
  }
  return ''
}

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

// ============================================================
// MarkdownContent — React.memo 包裹的 ReactMarkdown 渲染器
// 仅在非流式状态下使用，content 不变时跳过重解析。
// 流式期间由 StreamingText 接管，完全跳过 ReactMarkdown。
// ============================================================

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

// ============================================================
// ChatMessage — Single message rendering (per D-58, D-59)
// Now renders @-mention context blocks for user messages.
// ============================================================

interface ChatMessageProps {
  message: ChatMessageType
  onRewind?: (messageId: string) => void
}

/**
 * Collapsible context block for an @-mention file or folder.
 */
function MentionBlock({ mention }: { mention: { type: string; path: string; content: string; size: number } }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const t = useT()
  const isFolder = mention.type === 'folder_mention'
  const sizeLabel = isFolder
    ? t('chatMessage.entries', { count: mention.size })
    : mention.size < 1024
      ? `${mention.size}B`
      : mention.size < 1024 * 1024
        ? `${(mention.size / 1024).toFixed(1)}KB`
        : `${(mention.size / 1024 / 1024).toFixed(1)}MB`

  return (
    <div className={`mention-block${isFolder ? ' mention-block-folder' : ''}`}>
      <div
        className="mention-block-header"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((v) => !v) } }}
      >
        <span className="mention-block-label">[context]{isFolder ? ' [dir]' : ''}</span>
        <span className="mention-block-path">{mention.path}</span>
        <span className="mention-block-size">{sizeLabel}</span>
        <span className="mention-block-toggle">{expanded ? '\u25BC' : '\u25B6'}</span>
      </div>
      {expanded && (
        <div className="mention-block-content">
          <pre>{mention.content}</pre>
        </div>
      )}
    </div>
  )
}

function ChatMessage({ message, onRewind }: ChatMessageProps): JSX.Element {
  const { role, content, thinkingContent, isStreaming, toolCalls, usage, mentions, model, images } = message
  const t = useT()

  if (role === 'user') {
    // Show mention context blocks if present, then the display content
    // The content sent to LLM includes formatted mentions; we show the original message
    const displayContent = mentions && mentions.length > 0
      ? content.split('\n\n').filter(line => !line.startsWith('[Context from')).join('\n\n').trim() || content
      : content

    return (
      <div className="chat-message chat-message-user">
        {/* Rewind button — appears on hover */}
        {onRewind && !message.isStreaming && (
          <button
            className="chat-message-rewind-btn"
            title={t('chatMessage.rewindToHere')}
            onClick={() => onRewind(message.id)}
          >
            &#8634;
          </button>
        )}
        {mentions && mentions.length > 0 && (
          <div className="mention-blocks">
            {mentions.map((m, i) => (
              <MentionBlock key={`${m.path}-${i}`} mention={m} />
            ))}
          </div>
        )}
        {images && images.length > 0 && (
          <div className="chat-message-images">
            {images.map((img, i) => (
              <img
                key={i}
                className="chat-message-image"
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={img.name ?? `Image ${i + 1}`}
                title={img.name}
              />
            ))}
          </div>
        )}
        {displayContent}
      </div>
    )
  }

  // Compacted context message (per CTX-03, CTX-05)
  if (message.isCompacted) {
    return (
      <div className={content.includes('Auto-compacted') ? 'compact-result-auto' : 'compact-result'}>
        {content}
      </div>
    )
  }

  // Assistant message
  const streamingClass = isStreaming ? ' chat-message-streaming' : ''

  // Strip <details>...</details> blocks from content — tool outputs are already
  // shown separately via ToolCard, so these duplicate blocks just create clutter.
  const displayContent = content
    ? content.replace(/<details[\s\S]*?<\/details>/g, '').trim()
    : ''
  const displayThinking = thinkingContent?.trim() ?? ''

  return (
    <div className={`chat-message chat-message-assistant${streamingClass}`}>
      {/* Thinking indicator — shown when streaming with no content yet */}
      {isStreaming && !displayContent && !displayThinking && (!toolCalls || toolCalls.length === 0) && (
        <ThinkingIndicator />
      )}

      {/* Thinking block — always starts open; no key so user state is preserved during streaming */}
      {displayThinking && (
        <details className="chat-message-thinking" defaultOpen>
          <summary>{t('chatMessage.thinking')}</summary>
          <div className="chat-message-thinking-content">{displayThinking}</div>
        </details>
      )}

      {/* Content — 流式期间渲染纯文本（跳过 ReactMarkdown 解析），流式结束后一次 Markdown 解析 */}
      {displayContent && (
        <div className={`chat-message-content${isStreaming ? ' chat-message-content-streaming' : ''}`}>
          {isStreaming ? (
            <div className="streaming-text">{displayContent}</div>
          ) : (
            <MarkdownContent content={displayContent} />
          )}
        </div>
      )}

      {/* Tool calls — 使用 ToolCallGroup 组件（竖线 + WorkflowHeader 折叠） */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="chat-message-tools">
          <ToolCallGroup toolCalls={toolCalls} />
        </div>
      )}

      {/* Usage info */}
      {!isStreaming && usage && (
        <div className="chat-usage-info">
          <span>{t('chatMessage.input')} {usage.inputTokens}</span>
          <span>{t('chatMessage.output')} {usage.outputTokens}</span>
          {model && <span className="chat-usage-model">{model}</span>}
        </div>
      )}
    </div>
  )
}

const MemoizedChatMessage = React.memo(ChatMessage)
MemoizedChatMessage.displayName = 'ChatMessage'

export default MemoizedChatMessage
