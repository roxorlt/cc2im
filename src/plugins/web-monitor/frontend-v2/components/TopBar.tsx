import React, { useMemo, useState, useEffect } from 'react'
import type { TokenStats } from '../hooks/useTokens'

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

export function TopBar({ tokenStats, hubConnected }: { tokenStats: TokenStats; hubConnected: boolean }) {
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

      <Metric label="Tokens/Day (30d)" value={tpd ? Math.round(tpd).toLocaleString() : '—'} />
    </div>
  )
}
