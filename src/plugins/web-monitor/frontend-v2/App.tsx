import React, { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useTokens } from './hooks/useTokens'
import { useUsage } from './hooks/useUsage'
import { TopBar } from './components/TopBar'
import { AgentList } from './components/AgentList'
import { MessageFlow } from './components/MessageFlow'
import { LogViewer } from './components/LogViewer'

const tabs = [
  { id: 'messages' as const, label: '消息流' },
  { id: 'logs' as const, label: '日志' },
]

function UsagePill({ utilization, resetsAt }: { utilization: number; resetsAt?: string }) {
  const pct = Math.round(utilization)
  const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow, #f0ad4e)' : 'var(--text-dim)'
  let resetStr = ''
  if (resetsAt) {
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (diffMs > 0) {
      const hrs = Math.round(diffMs / 3_600_000)
      resetStr = hrs >= 24 ? ` ${Math.round(hrs / 24)}d` : ` ${hrs}h`
    }
  }
  return <span style={{ color, fontWeight: 600 }}>{pct}%<span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{resetStr}</span></span>
}

export function App() {
  const { agents, hubConnected, wsConnected, messages, logs } = useWebSocket()
  const tokenStats = useTokens()
  const usageStats = useUsage()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'messages' | 'logs'>('messages')

  const activeAgent = selected || agents[0]?.name || null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
      <TopBar tokenStats={tokenStats} hubConnected={hubConnected} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <AgentList agents={agents} selected={activeAgent} onSelect={setSelected} />

        {activeAgent ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
            {/* Tab bar */}
            <div style={{
              display: 'flex', gap: 0,
              borderBottom: '1px solid var(--border)',
              background: 'var(--bg-panel)',
            }}>
              {tabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    padding: '10px 20px',
                    fontSize: 12, fontWeight: 500,
                    fontFamily: 'var(--font-mono)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: tab === t.id ? 'var(--accent)' : 'var(--text-dim)',
                    borderBottom: `2px solid ${tab === t.id ? 'var(--accent)' : 'transparent'}`,
                    transition: 'all 0.15s ease',
                  }}
                >
                  {t.label}
                </button>
              ))}

              {/* Active agent indicator */}
              <div style={{
                marginLeft: 'auto', padding: '10px 16px',
                fontSize: 10, color: 'var(--text-muted)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: 'var(--text-dim)' }}>viewing</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{activeAgent}</span>
              </div>
            </div>

            {tab === 'messages'
              ? <MessageFlow messages={messages} agentId={activeAgent} />
              : <LogViewer logs={logs} source={activeAgent} />
            }
          </div>
        ) : (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 36, color: 'var(--text-muted)', opacity: 0.2 }}>⬡</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>选择 Agent</span>
          </div>
        )}
      </div>

      {/* Footer: version + usage + ws status */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '4px 16px',
        fontSize: 9, color: 'var(--text-muted)',
        background: 'var(--bg-panel)',
        borderTop: '1px solid var(--border)',
        fontFamily: 'var(--font-mono)',
      }}>
        <span>cc2im v0.1.0</span>
        {usageStats?.fiveHour && (
          <span>CURRENT <UsagePill utilization={usageStats.fiveHour.utilization} resetsAt={usageStats.fiveHour.resetsAt} /></span>
        )}
        {usageStats?.sevenDay && (
          <span>WEEK <UsagePill utilization={usageStats.sevenDay.utilization} resetsAt={usageStats.sevenDay.resetsAt} /></span>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <span style={{
            display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
            background: wsConnected ? 'var(--green)' : 'var(--red)',
            marginRight: 4, verticalAlign: 'middle',
          }} />
          {wsConnected ? 'ws connected' : 'ws reconnecting'}
        </span>
      </div>
    </div>
  )
}
