import React, { useMemo } from 'react'
import type { StatsData } from '../hooks/useStats'

const css: Record<string, React.CSSProperties> = {
  bar: { display: 'flex', gap: 24, padding: '12px 20px', background: '#161b22', borderBottom: '1px solid #30363d', alignItems: 'center', flexWrap: 'wrap' },
  title: { fontSize: 16, fontWeight: 700, color: '#58a6ff', marginRight: 16 },
  stat: { display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 80 },
  label: { fontSize: 10, color: '#8b949e', textTransform: 'uppercase' as const, letterSpacing: 1 },
  value: { fontSize: 18, fontWeight: 600, color: '#e1e4e8' },
  dot: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', marginRight: 6 },
  chart: { flex: 1, minWidth: 200, height: 40, display: 'flex', alignItems: 'end', gap: 1 },
  chartBar: { flex: 1, background: '#238636', borderRadius: '2px 2px 0 0', minWidth: 3 },
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

export function TopBar({ stats, hubConnected }: { stats: StatsData; hubConnected: boolean }) {
  const today = new Date().toISOString().split('T')[0]

  const todayActivity = stats.dailyActivity?.find(d => d.date === today)
  const todayMessages = todayActivity?.messageCount ?? 0

  const totalTokens = useMemo(() => {
    if (!stats.modelUsage) return { input: 0, output: 0 }
    let input = 0, output = 0
    for (const m of Object.values(stats.modelUsage)) {
      input += m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens
      output += m.outputTokens
    }
    return { input, output }
  }, [stats.modelUsage])

  // TPD chart — last 30 days
  const tpdData = useMemo(() => {
    if (!stats.dailyModelTokens) return []
    const last30 = stats.dailyModelTokens.slice(-30)
    return last30.map(d => {
      const total = Object.values(d.tokensByModel).reduce((a, b) => a + b, 0)
      return { date: d.date, tokens: total }
    })
  }, [stats.dailyModelTokens])

  const maxTpd = Math.max(...tpdData.map(d => d.tokens), 1)

  return (
    <div style={css.bar}>
      <span style={css.title}>
        <span style={{ ...css.dot, background: hubConnected ? '#3fb950' : '#f85149' }} />
        cc2im
      </span>

      <div style={css.stat}>
        <span style={css.label}>Today</span>
        <span style={css.value}>{todayMessages}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Input</span>
        <span style={css.value}>{formatNum(totalTokens.input)}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Output</span>
        <span style={css.value}>{formatNum(totalTokens.output)}</span>
      </div>

      <div style={css.stat}>
        <span style={css.label}>Total</span>
        <span style={css.value}>{formatNum(totalTokens.input + totalTokens.output)}</span>
      </div>

      <div style={css.chart} title="Tokens per day (30d)">
        {tpdData.map((d, i) => (
          <div
            key={i}
            style={{ ...css.chartBar, height: `${Math.max((d.tokens / maxTpd) * 100, 2)}%` }}
            title={`${d.date}: ${formatNum(d.tokens)}`}
          />
        ))}
      </div>
    </div>
  )
}
