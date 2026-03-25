import React, { useState, useEffect } from 'react'
import type { AgentStatus } from '../hooks/useWebSocket'

const statusConfig: Record<string, { color: string; label: string }> = {
  connected: { color: 'var(--green)', label: 'online' },
  starting: { color: 'var(--amber)', label: 'starting' },
  stopped: { color: 'var(--text-muted)', label: 'offline' },
}

function timeSince(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60}m`
}

function AgentCard({ agent, active, onClick }: { agent: AgentStatus; active: boolean; onClick: () => void }) {
  const cfg = statusConfig[agent.status] || statusConfig.stopped
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(v => v + 1), 5000); return () => clearInterval(t) }, [])

  return (
    <div
      onClick={onClick}
      style={{
        padding: '12px 14px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? 'var(--bg-card-active)' : 'transparent',
        border: `1px solid ${active ? 'var(--border-bright)' : 'transparent'}`,
        transition: 'all 0.15s ease',
        animation: 'fade-in 0.3s ease',
      }}
      onMouseEnter={e => { if (!active) { e.currentTarget.style.background = 'var(--bg-card-hover)'; e.currentTarget.style.borderColor = 'var(--border)' } }}
      onMouseLeave={e => { if (!active) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent' } }}
    >
      {/* Row 1: name + uptime */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: cfg.color,
            boxShadow: agent.status === 'connected' ? `0 0 8px ${cfg.color}` : 'none',
          }} />
          <span style={{ fontSize: 13, fontWeight: 600, fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}>
            {agent.name}
          </span>
        </div>
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {agent.status === 'connected' && agent.onlineSince ? timeSince(agent.onlineSince) : cfg.label}
        </span>
      </div>

      {/* Row 2: cwd */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        <span style={{ color: 'var(--text-dim)' }}>cwd</span> {agent.cwd.replace(/^\/Users\/\w+/, '~')}
      </div>

      {/* Row 3: channel */}
      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        <span style={{ color: 'var(--text-dim)' }}>channel</span> WeChat ClawBot
      </div>
    </div>
  )
}

export function AgentList({ agents, selected, onSelect }: {
  agents: AgentStatus[]
  selected: string | null
  onSelect: (name: string) => void
}) {
  return (
    <div style={{
      width: 260, borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '16px 16px 8px',
        fontSize: 9, color: 'var(--text-dim)',
        textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600,
      }}>
        Agents
        <span style={{ float: 'right', color: 'var(--text-muted)', fontWeight: 400 }}>{agents.length}</span>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 8px' }}>
        {agents.map((a, i) => (
          <AgentCard
            key={a.name}
            agent={a}
            active={selected === a.name}
            onClick={() => onSelect(a.name)}
          />
        ))}
      </div>
    </div>
  )
}
