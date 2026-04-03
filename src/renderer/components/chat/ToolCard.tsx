import React, { useState } from 'react'

// ============================================================
// ToolCard — Inline tool call visualization (per D-61, D-62, D-63, D-64)
// ============================================================

interface ToolCallInfo {
  id: string
  name: string
  status: 'running' | 'completed' | 'error'
  input?: Record<string, unknown>
  output?: string
  isError?: boolean
}

interface ToolCardProps {
  toolCall: ToolCallInfo
}

const OUTPUT_TRUNCATE_LENGTH = 500

export default function ToolCard({ toolCall }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [outputExpanded, setOutputExpanded] = useState(false)

  const { name, status, input, output } = toolCall

  // Extract file path from input for FileEdit/FileWrite tools (per D-64)
  const filePath =
    input?.path
      ? String(input.path)
      : input?.filePath
        ? String(input.filePath)
        : null

  // Determine if output should be truncated
  const outputText = output ?? ''
  const shouldTruncate = outputText.length > OUTPUT_TRUNCATE_LENGTH && !outputExpanded
  const displayedOutput = shouldTruncate
    ? outputText.slice(0, OUTPUT_TRUNCATE_LENGTH) + '...'
    : outputText

  // Status display
  const statusLabel = status === 'running' ? 'Running' : status === 'completed' ? 'Done' : 'Error'

  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-card-header-left">
          <span className="tool-card-name">{name}</span>
          {filePath && <span className="tool-card-path">{filePath}</span>}
        </div>
        <div className="tool-card-header-right">
          <span className={`tool-status tool-status-${status}`}>
            <span className="tool-status-icon" />
            {statusLabel}
          </span>
          <span className={`tool-card-toggle ${expanded ? 'expanded' : ''}`}>
            &#9654;
          </span>
        </div>
      </div>
      {expanded && (
        <div className="tool-card-details">
          {input && Object.keys(input).length > 0 && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Input</div>
              <div className="tool-card-section-content">
                {JSON.stringify(input, null, 2)}
              </div>
            </div>
          )}
          {outputText && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Output</div>
              <div className={`tool-card-section-content ${shouldTruncate ? 'truncated' : ''}`}>
                {displayedOutput}
              </div>
              {outputText.length > OUTPUT_TRUNCATE_LENGTH && (
                <button
                  className="tool-card-show-more"
                  onClick={() => setOutputExpanded(!outputExpanded)}
                >
                  {outputExpanded ? 'Show less' : 'Show more'}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
