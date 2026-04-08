import React from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { ChatMessage as ChatMessageType } from '../../stores/chat-store'
import CodeBlock from './CodeBlock'
import ToolCard from './ToolCard'

// ============================================================
// ChatMessage — Single message rendering (per D-58, D-59)
// ============================================================

interface ChatMessageProps {
  message: ChatMessageType
}

export default function ChatMessage({ message }: ChatMessageProps): JSX.Element {
  const { role, content, isStreaming, toolCalls, usage } = message

  if (role === 'user') {
    return (
      <div className="chat-message chat-message-user">
        {content}
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
