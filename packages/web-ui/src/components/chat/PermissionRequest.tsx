// ============================================================
// PermissionRequest — 工具权限请求弹窗
//
// Agent 执行高风险工具前（bash write、文件删除等）会发出权限请求。
// 此组件显示操作详情 + Allow / Deny 两个按钮。
// ============================================================

import React from 'react'

export interface PermissionRequestData {
  /** 请求 ID（用于响应时匹配） */
  requestId: string
  /** 工具名称 */
  toolName: string
  /** 操作描述（如 'write /etc/hosts'） */
  description: string
  /** 详细内容（可选，如文件内容、命令字符串） */
  detail?: string
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high'
}

interface PermissionRequestProps {
  request: PermissionRequestData
  onAllow: (requestId: string) => void
  onDeny: (requestId: string) => void
}

const RISK_COLORS: Record<PermissionRequestData['riskLevel'], string> = {
  low:    'var(--tool-completed, #22c55e)',
  medium: 'var(--warning, #f59e0b)',
  high:   'var(--tool-error, #ef4444)',
}

const RISK_LABELS: Record<PermissionRequestData['riskLevel'], string> = {
  low:    '低风险',
  medium: '中风险',
  high:   '高风险',
}

/**
 * PermissionRequest — 显示在 ChatPanel 底部的权限请求卡片
 */
export default function PermissionRequest({ request, onAllow, onDeny }: PermissionRequestProps): React.ReactElement {
  const riskColor = RISK_COLORS[request.riskLevel]
  const riskLabel = RISK_LABELS[request.riskLevel]

  return (
    <div style={{
      margin: '8px 12px',
      padding: '12px 14px',
      background: 'var(--bg-secondary, #2a2a3e)',
      border: `1px solid ${riskColor}60`,
      borderLeft: `3px solid ${riskColor}`,
      borderRadius: 'var(--radius-sm, 4px)',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
    }}>
      {/* 标题行 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={riskColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <span style={{ fontSize: 'var(--font-size-sm, 12px)', fontWeight: 600, color: 'var(--text-primary, #e0e0e0)' }}>
            权限请求
          </span>
        </div>
        <span style={{
          fontSize: '10px',
          padding: '2px 6px',
          borderRadius: '9999px',
          background: `${riskColor}20`,
          color: riskColor,
          fontWeight: 500,
        }}>
          {riskLabel}
        </span>
      </div>

      {/* 工具名 + 描述 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-secondary, #888)' }}>
          工具：<code style={{ color: 'var(--accent, #7b6ef6)' }}>{request.toolName}</code>
        </span>
        <span style={{ fontSize: 'var(--font-size-sm, 12px)', color: 'var(--text-primary, #e0e0e0)', lineHeight: 1.5 }}>
          {request.description}
        </span>
      </div>

      {/* 详情内容（可选） */}
      {request.detail && (
        <pre style={{
          margin: 0,
          padding: '8px 10px',
          background: 'var(--bg-primary, #1a1a2e)',
          borderRadius: 'var(--radius-sm, 4px)',
          fontSize: '11px',
          color: 'var(--text-secondary, #888)',
          overflow: 'auto',
          maxHeight: '120px',
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}>
          {request.detail}
        </pre>
      )}

      {/* 按钮 */}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          onClick={() => onDeny(request.requestId)}
          style={{
            padding: '6px 14px',
            background: 'transparent',
            border: '1px solid var(--border, #333)',
            borderRadius: 'var(--radius-sm, 4px)',
            color: 'var(--text-secondary, #888)',
            cursor: 'pointer',
            fontSize: 'var(--font-size-sm, 12px)',
          }}
        >
          拒绝
        </button>
        <button
          onClick={() => onAllow(request.requestId)}
          style={{
            padding: '6px 14px',
            background: 'var(--accent, #7b6ef6)',
            border: 'none',
            borderRadius: 'var(--radius-sm, 4px)',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 'var(--font-size-sm, 12px)',
            fontWeight: 600,
          }}
        >
          允许
        </button>
      </div>
    </div>
  )
}
