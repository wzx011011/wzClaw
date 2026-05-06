import React, { useState, useEffect } from 'react'
import { useT } from '../../i18n/useT'

// ============================================================
// PermissionRequest — Approve/deny UI for tool permission requests (per D-64, D-65)
// ============================================================

interface PendingPermission {
  toolName: string
  toolInput: Record<string, unknown>
  reason: string
}

export default function PermissionRequest(): JSX.Element | null {
  const [pendingRequest, setPendingRequest] = useState<PendingPermission | null>(null)
  const t = useT()
  const [sessionCache, setSessionCache] = useState(false)

  useEffect(() => {
    const unsubscribe = window.wzxclaw.onPermissionRequest((payload) => {
      setPendingRequest(payload)
      setSessionCache(false)
    })
    return unsubscribe
  }, [])

  const handleApprove = (): void => {
    window.wzxclaw.sendPermissionResponse({ approved: true, sessionCache })
    setPendingRequest(null)
  }

  const handleDeny = (): void => {
    window.wzxclaw.sendPermissionResponse({ approved: false, sessionCache: false })
    setPendingRequest(null)
  }

  if (!pendingRequest) {
    return null
  }

  const { toolName, toolInput, reason } = pendingRequest

  return (
    <div className="permission-request">
      <div className="permission-request-header">
        <div className="permission-request-title">{t('permission.title', { tool: toolName })}</div>
        {reason && <div className="permission-request-reason">{reason}</div>}
      </div>
      <div className="permission-request-input">
        {JSON.stringify(toolInput, null, 2)}
      </div>
      <div className="permission-request-actions">
        <label className="permission-session-cache">
          <input
            type="checkbox"
            checked={sessionCache}
            onChange={(e) => setSessionCache(e.target.checked)}
          />
          {t('permission.rememberSession')}
        </label>
        <div className="permission-btn-group">
          <button className="permission-btn permission-btn-deny" onClick={handleDeny}>
            {t('permission.deny')}
          </button>
          <button className="permission-btn permission-btn-approve" onClick={handleApprove}>
            {t('permission.approve')}
          </button>
        </div>
      </div>
    </div>
  )
}
