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
              code({ className, children, ...props }) {
                // Check if this is a fenced code block (has language class from rehype-highlight)
                const match = /language-(\w+)/.exec(className || '')
                const codeString = String(children).replace(/\n$/, '')

                if (match) {
                  // Fenced code block with language — use CodeBlock component
                  return <CodeBlock code={codeString} language={match[1]} />
                }

                // Inline code (no language class) — render as <code>
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
