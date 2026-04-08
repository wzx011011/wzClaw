import React, { useState } from 'react'
import { useDiffStore } from '../../stores/diff-store'
import type { PendingDiff } from '../../../shared/types'

// ============================================================
// ToolCard — Inline tool call visualization (per D-61, D-62, D-63, D-64)
// Shows "Review Changes" button for FileWrite/FileEdit tools (DIFF-01)
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
  originalContent?: string
}

const OUTPUT_TRUNCATE_LENGTH = 500

export default function ToolCard({ toolCall, originalContent }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [outputExpanded, setOutputExpanded] = useState(false)

  const addDiff = useDiffStore((s) => s.addDiff)
  const setActiveDiff = useDiffStore((s) => s.setActiveDiff)
  const pendingDiffs = useDiffStore((s) => s.pendingDiffs)

  const { name, status, input, output } = toolCall

  // Extract file path from input for FileEdit/FileWrite tools (per D-64)
  const filePath =
    input?.path
      ? String(input.path)
      : input?.filePath
        ? String(input.filePath)
        : null

  // Determine if this is a file-modifying tool that supports diff preview
  const isFileModifying = name === 'FileWrite' || name === 'FileEdit'

  // Check if there is already a pending diff for this tool call
  const existingDiff = pendingDiffs.find((d) => d.toolCallId === toolCall.id)

  // Determine if output should be truncated
  const outputText = output ?? ''
  const shouldTruncate = outputText.length > OUTPUT_TRUNCATE_LENGTH && !outputExpanded
  const displayedOutput = shouldTruncate
    ? outputText.slice(0, OUTPUT_TRUNCATE_LENGTH) + '...'
    : outputText

  // Status display
  const statusLabel = status === 'running' ? 'Running' : status === 'completed' ? 'Done' : 'Error'

  // Handle "Review Changes" click: create a pending diff and open the diff preview
  const handleReviewChanges = (): void => {
    if (!filePath || !isFileModifying) return

    const modifiedContent = name === 'FileWrite'
      ? String(input?.content ?? '')
      : '' // For FileEdit, the modified content would need to be computed

    const diff: PendingDiff = {
      id: `diff-${toolCall.id}`,
      filePath,
      originalContent: originalContent ?? '',
      modifiedContent,
      hunks: [],
      toolCallId: toolCall.id,
      timestamp: Date.now()
    }

    addDiff(diff)
    setActiveDiff(diff.id)
  }

  // Determine review status badge text
  const reviewStatus = existingDiff
    ? `${existingDiff.hunks.filter(h => h.status === 'pending').length} pending`
    : null

  return (
    <div className="tool-card">
      <div className="tool-card-header" onClick={() => setExpanded(!expanded)}>
        <div className="tool-card-header-left">
          <span className="tool-card-name">{name}</span>
          {filePath && <span className="tool-card-path">{filePath}</span>}
          {reviewStatus && (
            <span className="diff-status-badge">{reviewStatus}</span>
          )}
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
          {/* Review Changes button for file-modifying tools */}
          {isFileModifying && status === 'completed' && !existingDiff && filePath && (
            <div className="tool-card-section">
              <button
                className="tool-card-review-btn"
                onClick={handleReviewChanges}
              >
                Review Changes
              </button>
            </div>
          )}
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
