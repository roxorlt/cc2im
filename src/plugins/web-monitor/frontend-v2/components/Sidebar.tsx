import React, { useState } from 'react'
import type { AgentStatus, ChannelInfo, CronJobInfo } from '../hooks/useWebSocket'

type Page = 'chat' | 'channels' | 'tasks'

interface SidebarProps {
  page: Page
  onPageChange: (page: Page) => void
  agents: AgentStatus[]
  selectedAgent: string | null
  onSelectAgent: (name: string) => void
  channels: ChannelInfo[]
  onAddChannel: () => void
  cronJobs: CronJobInfo[]
  onAddTask: () => void
}

export function Sidebar(props: SidebarProps) {
  const [chatExpanded, setChatExpanded] = useState(true)
  const [channelsExpanded, setChannelsExpanded] = useState(true)
  const [tasksExpanded, setTasksExpanded] = useState(true)

  const statusColor: Record<string, string> = {
    connected: 'var(--green)',
    starting: 'var(--amber)',
    stopped: 'var(--text-muted)',
    connecting: 'var(--amber)',
    disconnected: 'var(--text-muted)',
    expired: 'var(--red)',
  }

  return (
    <div style={{
      width: 220, borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Chat section */}
      <SectionHeader
        label="对话" count={props.agents.length}
        expanded={chatExpanded}
        onToggle={() => setChatExpanded(!chatExpanded)}
        onClick={() => props.onPageChange('chat')}
        active={props.page === 'chat'}
      />
      {chatExpanded && (
        <div style={{ padding: '0 8px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {props.agents.map(a => {
            const color = statusColor[a.status] || 'var(--text-muted)'
            const active = props.page === 'chat' && props.selectedAgent === a.name
            return (
              <SidebarItem
                key={a.name}
                label={a.name}
                dotColor={color}
                glow={a.status === 'connected'}
                active={active}
                onClick={() => { props.onPageChange('chat'); props.onSelectAgent(a.name) }}
              />
            )
          })}
        </div>
      )}

      {/* Channels section */}
      <SectionHeader
        label="Channels" count={props.channels.length}
        expanded={channelsExpanded}
        onToggle={() => setChannelsExpanded(!channelsExpanded)}
        onClick={() => props.onPageChange('channels')}
        active={props.page === 'channels'}
      />
      {channelsExpanded && (
        <div style={{ padding: '0 8px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {props.channels.map(ch => {
            const color = statusColor[ch.status] || 'var(--text-muted)'
            return (
              <SidebarItem
                key={ch.id}
                label={ch.label}
                dotColor={color}
                active={false}
                onClick={() => props.onPageChange('channels')}
              />
            )
          })}
          <div
            onClick={props.onAddChannel}
            style={{
              padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, color: 'var(--text-dim)', transition: 'color 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            + 新增频道
          </div>
        </div>
      )}

      {/* Tasks section */}
      <SectionHeader
        label="定时任务" count={props.cronJobs.length}
        expanded={tasksExpanded}
        onToggle={() => setTasksExpanded(!tasksExpanded)}
        onClick={() => props.onPageChange('tasks')}
        active={props.page === 'tasks'}
      />
      {tasksExpanded && (
        <div style={{ padding: '0 8px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {props.cronJobs.map(job => (
            <SidebarItem
              key={job.id}
              label={job.name}
              dotColor={job.enabled ? 'var(--green)' : 'var(--text-muted)'}
              active={false}
              onClick={() => props.onPageChange('tasks')}
            />
          ))}
          <div
            onClick={props.onAddTask}
            style={{
              padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, color: 'var(--text-dim)', transition: 'color 0.12s',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-dim)')}
          >
            + 新增任务
          </div>
        </div>
      )}

      <div style={{ flex: 1 }} />
    </div>
  )
}

function SectionHeader({ label, count, expanded, onToggle, onClick, active }: {
  label: string; count: number; expanded: boolean
  onToggle: () => void; onClick: () => void; active: boolean
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 14px 6px', cursor: 'pointer', userSelect: 'none',
      }}
      onClick={onClick}
    >
      <span
        onClick={e => { e.stopPropagation(); onToggle() }}
        style={{
          fontSize: 8, color: 'var(--text-dim)', transition: 'transform 0.15s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
          display: 'inline-block',
        }}
      >▶</span>
      <span style={{
        fontSize: 9, color: active ? 'var(--accent)' : 'var(--text-dim)',
        textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600, flex: 1,
      }}>{label}</span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{count}</span>
    </div>
  )
}

function SidebarItem({ label, dotColor, glow, active, onClick }: {
  label: string; dotColor: string; glow?: boolean; active: boolean; onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 8,
        background: active ? 'var(--bg-card-active)' : 'transparent',
        border: `1px solid ${active ? 'var(--border-bright)' : 'transparent'}`,
        transition: 'all 0.12s ease',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-card-hover)' }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = active ? 'var(--bg-card-active)' : 'transparent' }}
    >
      <div style={{
        width: 6, height: 6, borderRadius: '50%', background: dotColor, flexShrink: 0,
        boxShadow: glow ? `0 0 6px ${dotColor}` : 'none',
      }} />
      <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
    </div>
  )
}
