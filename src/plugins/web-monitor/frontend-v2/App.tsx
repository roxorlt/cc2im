import React, { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useTokens } from './hooks/useTokens'
import { useUsage } from './hooks/useUsage'
import { TopBar } from './components/TopBar'
import { Sidebar } from './components/Sidebar'
import { MessageFlow } from './components/MessageFlow'
import { LogViewer } from './components/LogViewer'

type Page = 'chat' | 'channels'

const tabs = [
  { id: 'messages' as const, label: '消息流' },
  { id: 'logs' as const, label: '日志' },
]

function UsageBar({ label, utilization, resetsAt }: { label: string; utilization: number; resetsAt?: string }) {
  const pct = Math.round(utilization)
  const filled = Math.round(pct / 20)
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(5 - filled)
  const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow, #f0ad4e)' : 'var(--text-dim)'
  let resetStr = ''
  if (resetsAt) {
    const diffMs = new Date(resetsAt).getTime() - Date.now()
    if (diffMs > 0) {
      const totalMin = Math.floor(diffMs / 60_000)
      const d = Math.floor(totalMin / 1440)
      const h = Math.floor((totalMin % 1440) / 60)
      const m = totalMin % 60
      resetStr = d > 0 ? `${d}d ${String(h).padStart(2, '0')}h` : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    }
  }
  return (
    <span>
      {label}{' '}
      <span style={{ color, letterSpacing: '0.03em' }}>{bar}</span>{' '}
      <span style={{ color, fontWeight: 700 }}>{pct}%</span>{' '}
      <span style={{ color: 'var(--text-dim)' }}>{resetStr}</span>
    </span>
  )
}

export function App() {
  const { agents, hubConnected, wsConnected, messages, logs, channels, nicknames, setNicknames } = useWebSocket()
  const tokenStats = useTokens()
  const usageStats = useUsage()

  const [page, setPage] = useState<Page>('chat')
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'messages' | 'logs'>('messages')
  const [showAddChannel, setShowAddChannel] = useState(false)

  const activeAgent = selected || agents[0]?.name || null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
      <TopBar tokenStats={tokenStats} hubConnected={hubConnected} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar
          page={page} onPageChange={setPage}
          agents={agents} selectedAgent={activeAgent} onSelectAgent={setSelected}
          channels={channels}
          onAddChannel={() => { setPage('channels'); setShowAddChannel(true) }}
        />

        {page === 'chat' ? (
          activeAgent ? (
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
          )
        ) : (
          /* Channels page placeholder — will be replaced by ChannelsPage in Task 8 */
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 12,
          }}>
            <span style={{ fontSize: 36, color: 'var(--text-muted)', opacity: 0.2 }}>📡</span>
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Channels 管理页（Task 8 实现）</span>
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
        {(usageStats?.fiveHour || usageStats?.sevenDay) && <>
          <span style={{ width: 1, height: 10, background: 'var(--border)', flexShrink: 0 }} />
          <span style={{ letterSpacing: '0.08em', color: 'var(--text-dim)' }}>USAGE</span>
          {usageStats?.fiveHour && <UsageBar label="CURRENT" utilization={usageStats.fiveHour.utilization} resetsAt={usageStats.fiveHour.resetsAt} />}
          {usageStats?.sevenDay && <UsageBar label="WEEK" utilization={usageStats.sevenDay.utilization} resetsAt={usageStats.sevenDay.resetsAt} />}
        </>}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          {channels.map(ch => (
            <span key={ch.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {ch.label}
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                background: ch.status === 'connected' ? 'var(--green)'
                  : ch.status === 'connecting' ? 'var(--yellow, #f0ad4e)'
                  : 'var(--red)',
              }} />
            </span>
          ))}
          <span>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: wsConnected ? 'var(--green)' : 'var(--red)',
              marginRight: 4, verticalAlign: 'middle',
            }} />
            {wsConnected ? 'ws connected' : 'ws reconnecting'}
          </span>
        </span>
      </div>
    </div>
  )
}
