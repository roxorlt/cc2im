import React, { useEffect, useRef, useState } from 'react'
import type { MessageEntry } from '../hooks/useWebSocket'

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

function MsgBubble({ entry, index, animate }: { entry: MessageEntry; index: number; animate?: boolean }) {
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

export function MessageFlow({ messages, agentId }: { messages: MessageEntry[]; agentId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const filtered = messages.filter(m => m.event.agentId === agentId)

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
      {filtered.map((m, i) => <MsgBubble key={i} entry={m} index={i} animate={i >= prevCountRef.current - 1} />)}
      <div ref={bottomRef} />
    </div>
  )
}
