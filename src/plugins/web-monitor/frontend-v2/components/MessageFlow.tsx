import React, { useEffect, useRef, useState } from 'react'
import type { MessageEntry, HubEventData } from '../hooks/useWebSocket'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function MediaContent({ mediaUrl, msgType }: { mediaUrl: string; msgType: string }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>媒体已过期</span>
  }

  if (msgType === 'image') {
    return (
      <img
        src={mediaUrl}
        onError={() => setFailed(true)}
        style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 6, display: 'block', cursor: 'pointer' }}
        onClick={() => window.open(mediaUrl, '_blank')}
      />
    )
  }

  if (msgType === 'video') {
    return (
      <video
        src={mediaUrl}
        controls
        onError={() => setFailed(true)}
        style={{ maxWidth: '100%', maxHeight: 300, borderRadius: 6, display: 'block' }}
      />
    )
  }

  if (msgType === 'voice') {
    return null // voice rendered as text label in bubble
  }

  // file or unknown
  const filename = mediaUrl.split('/').pop() || 'file'
  const ext = filename.split('.').pop()?.toLowerCase()
  const icon = ext === 'pdf' ? '📄' : '📎'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 140, maxWidth: '100%' }}>
      <span style={{ fontSize: 18, flexShrink: 0 }}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{filename}</div>
      <a href={mediaUrl} target="_blank" rel="noopener" style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', flexShrink: 0 }}>
        查看
      </a>
    </div>
  )
}

function MsgHeader({ event, nicknames, onSetNickname }: {
  event: HubEventData
  nicknames: Map<string, string>
  onSetNickname: (channelId: string, userId: string, nickname: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!event.channelId || !event.userId) return null

  const key = `${event.channelId}:${event.userId}`
  const nickname = nicknames.get(key)
  // Show nickname if set, otherwise show last 8 chars of userId
  const displayName = nickname || (event.userId.length > 8 ? '...' + event.userId.slice(-8) : event.userId)

  // Channel label: channelId is like "weixin-roxor" → display as-is
  const channelLabel = event.channelId

  if (editing) {
    return (
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{channelLabel} |</span>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && draft.trim()) {
              onSetNickname(event.channelId!, event.userId!, draft.trim())
              setEditing(false)
            }
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => setEditing(false)}
          style={{
            background: 'var(--bg-deep)', border: '1px solid var(--border)',
            borderRadius: 3, padding: '1px 6px',
            fontSize: 10, color: 'var(--text)', outline: 'none',
            width: 80, fontFamily: 'var(--font-mono)',
          }}
          placeholder={displayName}
        />
      </div>
    )
  }

  return (
    <div className="msg-header" style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
      <span>{channelLabel}</span>
      <span style={{ color: 'var(--text-muted)' }}>|</span>
      <span>{displayName}</span>
      <span
        onClick={() => { setDraft(nickname || ''); setEditing(true) }}
        className="edit-pencil"
        style={{ cursor: 'pointer', opacity: 0, transition: 'opacity 0.15s', fontSize: 9, marginLeft: 2 }}
      >&#x270F;&#xFE0F;</span>
    </div>
  )
}

function MsgBubble({ entry, index, animate, showHeader, nicknames, onSetNickname }: {
  entry: MessageEntry; index: number; animate?: boolean; showHeader?: boolean
  nicknames: Map<string, string>
  onSetNickname: (channelId: string, userId: string, nickname: string) => void
}) {
  const ev = entry.event
  const isOut = ev.kind === 'message_out'
  const isPerm = ev.kind === 'permission_request' || ev.kind === 'permission_verdict'
  const hasMedia = ev.mediaUrl && ev.msgType && ev.msgType !== 'text'

  if (isPerm) {
    const icon = ev.kind === 'permission_request' ? '⚡' : (ev.behavior === 'allow' || ev.behavior === 'always' ? '✓' : '✗')
    const color = ev.kind === 'permission_request' ? 'var(--amber)' : (ev.behavior === 'allow' || ev.behavior === 'always' ? 'var(--green)' : 'var(--red)')
    return (
      <div style={{
        alignSelf: 'center', maxWidth: '85%',
        padding: '6px 14px', borderRadius: 6,
        border: `1px solid ${color}33`,
        background: `${color}08`,
        fontSize: 11, color,
        display: 'flex', alignItems: 'center', gap: 6,
        ...(animate ? { animation: 'fade-in 0.3s ease' } : {}),
      }}>
        <span>{icon}</span>
        <span>{ev.kind === 'permission_request' ? ev.toolName : `${ev.behavior}`}</span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 'auto' }}>{formatTime(ev.timestamp)}</span>
      </div>
    )
  }

  return (
    <div style={{
      alignSelf: isOut ? 'flex-end' : 'flex-start',
      maxWidth: '75%',
      ...(animate ? {
        animation: isOut ? 'slide-in-right 0.25s ease' : 'slide-in-left 0.25s ease',
      } : {}),
    }}>
      {!isOut && !isPerm && showHeader && (
        <MsgHeader event={ev} nicknames={nicknames} onSetNickname={onSetNickname} />
      )}
      <div style={{
        padding: '10px 14px',
        borderRadius: isOut ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        background: isOut ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-card)',
        border: `1px solid ${isOut ? 'rgba(16, 185, 129, 0.15)' : 'var(--border)'}`,
        fontSize: 12.5, lineHeight: 1.6,
        color: 'var(--text)',
        ...(hasMedia ? {} : { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }),
      }}>
        {hasMedia && ev.msgType !== 'voice' && <MediaContent mediaUrl={ev.mediaUrl!} msgType={ev.msgType!} />}
        {ev.msgType === 'voice' ? (
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const }}>
            <span style={{ color: 'var(--text-muted)' }}>[语音消息]</span> {ev.text}
          </span>
        ) : ev.text && !hasMedia ? (
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const }}>
            {ev.text}
          </span>
        ) : null}
      </div>
      <div style={{
        fontSize: 9, color: 'var(--text-muted)',
        marginTop: 3,
        textAlign: isOut ? 'right' : 'left',
        padding: '0 4px',
      }}>
        {formatTime(ev.timestamp)}
      </div>
    </div>
  )
}

interface MessageFlowProps {
  messages: MessageEntry[]
  agentId: string
  channelFilter: string | null
  nicknames: Map<string, string>
  onSetNickname: (channelId: string, userId: string, nickname: string) => void
}

export function MessageFlow({ messages, agentId, channelFilter, nicknames, onSetNickname }: MessageFlowProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const filtered = messages.filter(m => {
    if (m.event.agentId !== agentId) return false
    if (channelFilter && m.event.channelId !== channelFilter) return false
    return true
  })

  useEffect(() => {
    // First load: jump instantly. New messages: smooth scroll.
    const isInitial = prevCountRef.current === 0
    bottomRef.current?.scrollIntoView({ behavior: isInitial ? 'instant' : 'smooth' })
    prevCountRef.current = filtered.length
  }, [filtered.length])

  if (filtered.length === 0) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
        color: 'var(--text-muted)',
      }}>
        <span style={{ fontSize: 28, opacity: 0.3 }}>◇</span>
        <span style={{ fontSize: 12 }}>等待消息</span>
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, overflowY: 'auto',
      padding: '16px 20px',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {filtered.map((m, i) => {
        const prev = i > 0 ? filtered[i - 1] : null
        const showHeader = !prev
          || prev.event.userId !== m.event.userId
          || prev.event.channelId !== m.event.channelId
          || prev.event.kind !== m.event.kind

        return <MsgBubble key={i} entry={m} index={i} animate={i >= prevCountRef.current - 1}
          showHeader={showHeader} nicknames={nicknames} onSetNickname={onSetNickname} />
      })}
      <div ref={bottomRef} />
    </div>
  )
}
