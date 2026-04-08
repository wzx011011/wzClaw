import React from 'react'
import { useNotificationStore } from '../../stores/notification-store'
import type { NotificationType } from '../../stores/notification-store'

const ICONS: Record<NotificationType, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕'
}

export default function ToastContainer(): JSX.Element {
  const notifications = useNotificationStore((s) => s.notifications)
  const dismiss = useNotificationStore((s) => s.dismiss)

  if (notifications.length === 0) return <></>

  return (
    <div className="toast-container">
      {notifications.map((n) => (
        <div key={n.id} className={`toast toast-${n.type}`}>
          <span className="toast-icon">{ICONS[n.type]}</span>
          <span className="toast-message">{n.message}</span>
          <button className="toast-dismiss" onClick={() => dismiss(n.id)}>×</button>
        </div>
      ))}
    </div>
  )
}
