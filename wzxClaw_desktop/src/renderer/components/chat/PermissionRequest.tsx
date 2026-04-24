import React, { useState, useEffect } from 'react'

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
        <div className="permission-request-title">Permission Request: {toolName}</div>
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
          Remember for this session
        </label>
        <div className="permission-btn-group">
          <button className="permission-btn permission-btn-deny" onClick={handleDeny}>
            Deny
          </button>
          <button className="permission-btn permission-btn-approve" onClick={handleApprove}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
