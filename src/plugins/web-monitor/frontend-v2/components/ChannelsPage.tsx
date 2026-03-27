import React, { useState } from 'react'
import { QrLoginOverlay } from './QrLoginOverlay'
import type { ChannelInfo, QrLoginState } from '../hooks/useWebSocket'

interface ChannelsPageProps {
  channels: ChannelInfo[]
  showAddDialog: boolean
  onCloseAddDialog: () => void
  onRefreshChannels: () => void
  qrLogin: QrLoginState | null
  onTriggerLogin: (channelId: string) => void
  onCloseQr: () => void
}

const statusLabels: Record<string, { label: string; color: string }> = {
  connected: { label: 'connected', color: 'var(--green)' },
  connecting: { label: 'connecting...', color: 'var(--amber)' },
  disconnected: { label: 'disconnected', color: 'var(--text-muted)' },
  expired: { label: 'session 已过期', color: 'var(--red)' },
}

const btnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)',
  fontFamily: 'var(--font-mono)',
}

function ChannelCard({ channel, isLast, onRefreshChannels, onTriggerLogin }: { channel: ChannelInfo; isLast: boolean; onRefreshChannels: () => void; onTriggerLogin: (id: string) => void }) {
  const status = statusLabels[channel.status] || statusLabels.disconnected
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleProbe = async () => {
    setProbing(true)
    setProbeResult(null)
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}/probe`, { method: 'POST' })
      const data = await res.json()
      setProbeResult(data.status)
    } catch {
      setProbeResult('error')
    } finally {
      setProbing(false)
    }
  }

  const handleDisconnect = async () => {
    setDisconnecting(true)
    try {
      await fetch(`/api/channels/${encodeURIComponent(channel.id)}/disconnect`, { method: 'POST' })
    } catch (err) {
      console.error('Disconnect failed:', err)
    } finally {
      setDisconnecting(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE' })
      if (res.ok) onRefreshChannels()
    } catch (err) {
      console.error('Delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }

  // Parse channel type from id: "weixin-roxor" → "微信"
  const dashIdx = channel.id.indexOf('-')
  const channelType = dashIdx > 0 ? channel.id.slice(0, dashIdx) : channel.id
  const typeLabel = channelType === 'weixin' ? '微信' : channelType

  return (
    <div style={{
      padding: '16px 20px', borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
    }}>
      {/* Row 1: type + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 500 }}>{typeLabel}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{channel.label}</span>
      </div>

      {/* Row 2: status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: status.color }} />
        <span style={{ fontSize: 11, color: status.color }}>{status.label}</span>
        {probeResult && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 8 }}>
            (probe: {probeResult})
          </span>
        )}
      </div>

      {/* Row 3: expired warning */}
      {channel.status === 'expired' && (
        <div style={{
          padding: '10px 14px', borderRadius: 6, marginBottom: 8,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
          fontSize: 11, color: 'var(--red)',
        }}>
          ⚠ Session 已过期，需要重新扫码登录
        </div>
      )}

      {/* Row 4: actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={handleProbe} disabled={probing} style={btnStyle}>
          {probing ? '检查中...' : '检查连接'}
        </button>
        {channel.status === 'connected' && (
          <button onClick={handleDisconnect} disabled={disconnecting} style={{ ...btnStyle, color: 'var(--red)' }}>
            {disconnecting ? '断开中...' : '断开'}
          </button>
        )}
        {channel.status === 'expired' && (
          <button onClick={() => onTriggerLogin(channel.id)} style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
            重新登录
          </button>
        )}
        {!isLast && (channel.status === 'disconnected' || channel.status === 'expired') && (
          <button onClick={handleDelete} disabled={deleting} style={{ ...btnStyle, color: 'var(--red)' }}>
            {deleting ? '删除中...' : '删除'}
          </button>
        )}
      </div>
    </div>
  )
}

function AddChannelDialog({ onClose, onTriggerLogin }: { onClose: () => void; onTriggerLogin: (channelId: string) => void }) {
  const [type, setType] = useState('weixin')
  const [accountName, setAccountName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreate = async () => {
    if (!accountName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, accountName: accountName.trim() }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed')
        return
      }
      const data = await res.json()
      onClose()
      onTriggerLogin(data.id)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

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
          padding: '24px 28px', borderRadius: 10,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>新增频道</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>频道类型</label>
              <select value={type} onChange={e => setType(e.target.value)}
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 4,
                  border: '1px solid var(--border)', background: 'var(--bg-deep)',
                  color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)',
                }}>
                <option value="weixin">微信</option>
                <option value="telegram" disabled>Telegram (TBC)</option>
              </select>
            </div>

            <div>
              <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>授权账号名</label>
              <input value={accountName} onChange={e => setAccountName(e.target.value)}
                autoFocus
                placeholder="如 roxor、家人"
                style={{
                  width: '100%', padding: '6px 10px', borderRadius: 4,
                  border: '1px solid var(--border)', background: 'var(--bg-deep)',
                  color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
                  fontFamily: 'var(--font-mono)',
                }}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              />
            </div>

            {error && (
              <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <button onClick={onClose} style={btnStyle}>取消</button>
              <button onClick={handleCreate} disabled={creating || !accountName.trim()}
                style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
                {creating ? '创建中...' : '创建'}
              </button>
            </div>
          </div>
      </div>
    </div>
  )
}

export function ChannelsPage({ channels, showAddDialog, onCloseAddDialog, onRefreshChannels, qrLogin, onTriggerLogin, onCloseQr }: ChannelsPageProps) {
  return (
    <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Channels</span>
      </div>

      {showAddDialog && (
        <AddChannelDialog onClose={onCloseAddDialog} onTriggerLogin={onTriggerLogin} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {channels.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 12 }}>
            暂无频道，点击侧栏「+ 新增频道」添加
          </div>
        ) : (
          channels.map(ch => <ChannelCard key={ch.id} channel={ch} isLast={channels.length <= 1} onRefreshChannels={onRefreshChannels} onTriggerLogin={onTriggerLogin} />)
        )}
      </div>

      {qrLogin && (
        <QrLoginOverlay
          qrUrl={qrLogin.qrUrl}
          status={qrLogin.status}
          onClose={onCloseQr}
          onRetry={() => onTriggerLogin(qrLogin.channelId)}
        />
      )}
    </div>
  )
}
