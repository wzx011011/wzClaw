import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { ChatMessage as ChatMessageType } from '../../stores/chat-store'
import CodeBlock from './CodeBlock'
import ThinkingIndicator from './ThinkingIndicator'
import ToolCard from './ToolCard'

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
      <div className="mention-block-header" onClick={() => setExpanded(!expanded)}>
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
  const { role, content, thinkingContent, isStreaming, toolCalls, usage, mentions } = message

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

  // Shared ReactMarkdown component config (used for both streaming and final rendering)
  const mdComponents = {
    // <pre> is ALWAYS a code block — handle it here reliably.
    // rehype-highlight transforms code children into <span> elements,
    // so extract raw text recursively then pass to CodeBlock.
    pre({ children }: { children?: React.ReactNode }) {
      const extractText = (nodes: React.ReactNode): string => {
        if (typeof nodes === 'string') return nodes
        if (typeof nodes === 'number') return String(nodes)
        if (Array.isArray(nodes)) return nodes.map(extractText).join('')
        if (React.isValidElement(nodes) && (nodes.props as { children?: React.ReactNode }).children) {
          return extractText((nodes.props as { children?: React.ReactNode }).children)
        }
        return ''
      }
      // Find the inner <code> element to get its language class
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
      const codeEl = findCode(children)
      const className = codeEl ? (codeEl.props as { className?: string }).className ?? '' : ''
      const match = /language-(\w+)/.exec(className)
      const codeString = extractText(children).replace(/\n$/, '')
      return <CodeBlock code={codeString} language={match ? match[1] : undefined} />
    },
    // <code> here is ONLY inline code — <pre> cases are handled above
    code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    },
  }

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

      {/* Content — always rendered via ReactMarkdown so streaming and final output look identical */}
      {displayContent && (
        <div className={`chat-message-content${isStreaming ? ' chat-message-content-streaming' : ''}`}>
          <ReactMarkdown
            rehypePlugins={[rehypeRaw, rehypeHighlight]}
            remarkPlugins={[remarkGfm]}
            components={mdComponents}
          >
            {displayContent}
          </ReactMarkdown>
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
        </div>
      )}
    </div>
  )
}

const MemoizedChatMessage = React.memo(ChatMessage)
MemoizedChatMessage.displayName = 'ChatMessage'

export default MemoizedChatMessage
