import React from 'react'
import type { StatsData } from '../hooks/useStats'

const css: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: 24, padding: '12px 20px', background: '#161b22', borderBottom: '1px solid #30363d', alignItems: 'center', flexWrap: 'wrap' },
  title: { fontSize: 16, fontWeight: 700, color: '#58a6ff', marginRight: 16 },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 },
  label: { fontSize: 10, color: '#8b949e', textTransform: 'uppercase' as const, letterSpacing: 1 },
  value: { fontSize: 18, fontWeight: 600, color: '#e1e4e8' },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
}

export function TopBar({ stats, hubConnected }: { stats: StatsData; hubConnected: boolean }) {
  const today = new Date().toISOString().split('T')[0]
  const todayActivity = stats.dailyActivity?.find(d => d.date === today)

  return (
    <div style={css.bar}>
      <span style={css.title}>
        <span style={{ ...css.dot, background: hubConnected ? '#3fb950' : '#f85149' }} />
        cc2im
      </span>

      <div style={css.stat}>
        <span style={css.label}>Today Msgs</span>
        <span style={css.value}>{todayActivity?.messageCount ?? '-'}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Tool Calls</span>
        <span style={css.value}>{todayActivity?.toolCallCount ?? '-'}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Sessions</span>
        <span style={css.value}>{todayActivity?.sessionCount ?? '-'}</span>
      </div>
    </div>
  )
}
