import React, { useEffect, useState } from 'react'

interface MobileStatus {
  running: boolean
  port: number | null
  localUrl: string | null
  tunnelUrl: string | null
  clients: Array<{ id: string; userAgent: string; connectedAt: number }>
}

interface MobileConnectModalProps {
  onClose: () => void
}

/**
 * MobileConnectModal — displays QR codes for mobile remote connection.
 * Shows both LAN and WAN (tunnel) QR codes with tab switching.
 */
export default function MobileConnectModal({ onClose }: MobileConnectModalProps): JSX.Element {
  const [lanQrCode, setLanQrCode] = useState<string | null>(null)
  const [tunnelQrCode, setTunnelQrCode] = useState<string | null>(null)
  const [localUrl, setLocalUrl] = useState<string | null>(null)
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null)
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [status, setStatus] = useState<MobileStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'lan' | 'wan'>('lan')

  useEffect(() => {
    window.wzxclaw
      .startMobileServer()
      .then((result) => {
        setLanQrCode(result.lanQrCode)
        setTunnelQrCode(result.tunnelQrCode)
        setLocalUrl(result.localUrl)
        setTunnelUrl(result.tunnelUrl)
        setTunnelError(result.tunnelError)
        setLoading(false)
        // Default to WAN tab if tunnel is available
        if (result.tunnelQrCode) setActiveTab('wan')
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })

    const unsubStatus = window.wzxclaw.onMobileStatus((payload) => {
      setStatus(payload)
    })

    return () => {
      unsubStatus()
    }
  }, [])

  const handleStop = async () => {
    await window.wzxclaw.stopMobileServer()
    onClose()
  }

  const activeQr = activeTab === 'wan' ? tunnelQrCode : lanQrCode
  const activeUrl = activeTab === 'wan' ? tunnelUrl : localUrl

  return (
    <div className="mobile-modal-overlay" onClick={onClose}>
      <div className="mobile-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mobile-modal-header">
          <h2>连接手机</h2>
          <button className="mobile-modal-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="mobile-modal-body">
          {loading && <p className="mobile-loading">正在启动服务器…</p>}

          {error && <p className="mobile-error">启动失败: {error}</p>}

          {lanQrCode && (
            <>
              {/* Tab switcher for LAN / WAN */}
              <div className="mobile-qr-tabs">
                <button
                  className={`mobile-qr-tab${activeTab === 'lan' ? ' active' : ''}`}
                  onClick={() => setActiveTab('lan')}
                >
                  局域网
                </button>
                <button
                  className={`mobile-qr-tab${activeTab === 'wan' ? ' active' : ''}${!tunnelQrCode ? ' disabled' : ''}`}
                  onClick={() => tunnelQrCode && setActiveTab('wan')}
                  disabled={!tunnelQrCode}
                >
                  公网
                </button>
              </div>

              <div className="mobile-qr-container">
                <img src={activeQr!} alt="QR Code" className="mobile-qr" />
              </div>

              <p className="mobile-hint">
                {activeTab === 'lan'
                  ? '确保手机和电脑在同一 WiFi 网络'
                  : '扫码后如看到验证页面，请点击 "Click to Continue"'}
              </p>

              {activeUrl && (
                <div className="mobile-url-info">
                  <span className="mobile-url-label">{activeTab === 'wan' ? '公网:' : '局域网:'}</span>
                  <span className="mobile-url-value">{activeUrl.split('?')[0]}</span>
                </div>
              )}

              {activeTab === 'wan' && tunnelError && (
                <p className="mobile-tunnel-error">公网隧道创建失败: {tunnelError}</p>
              )}

              {!tunnelQrCode && tunnelError && activeTab === 'lan' && (
                <p className="mobile-tunnel-hint">提示: 公网隧道不可用 ({tunnelError})，可使用局域网连接</p>
              )}
            </>
          )}

          {status && status.clients.length > 0 && (
            <div className="mobile-clients">
              <h4>已连接设备 ({status.clients.length})</h4>
              {status.clients.map((c) => (
                <div key={c.id} className="mobile-client-item">
                  <span className="mobile-client-dot" />
                  <span className="mobile-client-ua">
                    {c.userAgent.length > 50 ? c.userAgent.slice(0, 50) + '…' : c.userAgent}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mobile-modal-footer">
          <button className="mobile-btn-stop" onClick={handleStop}>
            断开并关闭
          </button>
        </div>
      </div>
    </div>
  )
}
