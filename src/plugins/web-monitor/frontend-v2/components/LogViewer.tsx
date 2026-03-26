import React, { useEffect, useRef } from 'react'

const sourceColors: Record<string, string> = {
  hub: 'var(--accent)',
  brain: 'var(--green)',
  demo: 'var(--amber)',
}

export function LogViewer({ logs, source }: { logs: Array<{ source: string; line: string; ts: string }>; source: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const filtered = logs.filter(l => l.source === source || l.source === 'hub')

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
        <span style={{ fontSize: 28, opacity: 0.3 }}>▸</span>
        <span style={{ fontSize: 12 }}>等待日志</span>
      </div>
    )
  }

  return (
    <div style={{
      flex: 1, overflowY: 'auto',
      padding: '8px 0', fontSize: 11.5, lineHeight: 1.7,
      fontFamily: 'var(--font-mono)',
    }}>
      {filtered.map((l, i) => (
        <div
          key={i}
          style={{
            padding: '1px 16px',
            borderLeft: `2px solid ${sourceColors[l.source] || 'var(--border)'}`,
            marginLeft: 8,
            animation: 'fade-in 0.2s ease',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-card)'}
          onMouseLeave={e => e.currentTarget.style.background = ''}
        >
          <span style={{ color: sourceColors[l.source] || 'var(--text-dim)', fontWeight: 500, marginRight: 8 }}>
            {l.source}
          </span>
          <span style={{ color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const }}>
            {l.line}
          </span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
