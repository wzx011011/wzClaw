import React from 'react'
import { useDiffStore } from '../../stores/diff-store'

// ============================================================
// DiffPreview — Inline diff toolbar with Accept All / Reject All
// and per-hunk Accept/Reject buttons (per DIFF-01 through DIFF-07)
// ============================================================

export default function DiffPreview(): JSX.Element | null {
  const activeDiffId = useDiffStore((s) => s.activeDiffId)
  const pendingDiffs = useDiffStore((s) => s.pendingDiffs)
  const acceptHunk = useDiffStore((s) => s.acceptHunk)
  const rejectHunk = useDiffStore((s) => s.rejectHunk)
  const acceptAll = useDiffStore((s) => s.acceptAll)
  const rejectAll = useDiffStore((s) => s.rejectAll)
  const setActiveDiff = useDiffStore((s) => s.setActiveDiff)

  if (!activeDiffId) return null

  const diff = pendingDiffs.find((d) => d.id === activeDiffId)
  if (!diff) return null

  const pendingCount = diff.hunks.filter((h) => h.status === 'pending').length
  const totalHunks = diff.hunks.length

  const handleClose = (): void => {
    setActiveDiff(null)
  }

  const handleAcceptAll = async (): Promise<void> => {
    await acceptAll(activeDiffId)
  }

  const handleRejectAll = async (): Promise<void> => {
    await rejectAll(activeDiffId)
  }

  const handleAcceptHunk = async (hunkId: string): Promise<void> => {
    await acceptHunk(activeDiffId, hunkId)
  }

  const handleRejectHunk = async (hunkId: string): Promise<void> => {
    await rejectHunk(activeDiffId, hunkId)
  }

  return (
    <div className="diff-preview">
      {/* Toolbar */}
      <div className="diff-preview-toolbar">
        <div className="diff-preview-toolbar-left">
          <span className="diff-preview-file">{diff.filePath}</span>
          <span className="diff-status-badge">
            {pendingCount} of {totalHunks} pending
          </span>
        </div>
        <div className="diff-preview-toolbar-right">
          <button
            className="diff-toolbar-btn accept-all"
            onClick={handleAcceptAll}
            disabled={pendingCount === 0}
            title="Accept all changes"
          >
            Accept All
          </button>
          <button
            className="diff-toolbar-btn reject-all"
            onClick={handleRejectAll}
            disabled={pendingCount === 0}
            title="Reject all changes"
          >
            Reject All
          </button>
          <button
            className="diff-toolbar-btn close-btn"
            onClick={handleClose}
            title="Close diff preview"
          >
            x
          </button>
        </div>
      </div>

      {/* Hunk list with per-hunk actions */}
      <div className="diff-hunk-list">
        {diff.hunks.map((hunk) => (
          <div key={hunk.id} className={`diff-hunk diff-hunk-${hunk.type} diff-hunk-${hunk.status}`}>
            <div className="diff-hunk-header">
              <span className="diff-hunk-type">
                {hunk.type === 'add' ? '+' : hunk.type === 'delete' ? '-' : '~'}
              </span>
              <span className="diff-hunk-lines">
                Lines {hunk.startIndex + 1}-{hunk.endIndex + 1}
              </span>
              <div className="diff-hunk-actions">
                {hunk.status === 'pending' && (
                  <>
                    <button
                      className="diff-hunk-action accept"
                      onClick={() => handleAcceptHunk(hunk.id)}
                      title="Accept this change"
                    >
                      ✓
                    </button>
                    <button
                      className="diff-hunk-action reject"
                      onClick={() => handleRejectHunk(hunk.id)}
                      title="Reject this change"
                    >
                      ✗
                    </button>
                  </>
                )}
                {hunk.status !== 'pending' && (
                  <span className={`diff-hunk-status diff-hunk-status-${hunk.status}`}>
                    {hunk.status}
                  </span>
                )}
              </div>
            </div>
            <div className="diff-hunk-content">
              {hunk.type !== 'add' && hunk.originalLines.map((line, idx) => (
                <div key={`del-${idx}`} className="diff-line diff-line-deleted">
                  <span className="diff-line-prefix">-</span>
                  <span className="diff-line-text">{line}</span>
                </div>
              ))}
              {hunk.type !== 'delete' && hunk.modifiedLines.map((line, idx) => (
                <div key={`add-${idx}`} className="diff-line diff-line-added">
                  <span className="diff-line-prefix">+</span>
                  <span className="diff-line-text">{line}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
