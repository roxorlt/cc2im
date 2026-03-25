import React from 'react'
import type { AgentStatus } from '../hooks/useWebSocket'

const css: Record<string, React.CSSProperties> = {
  list: { width: 220, borderRight: '1px solid #30363d', padding: 8, overflowY: 'auto' },
  card: { padding: '10px 12px', borderRadius: 6, cursor: 'pointer', marginBottom: 4, transition: 'background 0.15s' },
  cardActive: { background: '#1f2937' },
  cardHover: { background: '#161b22' },
  name: { fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  meta: { fontSize: 11, color: '#8b949e', marginTop: 2 },
  star: { color: '#e3b341', fontSize: 12 },
}

const statusColor: Record<string, string> = {
  connected: '#3fb950',
  starting: '#d29922',
  stopped: '#484f58',
}

function timeSince(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

export function AgentList({ agents, selected, onSelect }: {
  agents: AgentStatus[]
  selected: string | null
  onSelect: (name: string) => void
}) {
  return (
    <div style={css.list}>
      <div style={{ padding: '8px 12px', fontSize: 11, color: '#8b949e', textTransform: 'uppercase' as const, letterSpacing: 1 }}>Agents</div>
      {agents.map(a => (
        <div
          key={a.name}
          style={{ ...css.card, ...(selected === a.name ? css.cardActive : {}) }}
          onClick={() => onSelect(a.name)}
          onMouseEnter={e => { if (selected !== a.name) (e.currentTarget as HTMLDivElement).style.background = '#161b22' }}
          onMouseLeave={e => { if (selected !== a.name) (e.currentTarget as HTMLDivElement).style.background = '' }}
        >
          <div style={css.name}>
            <span style={{ ...css.dot, background: statusColor[a.status] || '#484f58' }} />
            {a.name}
            {a.isDefault && <span style={css.star}>★</span>}
          </div>
          <div style={css.meta}>
            {a.status === 'connected' && a.onlineSince ? timeSince(a.onlineSince) : a.status}
            {' · '}{a.cwd.replace(/^\/Users\/\w+/, '~')}
          </div>
          <div style={{ fontSize: 10, color: '#6e7681', marginTop: 1 }}>
            📱 WeChat ClawBot
          </div>
        </div>
      ))}
      {agents.length === 0 && <div style={{ ...css.meta, padding: 12 }}>No agents configured</div>}
    </div>
  )
}
