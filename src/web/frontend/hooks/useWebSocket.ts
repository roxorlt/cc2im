import { useState, useEffect, useRef, useCallback } from 'react'

export interface AgentStatus {
  name: string
  status: 'connected' | 'starting' | 'stopped'
  cwd: string
  autoStart: boolean
  isDefault: boolean
  onlineSince?: string
}

export interface HubEventData {
  kind: string
  agentId: string
  timestamp: string
  userId?: string
  text?: string
  toolName?: string
  behavior?: string
  code?: number
}

export interface MessageEntry {
  event: HubEventData
  receivedAt: string
}

interface Snapshot {
  agents: AgentStatus[]
  hubConnected: boolean
  recentMessages: MessageEntry[]
}

export function useWebSocket() {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [hubConnected, setHubConnected] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const [logs, setLogs] = useState<Array<{ source: string; line: string; ts: string }>>([])
  const wsRef = useRef<WebSocket | null>(null)

  const connect = useCallback(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => setWsConnected(true)
    ws.onclose = () => {
      setWsConnected(false)
      setTimeout(connect, 3000)
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)

      if (msg.type === 'snapshot') {
        const snap = msg as any
        setAgents(snap.agents)
        setHubConnected(snap.hubConnected)
        setMessages(snap.recentMessages || [])
        if (snap.recentLogs) {
          setLogs(snap.recentLogs.map((l: any) => ({ ...l, ts: new Date().toISOString() })))
        }
        return
      }

      if (msg.type === 'hub_event') {
        const ev = msg.event as HubEventData

        // Re-fetch agent list on any state change (covers register, deregister,
        // start, stop, restart, online, offline, config_changed)
        if (['agent_online', 'agent_offline', 'agent_started', 'agent_stopped', 'config_changed'].includes(ev.kind)) {
          fetch('/api/agents').then(r => r.json()).then(config => {
            const connected = new Set<string>()
            // Keep track of which agents we know are online from events
            setAgents(prev => {
              prev.forEach(a => { if (a.status === 'connected') connected.add(a.name) })
              return Object.entries(config.agents || {}).map(([name, agent]: [string, any]) => {
                const wasConnected = connected.has(name)
                const isOnline = ev.kind === 'agent_online' && ev.agentId === name ? true
                  : ev.kind === 'agent_offline' && ev.agentId === name ? false
                  : wasConnected
                return {
                  name,
                  status: isOnline ? 'connected' as const : 'stopped' as const,
                  cwd: agent.cwd,
                  autoStart: agent.autoStart ?? false,
                  isDefault: config.defaultAgent === name,
                  onlineSince: isOnline ? (prev.find(p => p.name === name)?.onlineSince || ev.timestamp) : undefined,
                }
              })
            })
          }).catch(() => {})
        }

        if (['message_in', 'message_out', 'permission_request', 'permission_verdict'].includes(ev.kind)) {
          setMessages(prev => [...prev.slice(-199), { event: ev, receivedAt: new Date().toISOString() }])
        }
      }

      if (msg.type === 'log') {
        setLogs(prev => [...prev.slice(-499), { source: msg.source, line: msg.line, ts: new Date().toISOString() }])
      }
    }
  }, [])

  useEffect(() => {
    connect()
    return () => wsRef.current?.close()
  }, [connect])

  return { agents, hubConnected, wsConnected, messages, logs }
}
