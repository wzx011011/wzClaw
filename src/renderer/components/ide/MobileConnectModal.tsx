import React, { useEffect, useState } from 'react'

interface MobileConnectModalProps {
  onClose: () => void
}

/**
 * MobileConnectModal — displays Relay QR code for mobile remote connection.
 */
export default function MobileConnectModal({ onClose }: MobileConnectModalProps): JSX.Element {
  const [relayQrCode, setRelayQrCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.wzxclaw
      .getRelayQrCode()
      .then((result) => {
        setRelayQrCode(result.qrCode)
        setLoading(false)
      })
      .catch((err: Error) => {
        setError(err.message)
        setLoading(false)
      })
  }, [])

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
          {loading && <p className="mobile-loading">正在生成二维码…</p>}

          {error && (
            <div className="mobile-error-container">
              <p className="mobile-error">无法生成二维码</p>
              <p className="mobile-error-detail">{error}</p>
              <p className="mobile-error-hint">请先在 Settings → Relay Token 中配置连接令牌</p>
            </div>
          )}

          {relayQrCode && (
            <>
              <div className="mobile-qr-container">
                <img src={relayQrCode} alt="Relay QR Code" className="mobile-qr" />
              </div>

              <p className="mobile-hint">用 wzxClaw 手机端扫码连接 Relay 服务器</p>
            </>
          )}
        </div>

        <div className="mobile-modal-footer">
          <button className="mobile-btn-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
