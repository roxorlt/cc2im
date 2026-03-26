import React, { useEffect, useRef } from 'react'

const sourceColors: Record<string, string> = {
  hub: 'var(--accent)',
  brain: 'var(--green)',
  demo: 'var(--amber)',
}

/** Extract ISO timestamp from log line like "[2026-03-26T14:00:00.000Z] rest..." */
function parseLogLine(line: string): { time: string; level: 'error' | 'warn' | 'info'; text: string } {
  let time = ''
  let text = line
  const tsMatch = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]\s*/)
  if (tsMatch) {
    time = new Date(tsMatch[1]).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    text = line.slice(tsMatch[0].length)
  }
  const level = /\[ERROR\]|error/i.test(text) ? 'error' : /\[WARN\]|warn|⚠/.test(text) ? 'warn' : 'info'
  return { time, level, text }
}

const levelColors = { error: 'var(--red)', warn: 'var(--yellow, #f0ad4e)', info: '' }

export function LogViewer({ logs, source }: { logs: Array<{ source: string; line: string; ts: string }>; source: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)
  const filtered = logs.filter(l => l.source === source || l.source === 'hub')

  useEffect(() => {
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
      {filtered.map((l, i) => {
        const { time, level, text } = parseLogLine(l.line)
        const lc = levelColors[level]
        return (
          <div
            key={i}
            style={{
              padding: '1px 16px',
              borderLeft: `2px solid ${lc || sourceColors[l.source] || 'var(--border)'}`,
              marginLeft: 8,
              background: level === 'error' ? 'rgba(239,68,68,0.05)' : '',
              ...(i >= prevCountRef.current - 1 ? { animation: 'fade-in 0.2s ease' } : {}),
            }}
            onMouseEnter={e => { if (!lc) e.currentTarget.style.background = 'var(--bg-card)' }}
            onMouseLeave={e => { if (!lc) e.currentTarget.style.background = '' }}
          >
            {time && <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{time}</span>}
            <span style={{ color: sourceColors[l.source] || 'var(--text-dim)', fontWeight: 500, marginRight: 8 }}>
              {l.source}
            </span>
            <span style={{ color: lc || 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' as const }}>
              {text}
            </span>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
