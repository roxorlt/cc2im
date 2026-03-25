import React, { useState } from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { useTokens } from './hooks/useTokens'
import { TopBar } from './components/TopBar'
import { AgentList } from './components/AgentList'
import { MessageFlow } from './components/MessageFlow'
import { LogViewer } from './components/LogViewer'

const css: Record<string, React.CSSProperties> = {
  app: { height: '100vh', display: 'flex', flexDirection: 'column' },
  main: { flex: 1, display: 'flex', overflow: 'hidden' },
  detail: { flex: 1, display: 'flex', flexDirection: 'column' },
  tabs: { display: 'flex', borderBottom: '1px solid #30363d', background: '#161b22' },
  tab: { padding: '8px 16px', fontSize: 13, cursor: 'pointer', borderBottom: '2px solid transparent', color: '#8b949e' },
  tabActive: { color: '#e1e4e8', borderBottomColor: '#58a6ff' },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#484f58', fontSize: 14 },
  wsStatus: { position: 'fixed' as const, bottom: 8, right: 12, fontSize: 10, color: '#484f58' },
}

export function App() {
  const { agents, hubConnected, wsConnected, messages, logs } = useWebSocket()
  const tokenStats = useTokens()
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'messages' | 'logs'>('messages')

  // Auto-select first agent
  const activeAgent = selected || agents[0]?.name || null

  return (
    <div style={css.app}>
      <TopBar tokenStats={tokenStats} hubConnected={hubConnected} />
      <div style={css.main}>
        <AgentList agents={agents} selected={activeAgent} onSelect={setSelected} />
        {activeAgent ? (
          <div style={css.detail}>
            <div style={css.tabs}>
              <div
                style={{ ...css.tab, ...(tab === 'messages' ? css.tabActive : {}) }}
                onClick={() => setTab('messages')}
              >
                消息流
              </div>
              <div
                style={{ ...css.tab, ...(tab === 'logs' ? css.tabActive : {}) }}
                onClick={() => setTab('logs')}
              >
                日志
              </div>
            </div>
            {tab === 'messages'
              ? <MessageFlow messages={messages} agentId={activeAgent} />
              : <LogViewer logs={logs} source={activeAgent} />
            }
          </div>
        ) : (
          <div style={css.empty}>选择一个 Agent 查看详情</div>
        )}
      </div>
      <div style={css.wsStatus}>
        {wsConnected ? '● connected' : '○ reconnecting...'}
      </div>
    </div>
  )
}
