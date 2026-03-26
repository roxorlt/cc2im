import React, { useEffect, useRef } from 'react'
import type { MessageEntry } from '../hooks/useWebSocket'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function MsgBubble({ entry, index }: { entry: MessageEntry; index: number }) {
  const ev = entry.event
  const isOut = ev.kind === 'message_out'
  const isPerm = ev.kind === 'permission_request' || ev.kind === 'permission_verdict'

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
        animation: 'fade-in 0.3s ease',
        animationDelay: `${index * 30}ms`,
        animationFillMode: 'backwards',
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
      animation: isOut ? 'slide-in-right 0.25s ease' : 'slide-in-left 0.25s ease',
      animationDelay: `${index * 30}ms`,
      animationFillMode: 'backwards',
    }}>
      <div style={{
        padding: '10px 14px',
        borderRadius: isOut ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
        background: isOut ? 'rgba(16, 185, 129, 0.08)' : 'var(--bg-card)',
        border: `1px solid ${isOut ? 'rgba(16, 185, 129, 0.15)' : 'var(--border)'}`,
        fontSize: 12.5, lineHeight: 1.6,
        whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
        color: 'var(--text)',
      }}>
        {ev.text}
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
  const filtered = messages.filter(m => m.event.agentId === agentId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
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
      {filtered.map((m, i) => <MsgBubble key={i} entry={m} index={i} />)}
      <div ref={bottomRef} />
    </div>
  )
}
