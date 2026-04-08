import React, { useState } from 'react'
import { useDiffStore } from '../../stores/diff-store'
import type { PendingDiff } from '../../../shared/types'

// ============================================================
// ToolCard — Inline tool call visualization (per D-61, D-62, D-63, D-64)
// Shows "Review Changes" button for FileWrite/FileEdit tools (DIFF-01)
// Special rendering for WebSearch, WebFetch, GoToDefinition, FindReferences, SearchSymbols
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

// ============================================================
// URL Safety Check — prevent XSS from javascript: URIs
// ============================================================

function isSafeUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

// ============================================================
// WebSearch Output Renderer
// ============================================================

function renderWebSearchOutput(output: string): JSX.Element {
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
// WebFetch Output Renderer
// ============================================================

function renderWebFetchOutput(output: string, expanded: boolean): JSX.Element {
  // Extract source URL from first line
  const lines = output.split('\n')
  const sourceLine = lines[0]?.startsWith('Source: ') ? lines[0] : null
  const sourceUrl = sourceLine?.replace('Source: ', '') ?? ''
  const contentStart = sourceLine ? lines.slice(1).join('\n').trim() : output

  return (
    <div>
      {sourceUrl && (
        <div className="tool-card-web-source">
          Source:{' '}
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
// Symbol Navigation Output Renderer
// ============================================================

function renderSymbolNavOutput(toolName: string, output: string): JSX.Element {
  const lines = output.split('\n').filter((l) => l.trim().length > 0)

  // Parse header line and result lines
  const results: Array<{ filePath: string; line: string; kind: string; symbolName: string }> = []

  for (const line of lines) {
    // Match patterns like "  path/to/file.ts:42 (function)"
    const match = line.match(/\s+([^\s]+):(\d+)\s+\(([^)]+)\)/)
    if (match) {
      results.push({ filePath: match[1], line: match[2], kind: match[3], symbolName: '' })
    }
    // Match "Definition: symbolName\n  File: path:line\n  Kind: kind"
    const fileMatch = line.match(/File:\s*([^\s]+):(\d+)/)
    const kindMatch = line.match(/Kind:\s*(.+)/)
    if (fileMatch) {
      results.push({
        filePath: fileMatch[1],
        line: fileMatch[2],
        kind: kindMatch?.[1] ?? 'unknown',
        symbolName: ''
      })
    }
    // Match "  symbolName (kind) at path:line"
    const symMatch = line.match(/\s+(\S+)\s+\(([^)]+)\)\s+at\s+([^\s]+):(\d+)/)
    if (symMatch) {
      results.push({
        filePath: symMatch[3],
        line: symMatch[4],
        kind: symMatch[2],
        symbolName: symMatch[1]
      })
    }
  }

  if (results.length === 0) {
    return <div className="tool-card-section-content">{output}</div>
  }

  const getKindColor = (kind: string): string => {
    const lower = kind.toLowerCase()
    if (lower.includes('function') || lower.includes('method')) return '#89d185'
    if (lower.includes('class') || lower.includes('interface') || lower.includes('type'))
      return '#569cd6'
    return '#9cdcfe'
  }

  return (
    <div>
      {results.map((r, i) => (
        <div key={i} className="tool-card-web-result">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <a className="tool-card-web-url" href="#" title={r.filePath}>
              {r.filePath}:{r.line}
            </a>
            <span
              style={{
                fontSize: '10px',
                padding: '1px 6px',
                borderRadius: '8px',
                background: `${getKindColor(r.kind)}20`,
                color: getKindColor(r.kind)
              }}
            >
              {r.kind}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================================================
// Main ToolCard Component
// ============================================================

export default function ToolCard({ toolCall, originalContent }: ToolCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [outputExpanded, setOutputExpanded] = useState(false)
  const [webFetchExpanded, setWebFetchExpanded] = useState(false)

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

  // Determine if this tool has special rendering
  const isWebSearch = name === 'WebSearch'
  const isWebFetch = name === 'WebFetch'
  const isSymbolNav =
    name === 'GoToDefinition' || name === 'FindReferences' || name === 'SearchSymbols'
  const hasSpecialOutput = isWebSearch || isWebFetch || isSymbolNav

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

    let modifiedContent: string
    if (name === 'FileWrite') {
      modifiedContent = String(input?.content ?? '')
    } else {
      // FileEdit: compute modified content by applying old_string -> new_string replacement
      const oldStr = String(input?.old_string ?? '')
      const newStr = String(input?.new_string ?? '')
      const original = originalContent ?? ''
      // Use single replacement (FileEdit already validates uniqueness)
      modifiedContent = oldStr ? original.replace(oldStr, newStr) : original
    }

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

  // Render special input section for web/symbol tools
  const renderSpecialInput = (): JSX.Element | null => {
    if (isWebSearch && input?.query) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Query</div>
          <div className="tool-card-section-content" style={{ fontSize: '11px', fontFamily: 'Consolas, Courier New, monospace' }}>
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
              fontSize: '11px',
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
    if (isSymbolNav) {
      const symbolName = input?.symbolName ? String(input.symbolName) : input?.query ? String(input.query) : ''
      const symFilePath = input?.filePath ? String(input.filePath) : ''
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Symbol</div>
          <div className="tool-card-section-content" style={{ fontSize: '11px', fontFamily: 'Consolas, Courier New, monospace' }}>
            {symbolName}
            {symFilePath && <span style={{ color: 'var(--text-secondary)', marginLeft: '8px' }}>({symFilePath})</span>}
          </div>
        </div>
      )
    }
    return null
  }

  // Render special output section
  const renderSpecialOutput = (): JSX.Element | null => {
    if (!outputText) return null

    if (isWebSearch) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Results</div>
          {renderWebSearchOutput(outputText)}
        </div>
      )
    }
    if (isWebFetch) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Content</div>
          {renderWebFetchOutput(outputText, webFetchExpanded)}
          <button
            className="tool-card-show-more"
            onClick={() => setWebFetchExpanded(!webFetchExpanded)}
          >
            {webFetchExpanded ? 'Show less' : 'Show more'}
          </button>
        </div>
      )
    }
    if (isSymbolNav) {
      return (
        <div className="tool-card-section">
          <div className="tool-card-section-label">Results</div>
          {renderSymbolNavOutput(name, outputText)}
        </div>
      )
    }
    return null
  }

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
          {/* Special rendering for web/symbol tools */}
          {hasSpecialOutput ? (
            <>
              {renderSpecialInput()}
              {renderSpecialOutput()}
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      )}
    </div>
  )
}
