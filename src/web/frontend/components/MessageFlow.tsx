import React, { useEffect, useRef } from 'react'
import type { MessageEntry } from '../hooks/useWebSocket'

const css: Record<string, React.CSSProperties> = {
  container: { flex: 1, overflowY: 'auto', padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 4 },
  msgIn: { alignSelf: 'flex-start', background: '#1c2128', borderRadius: '12px 12px 12px 4px', padding: '8px 12px', maxWidth: '80%' },
  msgOut: { alignSelf: 'flex-end', background: '#1a3a2a', borderRadius: '12px 12px 4px 12px', padding: '8px 12px', maxWidth: '80%' },
  permission: { alignSelf: 'center', background: '#2d1f00', border: '1px solid #5a3e00', borderRadius: 8, padding: '6px 12px', fontSize: 12, maxWidth: '90%' },
  text: { fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const },
  time: { fontSize: 10, color: '#8b949e', marginTop: 2 },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function MessageFlow({ messages, agentId }: { messages: MessageEntry[]; agentId: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const filtered = messages.filter(m => m.event.agentId === agentId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [filtered.length])

  if (filtered.length === 0) {
    return <div style={css.empty}>暂无消息</div>
  }

  return (
    <div style={css.container}>
      {filtered.map((m, i) => {
        const ev = m.event
        if (ev.kind === 'permission_request') {
          return (
            <div key={i} style={css.permission}>
              🔐 权限请求: {ev.toolName}
              <div style={css.time}>{formatTime(ev.timestamp)}</div>
            </div>
          )
        }
        if (ev.kind === 'permission_verdict') {
          return (
            <div key={i} style={css.permission}>
              {ev.behavior === 'allow' || ev.behavior === 'always' ? '✅' : '❌'} 权限审批: {ev.behavior}
              <div style={css.time}>{formatTime(ev.timestamp)}</div>
            </div>
          )
        }
        const isOut = ev.kind === 'message_out'
        return (
          <div key={i} style={isOut ? css.msgOut : css.msgIn}>
            <div style={css.text}>{ev.text}</div>
            <div style={css.time}>{formatTime(ev.timestamp)}</div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
