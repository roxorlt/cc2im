import React, { useEffect, useRef } from 'react'

const css: Record<string, React.CSSProperties> = {
  container: { flex: 1, overflowY: 'auto', padding: 8, fontFamily: 'SF Mono, Menlo, Monaco, monospace', fontSize: 12, lineHeight: 1.6, background: '#0d1117' },
  line: { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, padding: '1px 8px', borderBottom: '1px solid #21262d' },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58', fontFamily: 'inherit' },
}

export function LogViewer({ logs, source }: { logs: Array<{ source: string; line: string; ts: string }>; source: string }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const filtered = logs.filter(l => l.source === source || l.source === 'hub')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [filtered.length])

  if (filtered.length === 0) {
    return <div style={css.empty}>等待日志...</div>
  }

  return (
    <div style={css.container}>
      {filtered.map((l, i) => (
        <div key={i} style={css.line}>
          <span style={{ color: '#8b949e' }}>{l.source} </span>
          {l.line}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
