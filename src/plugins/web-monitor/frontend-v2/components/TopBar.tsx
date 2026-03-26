import React, { useMemo, useState, useEffect } from 'react'
import type { TokenStats } from '../hooks/useTokens'
import type { UsageStats } from '../hooks/useUsage'

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text)', letterSpacing: '-0.02em' }}>{value}</span>
        {sub && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
    </div>
  )
}

function UsageBar({ label, utilization, resetsAt }: {
  label: string
  utilization: number
  resetsAt?: string
}) {
  const pct = Math.round(utilization)
  const resetStr = resetsAt
    ? new Date(resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  const filled = Math.round(pct / 20)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled)
  const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow, #f0ad4e)' : 'var(--text-dim)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color, letterSpacing: '0.05em' }}>{bar}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{pct}%</span>
        {resetStr && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{'\u21bb'}{resetStr}</span>}
      </div>
    </div>
  )
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined || cost === null) return '\u2014'
  return '$' + cost.toFixed(2)
}

export function TopBar({ tokenStats, usageStats, hubConnected }: {
  tokenStats: TokenStats
  usageStats?: UsageStats
  hubConnected: boolean
}) {
  const today = new Date().toISOString().split('T')[0]
  const [uptime, setUptime] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setUptime(u => u + 1), 1000)
    return () => clearInterval(t)
  }, [])

  const todayTokens = useMemo(() => {
    const d = tokenStats.daily?.find(d => d.date === today)
    if (!d) return null
    const totalInput = d.input + d.cacheRead + d.cacheCreate
    return { input: totalInput, output: d.output, total: totalInput + d.output, cacheHit: d.cacheRead }
  }, [tokenStats, today])

  const tpd = useMemo(() => {
    const last30 = (tokenStats.daily || []).slice(-30)
    if (last30.length === 0) return null
    return last30.reduce((s, d) => s + d.input + d.output + d.cacheRead + d.cacheCreate, 0) / last30.length
  }, [tokenStats])

  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 28,
      padding: '14px 24px',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
    }}>
      {/* Logo + status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 8 }}>
        <div style={{
          width: 10, height: 10, borderRadius: '50%',
          background: hubConnected ? 'var(--green)' : 'var(--red)',
          animation: hubConnected ? 'pulse-green 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{
          fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800,
          color: 'var(--accent)', letterSpacing: '-0.03em',
        }}>
          cc2im
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 300 }}>{uptimeStr}</span>
      </div>

      <div style={{ width: 1, height: 28, background: 'var(--border)' }} />

      <Metric label="Context In" value={todayTokens ? formatNum(todayTokens.input) : '—'} sub={todayTokens ? `cache ${formatNum(todayTokens.cacheHit)}` : undefined} />
      <Metric label="Generated" value={todayTokens ? formatNum(todayTokens.output) : '—'} />
      <Metric label="Today" value={todayTokens ? formatNum(todayTokens.total) : '—'} />

      <div style={{ flex: 1 }} />

      {/* Cost + TPD compact block */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, fontFamily: 'var(--font-mono)' }}>
        <span style={{ color: 'var(--text-dim)' }}>
          {'\u2248'} <span style={{ color: 'var(--text)', fontWeight: 600 }}>{formatCost(tokenStats.todayCost)}</span> today
          {' / '}
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{formatCost(tokenStats.avgDailyCost)}</span> avg
        </span>
        <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          TPD {tpd ? formatNum(Math.round(tpd)) : '—'}
        </span>
      </div>

      <div style={{ width: 1, height: 28, background: 'var(--border)' }} />

      {/* Usage limits */}
      {usageStats?.fiveHour && (
        <UsageBar label="5h Limit" utilization={usageStats.fiveHour.utilization} resetsAt={usageStats.fiveHour.resetsAt} />
      )}
      {usageStats?.sevenDay && (
        <UsageBar label="7d Limit" utilization={usageStats.sevenDay.utilization} resetsAt={usageStats.sevenDay.resetsAt} />
      )}
    </div>
  )
}
