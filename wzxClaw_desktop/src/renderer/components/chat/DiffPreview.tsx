import React, { useEffect, useState } from 'react'
import { useT } from '../../i18n/useT'
import { useDiffStore } from '../../stores/diff-store'

// ============================================================
// DiffPreview — Inline diff toolbar with Accept All / Reject All
// and per-hunk Accept/Reject buttons (per DIFF-01 through DIFF-07)
// Multi-file navigator for reviewing AI changes across files (DIFF-05)
// ============================================================

export default function DiffPreview(): JSX.Element | null {
  const t = useT()
  const activeDiffId = useDiffStore((s) => s.activeDiffId)
  const pendingDiffs = useDiffStore((s) => s.pendingDiffs)
  const acceptHunk = useDiffStore((s) => s.acceptHunk)
  const rejectHunk = useDiffStore((s) => s.rejectHunk)
  const acceptAll = useDiffStore((s) => s.acceptAll)
  const rejectAll = useDiffStore((s) => s.rejectAll)
  const setActiveDiff = useDiffStore((s) => s.setActiveDiff)
  const clearDiffs = useDiffStore((s) => s.clearDiffs)
  const [confirmAction, setConfirmAction] = useState<'accept' | 'reject' | null>(null)

  // Auto-clear when all diffs are fully resolved (no pending hunks remaining)
  useEffect(() => {
    if (pendingDiffs.length > 0) {
      const allResolved = pendingDiffs.every(
        (d) => d.hunks.filter((h) => h.status === 'pending').length === 0
      )
      if (allResolved) {
        clearDiffs()
      }
    }
  }, [pendingDiffs, clearDiffs])

  if (!activeDiffId) return null

  const currentIndex = pendingDiffs.findIndex((d) => d.id === activeDiffId)
  const diff = pendingDiffs.find((d) => d.id === activeDiffId)
  if (!diff) return null

  const pendingCount = diff.hunks.filter((h) => h.status === 'pending').length
  const totalHunks = diff.hunks.length

  const handleClose = (): void => {
    setActiveDiff(null)
  }

  // 批量操作确认 5 秒后自动取消
  useEffect(() => {
    if (!confirmAction) return
    const t = window.setTimeout(() => setConfirmAction(null), 5000)
    return () => window.clearTimeout(t)
  }, [confirmAction])

  const handleAcceptAll = async (): Promise<void> => {
    if (confirmAction !== 'accept') {
      setConfirmAction('accept')
      return
    }
    setConfirmAction(null)
    await acceptAll(activeDiffId)
  }

  const handleRejectAll = async (): Promise<void> => {
    if (confirmAction !== 'reject') {
      setConfirmAction('reject')
      return
    }
    setConfirmAction(null)
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
      {/* Multi-file navigator — shown when there are 2+ pending diffs */}
      {pendingDiffs.length > 1 && (
        <div className="diff-file-list">
          {pendingDiffs.map((d) => {
            const dPendingCount = d.hunks.filter((h) => h.status === 'pending').length
            const isResolved = dPendingCount === 0
            return (
              <div
                key={d.id}
                className={`diff-file-item${d.id === activeDiffId ? ' diff-file-item-active' : ''}${isResolved ? ' diff-file-item-resolved' : ''}`}
                onClick={() => setActiveDiff(d.id)}
                title={d.filePath}
              >
                <span className="diff-file-item-path">{d.filePath.split('/').pop()}</span>
                <span className="diff-file-item-badge">
                  {isResolved ? t('diff.done') : `${dPendingCount} ${t('diff.pending')}`}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="diff-preview-toolbar">
        <div className="diff-preview-toolbar-left">
          {pendingDiffs.length > 1 && (
            <>
              <button
                className="diff-toolbar-btn nav-btn"
                onClick={() => {
                  if (currentIndex > 0) setActiveDiff(pendingDiffs[currentIndex - 1].id)
                }}
                disabled={currentIndex <= 0}
                title={t('diff.prevFile')}
              >
                &lt;
              </button>
              <span className="diff-file-counter">
                {currentIndex + 1} / {pendingDiffs.length}
              </span>
              <button
                className="diff-toolbar-btn nav-btn"
                onClick={() => {
                  if (currentIndex < pendingDiffs.length - 1) setActiveDiff(pendingDiffs[currentIndex + 1].id)
                }}
                disabled={currentIndex >= pendingDiffs.length - 1}
                title={t('diff.nextFile')}
              >
                &gt;
              </button>
            </>
          )}
          <span className="diff-preview-file">{diff.filePath}</span>
          <span className="diff-status-badge">
            {pendingCount} / {totalHunks} {t('diff.pending')}
          </span>
        </div>
        <div className="diff-preview-toolbar-right">
          <button
            className="diff-toolbar-btn accept-all"
            onClick={handleAcceptAll}
            disabled={pendingCount === 0}
            title={t('diff.acceptAll')}
          >
            {confirmAction === 'accept' ? t('diff.confirmAccept') : t('diff.acceptAllConfirm')}
          </button>
          <button
            className="diff-toolbar-btn reject-all"
            onClick={handleRejectAll}
            disabled={pendingCount === 0}
            title={t('diff.rejectAll')}
          >
            {confirmAction === 'reject' ? t('diff.confirmReject') : t('diff.rejectAllConfirm')}
          </button>
          <button
            className="diff-toolbar-btn close-btn"
            onClick={handleClose}
            title={t('diff.closePreview')}
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
                {t('diff.lines', { start: hunk.startIndex + 1, end: hunk.endIndex + 1 })}
              </span>
              <div className="diff-hunk-actions">
                {hunk.status === 'pending' && (
                  <>
                    <button
                      className="diff-hunk-action accept"
                      onClick={() => handleAcceptHunk(hunk.id)}
                      title={t('diff.acceptChange')}
                    >
                      ✓
                    </button>
                    <button
                      className="diff-hunk-action reject"
                      onClick={() => handleRejectHunk(hunk.id)}
                      title={t('diff.rejectChange')}
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
