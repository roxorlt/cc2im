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
        const snap = msg as Snapshot
        setAgents(snap.agents)
        setHubConnected(snap.hubConnected)
        setMessages(snap.recentMessages || [])
        return
      }

      if (msg.type === 'hub_event') {
        const ev = msg.event as HubEventData

        if (ev.kind === 'agent_online') {
          setAgents(prev => prev.map(a =>
            a.name === ev.agentId ? { ...a, status: 'connected', onlineSince: ev.timestamp } : a
          ))
        } else if (ev.kind === 'agent_offline') {
          setAgents(prev => prev.map(a =>
            a.name === ev.agentId ? { ...a, status: 'stopped', onlineSince: undefined } : a
          ))
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
