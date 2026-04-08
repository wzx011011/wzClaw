import React, { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { ChatMessage as ChatMessageType } from '../../stores/chat-store'
import CodeBlock from './CodeBlock'
import ToolCard from './ToolCard'

// ============================================================
// ChatMessage — Single message rendering (per D-58, D-59)
// Now renders @-mention context blocks for user messages.
// ============================================================

interface ChatMessageProps {
  message: ChatMessageType
}

/**
 * Collapsible context block for an @-mention file.
 */
function MentionBlock({ mention }: { mention: { type: string; path: string; content: string; size: number } }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const sizeLabel = mention.size < 1024
    ? `${mention.size}B`
    : mention.size < 1024 * 1024
      ? `${(mention.size / 1024).toFixed(1)}KB`
      : `${(mention.size / 1024 / 1024).toFixed(1)}MB`

  return (
    <div className="mention-block">
      <div className="mention-block-header" onClick={() => setExpanded(!expanded)}>
        <span className="mention-block-label">[context]</span>
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

export default function ChatMessage({ message }: ChatMessageProps): JSX.Element {
  const { role, content, isStreaming, toolCalls, usage, mentions } = message

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

  return (
    <div className={`chat-message chat-message-assistant${streamingClass}`}>
      {content && (
        <div className="chat-message-content">
          <ReactMarkdown
            rehypePlugins={[rehypeHighlight]}
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, node, ...props }) {
                // A code block (inside <pre>) has a parent <pre> element in the AST.
                // Inline code does not. This is the reliable way to distinguish them.
                const isBlock = node?.position?.start.line !== node?.position?.end.line
                  || className?.includes('language-')
                const match = /language-(\w+)/.exec(className || '')

                // rehype-highlight transforms children into React elements (spans),
                // so we must extract text recursively instead of using String()
                const extractText = (nodes: React.ReactNode): string => {
                  if (typeof nodes === 'string') return nodes
                  if (typeof nodes === 'number') return String(nodes)
                  if (Array.isArray(nodes)) return nodes.map(extractText).join('')
                  if (React.isValidElement(nodes) && nodes.props.children) {
                    return extractText(nodes.props.children)
                  }
                  return ''
                }
                const codeString = extractText(children).replace(/\n$/, '')

                if (isBlock) {
                  return <CodeBlock code={codeString} language={match ? match[1] : 'text'} />
                }

                // Inline code — render as <code>
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                )
              },
              // Override pre to just pass through children (CodeBlock handles its own pre)
              pre({ children }) {
                return <>{children}</>
              }
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      )}

      {/* Streaming cursor */}
      {isStreaming && (
        <span className="chat-typing-cursor">|</span>
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
