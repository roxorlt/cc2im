import React, { useMemo } from 'react'
import type { TokenStats } from '../hooks/useTokens'

const css: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: 20, padding: '12px 20px', background: '#161b22', borderBottom: '1px solid #30363d', alignItems: 'center', flexWrap: 'wrap' },
  title: { fontSize: 16, fontWeight: 700, color: '#58a6ff', marginRight: 12 },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 60 },
  label: { fontSize: 10, color: '#8b949e', textTransform: 'uppercase' as const, letterSpacing: 1 },
  value: { fontSize: 18, fontWeight: 600, color: '#e1e4e8' },
  subValue: { fontSize: 10, color: '#6e7681' },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
  divider: { width: 1, height: 32, background: '#30363d' },
}

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export function TopBar({ tokenStats, hubConnected }: { tokenStats: TokenStats; hubConnected: boolean }) {
  const today = new Date().toISOString().split('T')[0]

  const todayTokens = useMemo(() => {
    const d = tokenStats.daily?.find(d => d.date === today)
    if (!d) return null
    const totalInput = d.input + d.cacheRead + d.cacheCreate
    const totalOutput = d.output
    return {
      input: totalInput,
      output: totalOutput,
      total: totalInput + totalOutput,
      cacheHit: d.cacheRead,
    }
  }, [tokenStats, today])

  const tpd = useMemo(() => {
    const last30 = (tokenStats.daily || []).slice(-30)
    if (last30.length === 0) return null
    const avg = last30.reduce((s, d) => s + d.input + d.output + d.cacheRead + d.cacheCreate, 0) / last30.length
    return avg
  }, [tokenStats])

  return (
    <div style={css.bar}>
      <span style={css.title}>
        <span style={{ ...css.dot, background: hubConnected ? '#3fb950' : '#f85149' }} />
        cc2im
      </span>

      <div style={css.stat}>
        <span style={css.label}>Context In</span>
        <span style={css.value}>
          {todayTokens ? formatNum(todayTokens.input) : '-'}
          {todayTokens && <span style={{ ...css.subValue, marginLeft: 4 }}>(Cache {formatNum(todayTokens.cacheHit)})</span>}
        </span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Generated</span>
        <span style={css.value}>{todayTokens ? formatNum(todayTokens.output) : '-'}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Today Total</span>
        <span style={css.value}>{todayTokens ? formatNum(todayTokens.total) : '-'}</span>
      </div>

      <div style={css.divider} />

      <div style={css.stat}>
        <span style={css.label}>Tokens/Day (30d)</span>
        <span style={css.value}>{tpd ? Math.round(tpd).toLocaleString() : '-'}</span>
      </div>
    </div>
  )
}
