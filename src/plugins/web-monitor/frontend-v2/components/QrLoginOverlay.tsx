import React, { useEffect } from 'react'

interface QrLoginOverlayProps {
  qrUrl: string
  status: 'pending' | 'scanned' | 'confirmed' | 'expired'
  onClose: () => void
  onRetry: () => void
}

const statusConfig: Record<string, { text: string; color: string }> = {
  pending:   { text: '请用微信扫描二维码', color: 'var(--text-dim)' },
  scanned:   { text: '已扫码，请在微信中确认授权...', color: 'var(--amber)' },
  confirmed: { text: '授权成功，正在连接...', color: 'var(--green)' },
  expired:   { text: '二维码已过期', color: 'var(--red)' },
}

export function QrLoginOverlay({ qrUrl, status, onClose, onRetry }: QrLoginOverlayProps) {
  // Auto-close on confirmed after delay
  useEffect(() => {
    if (status === 'confirmed') {
      const t = setTimeout(onClose, 2000)
      return () => clearTimeout(t)
    }
  }, [status, onClose])

  const cfg = statusConfig[status] || statusConfig.pending

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          padding: '28px 32px', borderRadius: 10,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>微信扫码登录</div>

        {/* QR code image */}
        <div style={{
          width: 220, height: 220, borderRadius: 8,
          background: '#fff', padding: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: status === 'expired' ? 0.3 : 1,
          transition: 'opacity 0.3s',
        }}>
          <img
            src={qrUrl}
            alt="WeChat QR Code"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>

        {/* Status text */}
        <div style={{
          fontSize: 12, color: cfg.color, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {status === 'scanned' && (
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: cfg.color, animation: 'pulse-green 1.5s infinite' }} />
          )}
          {status === 'confirmed' && <span>✓</span>}
          {cfg.text}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          {status === 'expired' && (
            <button onClick={onRetry} style={{
              padding: '6px 16px', borderRadius: 4,
              border: '1px solid var(--accent)', background: 'none',
              color: 'var(--accent)', fontSize: 11, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}>
              重新获取
            </button>
          )}
          <button onClick={onClose} style={{
            padding: '6px 16px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'none',
            color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}>
            {status === 'confirmed' ? '完成' : '取消'}
          </button>
        </div>
      </div>
    </div>
  )
}
