import React, { useState, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import type { ChatMessage as ChatMessageType } from '../../stores/chat-store'
import CodeBlock from './CodeBlock'
import ThinkingIndicator from './ThinkingIndicator'
import ToolCard from './ToolCard'

// ============================================================
// 模块级稳定引用 — 不随每次渲染重建
// 注：rehypeHighlight 已移除。MD_COMPONENTS.pre 用 extractText() 提取纯文本后
// 传给 CodeBlock（CodeBlock 自行做语法高亮），因此 rehypeHighlight 的输出
// 在渲染路径上被 100% 丢弃——保留它只会产生 O(content) 的无用开销。
// ============================================================

/** 唯一的 rehype 插件集：仅做基础 HTML 处理（内联 HTML 支持），不运行高亮 */
const REHYPE_PLUGINS = [rehypeRaw] as const
/** 稳定的 remark 插件引用 */
const REMARK_PLUGINS = [remarkGfm] as const
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
// MemoizedMarkdown — 缓存 ReactMarkdown 解析结果
// 流式场景下 content 每帧增长，ReactMarkdown 会重解析全文。
// 通过 useRef 缓存上次解析结果 + 长内容拆分前缀/尾部，
// 避免每帧 O(n) 的全文 markdown 解析开销。
// ============================================================

/** 前缀缓存阈值：超过此长度的内容拆分为已缓存前缀 + 响应式尾部 */
const PREFIX_CACHE_THRESHOLD = 4000

function MemoizedMarkdown({ content }: { content: string }): JSX.Element {
  const cacheRef = useRef<{ content: string; element: JSX.Element } | null>(null)

  // 完全匹配缓存 — content 未变时直接返回
  if (cacheRef.current && cacheRef.current.content === content) {
    return cacheRef.current.element
  }

  // 长内容拆分：前缀走 dangerouslySetInnerHTML（已解析的 HTML 缓存），
  // 仅尾部走 ReactMarkdown 实时解析
  let element: JSX.Element

  if (content.length > PREFIX_CACHE_THRESHOLD && cacheRef.current) {
    // 找到缓存前缀的边界（在阈值附近找最后一个换行符）
    const prevContent = cacheRef.current.content
    // 如果新内容以旧内容开头（流式追加），前缀可复用
    if (content.startsWith(prevContent) && prevContent.length > PREFIX_CACHE_THRESHOLD) {
      // 将缓存的 element 作为前缀，新尾部走 ReactMarkdown
      const tail = content.slice(prevContent.length)
      element = (
        <>
          {cacheRef.current.element}
          {tail && (
            <ReactMarkdown
              rehypePlugins={REHYPE_PLUGINS}
              remarkPlugins={REMARK_PLUGINS}
              components={MD_COMPONENTS}
            >
              {tail}
            </ReactMarkdown>
          )}
        </>
      )
    } else {
      // 内容完全不同（非追加），重新解析
      element = (
        <ReactMarkdown
          rehypePlugins={REHYPE_PLUGINS}
          remarkPlugins={REMARK_PLUGINS}
          components={MD_COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      )
    }
  } else {
    // 短内容或首次渲染 — 直接 ReactMarkdown
    element = (
      <ReactMarkdown
        rehypePlugins={REHYPE_PLUGINS}
        remarkPlugins={REMARK_PLUGINS}
        components={MD_COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    )
  }

  cacheRef.current = { content, element }
  return element
}

// ============================================================
// ChatMessage — Single message rendering (per D-58, D-59)
// Now renders @-mention context blocks for user messages.
// ============================================================

interface ChatMessageProps {
  message: ChatMessageType
}

/**
 * Collapsible context block for an @-mention file or folder.
 */
function MentionBlock({ mention }: { mention: { type: string; path: string; content: string; size: number } }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const isFolder = mention.type === 'folder_mention'
  const sizeLabel = isFolder
    ? `${mention.size} entries`
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

function ChatMessage({ message }: ChatMessageProps): JSX.Element {
  const { role, content, thinkingContent, isStreaming, toolCalls, usage, mentions, model } = message

  if (role === 'user') {
    // Show mention context blocks if present, then the display content
    // The content sent to LLM includes formatted mentions; we show the original message
    const displayContent = mentions && mentions.length > 0
      ? content.split('\n\n').filter(line => !line.startsWith('[Context from')).join('\n\n').trim() || content
      : content

    return (
      <div className="chat-message chat-message-user">
        {mentions && mentions.length > 0 && (
          <div className="mention-blocks">
            {mentions.map((m, i) => (
              <MentionBlock key={`${m.path}-${i}`} mention={m} />
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
          <summary>Thinking</summary>
          <div className="chat-message-thinking-content">{displayThinking}</div>
        </details>
      )}

      {/* Content — always rendered via ReactMarkdown so streaming and final output look identical. */}
      {displayContent && (
        <div className={`chat-message-content${isStreaming ? ' chat-message-content-streaming' : ''}`}>
          <MemoizedMarkdown content={displayContent} />
        </div>
      )}

      {/* Tool calls */}
      {toolCalls && toolCalls.length > 0 && (
        <div className="chat-message-tools">
          {toolCalls.map((tc) => (
            <ToolCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      {/* Usage info */}
      {!isStreaming && usage && (
        <div className="chat-usage-info">
          <span>In: {usage.inputTokens}</span>
          <span>Out: {usage.outputTokens}</span>
          {model && <span className="chat-usage-model">{model}</span>}
        </div>
      )}
    </div>
  )
}

const MemoizedChatMessage = React.memo(ChatMessage)
MemoizedChatMessage.displayName = 'ChatMessage'

export default MemoizedChatMessage
