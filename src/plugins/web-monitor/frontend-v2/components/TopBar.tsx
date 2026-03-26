import React, { useMemo, useState, useEffect } from 'react'
import type { TokenStats } from '../hooks/useTokens'
import type { UsageStats } from '../hooks/useUsage'

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined || cost === null) return '\u2014'
  return '$' + cost.toFixed(2)
}

/*
 * Responsive priority levels — hide from lowest to highest as viewport narrows.
 * Each level gets its own breakpoint so items disappear ONE AT A TIME.
 *
 *   Wide (all visible):
 *     cc2im | Context In cache281M | Generated 317K | Today 149M $126 | TPD 124M $108/d | ▏ CURRENT 2% / WEEK 14%
 *
 *   P1 <1280px — hide sub-text (cache, cost amounts):
 *     cc2im | Context In           | Generated 317K | Today 149M      | TPD 124M        | ▏ CURRENT 2% / WEEK 14%
 *
 *   P2 <1100px — hide Generated:
 *     cc2im | Context In           |                | Today 149M      | TPD 124M        | ▏ CURRENT 2% / WEEK 14%
 *
 *   P3 <950px — hide TPD:
 *     cc2im | Context In           |                | Today 149M      |                 | ▏ CURRENT 2% / WEEK 14%
 *
 *   P4 <800px — hide usage reset times:
 *     cc2im | Context In           |                | Today 149M      |                 | ▏ CURRENT 2% / WEEK 14%
 */
const responsiveStyle = `
  @media (max-width: 1280px) { .topbar-p1 { display: none !important; } }
  @media (max-width: 1100px) { .topbar-p2 { display: none !important; } }
  @media (max-width: 950px)  { .topbar-p3 { display: none !important; } }
  @media (max-width: 800px)  { .topbar-p4 { display: none !important; } }
`

function Metric({ label, value, sub, hide }: {
  label: string; value: string; sub?: string; hide?: string
}) {
  return (
    <div className={hide} style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text)', letterSpacing: '-0.02em' }}>{value}</span>
        {sub && <span className="topbar-p1" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
    </div>
  )
}

function UsageRow({ label, utilization, resetsAt }: {
  label: string; utilization: number; resetsAt?: string
}) {
  const pct = Math.round(utilization)
  const filled = Math.round(pct / 20)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled)
  const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow, #f0ad4e)' : 'var(--text-dim)'

  let resetStr = ''
  if (resetsAt) {
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (diffMs > 0) {
      const hrs = Math.round(diffMs / 3_600_000)
      resetStr = hrs >= 24 ? `${Math.round(hrs / 24)}d` : `${hrs}h`
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontFamily: 'var(--font-mono)' }}>
      <span style={{ color: 'var(--text-muted)', width: 52, fontSize: 9, letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ color, letterSpacing: '0.03em' }}>{bar}</span>
      <span style={{ color, fontWeight: 600, minWidth: 28, textAlign: 'right' }}>{pct}%</span>
      {resetStr && <span className="topbar-p4" style={{ color: 'var(--text-muted)', fontSize: 9 }}>in {resetStr}</span>}
    </div>
  )
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
      display: 'flex', alignItems: 'center', gap: 20,
      padding: '14px 20px',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border)',
      flexWrap: 'nowrap',
      overflow: 'hidden',
    }}>
      <style dangerouslySetInnerHTML={{ __html: responsiveStyle }} />

      {/* Logo */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 10, height: 10, minWidth: 10, borderRadius: '50%',
          background: hubConnected ? 'var(--green)' : 'var(--red)',
          animation: hubConnected ? 'pulse-green 2s ease-in-out infinite' : 'none',
        }} />
        <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 800, color: 'var(--accent)', letterSpacing: '-0.03em' }}>cc2im</span>
        <span className="topbar-p1" style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 300 }}>{uptimeStr}</span>
      </div>

      <div style={{ flexShrink: 0, width: 1, height: 28, background: 'var(--border)' }} />

      {/* Token metrics */}
      <Metric label="Context In" value={todayTokens ? formatNum(todayTokens.input) : '—'} sub={todayTokens ? `cache ${formatNum(todayTokens.cacheHit)}` : undefined} />
      <Metric label="Generated" value={todayTokens ? formatNum(todayTokens.output) : '—'} hide="topbar-p2" />
      <Metric label="Today" value={todayTokens ? formatNum(todayTokens.total) : '—'} sub={formatCost(tokenStats.todayCost)} />
      <Metric label="TPD (30d)" value={tpd ? formatNum(Math.round(tpd)) : '—'} sub={formatCost(tokenStats.avgDailyCost) + '/d'} hide="topbar-p3" />

      {/* Usage — pushed right */}
      {(usageStats?.fiveHour || usageStats?.sevenDay) && <>
        <div style={{ flexShrink: 0, width: 1, height: 28, background: 'var(--border)', marginLeft: 'auto' }} />
        <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {usageStats.fiveHour && <UsageRow label="CURRENT" utilization={usageStats.fiveHour.utilization} resetsAt={usageStats.fiveHour.resetsAt} />}
          {usageStats.sevenDay && <UsageRow label="WEEK" utilization={usageStats.sevenDay.utilization} resetsAt={usageStats.sevenDay.resetsAt} />}
        </div>
      </>}
    </div>
  )
}
