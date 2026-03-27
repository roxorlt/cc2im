import React, { useState } from 'react'
import type { CronJobInfo, AgentStatus } from '../hooks/useWebSocket'

interface ScheduledTasksPageProps {
  cronJobs: CronJobInfo[]
  agents: AgentStatus[]
  showAddDialog: boolean
  onCloseAddDialog: () => void
  onRefreshJobs: () => void
}

const btnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)',
  fontFamily: 'var(--font-mono)',
}

const typeBadgeColors: Record<string, { bg: string; text: string }> = {
  cron:     { bg: 'rgba(224,166,67,0.12)', text: 'var(--accent)' },
  once:     { bg: 'rgba(16,185,129,0.10)', text: 'var(--green)' },
  interval: { bg: 'rgba(139,92,246,0.12)', text: '#a78bfa' },
}

const runStatusColors: Record<string, string> = {
  delivered: 'var(--green)',
  queued:    'var(--amber)',
  failed:   'var(--red)',
}

function formatTime(iso: string | null): string {
  if (!iso) return '--'
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}

function TaskCard({ job, onRefreshJobs }: { job: CronJobInfo; onRefreshJobs: () => void }) {
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const badge = typeBadgeColors[job.scheduleType] || typeBadgeColors.cron

  const handleToggle = async () => {
    setToggling(true)
    try {
      await fetch(`/api/cron-jobs/${encodeURIComponent(job.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !job.enabled }),
      })
      onRefreshJobs()
    } catch (err) {
      console.error('Toggle failed:', err)
    } finally {
      setToggling(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`/api/cron-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' })
      if (res.ok) onRefreshJobs()
    } catch (err) {
      console.error('Delete failed:', err)
    } finally {
      setDeleting(false)
    }
  }

  const recentRuns = (job.recentRuns || []).slice(0, 3)

  return (
    <div style={{
      padding: '16px 20px', borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
    }}>
      {/* Row 1: schedule type badge + name */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{
          fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 10,
          background: badge.bg, color: badge.text,
          letterSpacing: '0.05em',
        }}>
          {job.scheduleType}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{job.name}</span>
      </div>

      {/* Row 2: schedule info */}
      <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 8, fontFamily: 'var(--font-mono)' }}>
        {job.scheduleValue}
        <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>|</span>
        {job.timezone}
        <span style={{ color: 'var(--text-muted)', margin: '0 6px' }}>{'\u2192'}</span>
        {job.agentId}
      </div>

      {/* Row 3: status indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: job.enabled ? 'var(--green)' : 'var(--text-muted)',
        }} />
        <span style={{ fontSize: 11, color: job.enabled ? 'var(--green)' : 'var(--text-muted)' }}>
          {job.enabled
            ? `\u4e0b\u6b21: ${formatTime(job.nextRun)}`
            : '\u5df2\u6682\u505c'}
        </span>
      </div>

      {/* Row 4: recent runs */}
      {recentRuns.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Recent runs
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recentRuns.map(run => (
              <div key={run.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--text-dim)', fontFamily: 'var(--font-mono)' }}>
                <span>{formatTime(run.firedAt)}</span>
                <div style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: runStatusColors[run.status] || 'var(--text-muted)',
                }} />
                <span style={{ color: runStatusColors[run.status] || 'var(--text-muted)' }}>{run.status}</span>
                {run.detail && <span style={{ color: 'var(--text-muted)' }}>— {run.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Row 5: actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={handleToggle} disabled={toggling} style={btnStyle}>
          {toggling ? '...' : job.enabled ? '\u6682\u505c' : '\u542f\u7528'}
        </button>
        <button onClick={handleDelete} disabled={deleting} style={{ ...btnStyle, color: 'var(--red)' }}>
          {deleting ? '\u5220\u9664\u4e2d...' : '\u5220\u9664'}
        </button>
      </div>
    </div>
  )
}

function AddTaskDialog({ agents, onClose, onRefreshJobs }: {
  agents: AgentStatus[]
  onClose: () => void
  onRefreshJobs: () => void
}) {
  const [name, setName] = useState('')
  const [agentId, setAgentId] = useState(agents[0]?.name || '')
  const [scheduleType, setScheduleType] = useState<'cron' | 'once' | 'interval'>('cron')
  const [scheduleValue, setScheduleValue] = useState('')
  const [timezone, setTimezone] = useState('Asia/Shanghai')
  const [message, setMessage] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const placeholders: Record<string, string> = {
    cron: '0 9 * * *',
    once: '2026-04-01T09:00:00+08:00',
    interval: '3600000',
  }

  const handleCreate = async () => {
    if (!name.trim() || !agentId || !scheduleValue.trim() || !message.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/cron-jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          agentId,
          scheduleType,
          scheduleValue: scheduleValue.trim(),
          timezone: timezone.trim(),
          message: message.trim(),
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed')
        return
      }
      onRefreshJobs()
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '6px 10px', borderRadius: 4,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
    fontFamily: 'var(--font-mono)',
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          padding: '24px 28px', borderRadius: 10,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          width: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>{'\u65b0\u589e\u5b9a\u65f6\u4efb\u52a1'}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Task name */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u4efb\u52a1\u540d\u79f0'}</label>
            <input value={name} onChange={e => setName(e.target.value)}
              autoFocus placeholder={'\u5982\uff1a\u6bcf\u65e5\u64e8\u8981'}
              style={inputStyle}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />
          </div>

          {/* Target agent */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u76ee\u6807 Agent'}</label>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}
              style={{ ...inputStyle, cursor: 'pointer' }}>
              {agents.map(a => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Schedule type */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u8c03\u5ea6\u7c7b\u578b'}</label>
            <select value={scheduleType} onChange={e => setScheduleType(e.target.value as 'cron' | 'once' | 'interval')}
              style={{ ...inputStyle, cursor: 'pointer' }}>
              <option value="cron">cron</option>
              <option value="once">once</option>
              <option value="interval">interval</option>
            </select>
          </div>

          {/* Schedule value */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u8c03\u5ea6\u503c'}</label>
            <input value={scheduleValue} onChange={e => setScheduleValue(e.target.value)}
              placeholder={placeholders[scheduleType]}
              style={inputStyle}
            />
          </div>

          {/* Timezone */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u65f6\u533a'}</label>
            <input value={timezone} onChange={e => setTimezone(e.target.value)}
              style={inputStyle}
            />
          </div>

          {/* Message */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>{'\u6d88\u606f\u5185\u5bb9'}</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)}
              placeholder={'\u53d1\u9001\u7ed9 Agent \u7684\u6d88\u606f\u5185\u5bb9'}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} style={btnStyle}>{'\u53d6\u6d88'}</button>
            <button onClick={handleCreate}
              disabled={creating || !name.trim() || !agentId || !scheduleValue.trim() || !message.trim()}
              style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
              {creating ? '\u521b\u5efa\u4e2d...' : '\u521b\u5efa'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ScheduledTasksPage({ cronJobs, agents, showAddDialog, onCloseAddDialog, onRefreshJobs }: ScheduledTasksPageProps) {
  return (
    <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{'\u5b9a\u65f6\u4efb\u52a1'}</span>
      </div>

      {showAddDialog && (
        <AddTaskDialog agents={agents} onClose={onCloseAddDialog} onRefreshJobs={onRefreshJobs} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {cronJobs.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 12 }}>
            {'\u6682\u65e0\u5b9a\u65f6\u4efb\u52a1'}
          </div>
        ) : (
          cronJobs.map(job => <TaskCard key={job.id} job={job} onRefreshJobs={onRefreshJobs} />)
        )}
      </div>
    </div>
  )
}
