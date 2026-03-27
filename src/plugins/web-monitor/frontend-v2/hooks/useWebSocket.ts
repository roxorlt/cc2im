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
  kind: string  // includes 'channel_status'
  agentId: string
  timestamp: string
  userId?: string
  text?: string
  toolName?: string
  behavior?: string
  code?: number
  msgType?: string    // 'text' | 'image' | 'video' | 'file' | 'voice'
  mediaUrl?: string   // '/media/{filename}'
  channelId?: string
  channelType?: string
}

export interface ChannelInfo {
  id: string
  status: 'connected' | 'disconnected' | 'expired' | 'connecting'
  label: string
}

export interface MessageEntry {
  event: HubEventData
  receivedAt: string
}

interface Snapshot {
  agents: AgentStatus[]
  hubConnected: boolean
  recentMessages: MessageEntry[]
  recentLogs?: Array<{ source: string; line: string }>
  channels?: ChannelInfo[]
  nicknames?: Array<{ channelId: string; userId: string; nickname: string }>
}

export function useWebSocket() {
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [hubConnected, setHubConnected] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const [logs, setLogs] = useState<Array<{ source: string; line: string; ts: string }>>([])
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [nicknames, setNicknames] = useState<Map<string, string>>(new Map())
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
        const snap = msg as { type: string } & Snapshot
        setAgents(snap.agents)
        setHubConnected(snap.hubConnected)
        setMessages(snap.recentMessages || [])
        if (snap.recentLogs) {
          setLogs(snap.recentLogs.map((l) => ({ ...l, ts: new Date().toISOString() })))
        }
        if (snap.channels) {
          setChannels(snap.channels)
        }
        if (snap.nicknames) {
          const map = new Map<string, string>()
          for (const n of snap.nicknames) {
            map.set(`${n.channelId}:${n.userId}`, n.nickname)
          }
          setNicknames(map)
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

        if (ev.kind === 'channel_status') {
          // text format: "{label}: {status}" or "{label}: {status} — {detail}"
          const channelId = ev.agentId
          const text = ev.text || ''
          const colonIdx = text.indexOf(':')
          const label = colonIdx > 0 ? text.slice(0, colonIdx).trim() : channelId
          const afterColon = colonIdx > 0 ? text.slice(colonIdx + 1).trim() : ''
          // status is the first word after the colon (before optional " — detail")
          const statusWord = afterColon.split(/\s/)[0] as ChannelInfo['status']
          const validStatuses: ChannelInfo['status'][] = ['connected', 'disconnected', 'expired', 'connecting']
          const status = validStatuses.includes(statusWord) ? statusWord : 'disconnected'

          setChannels(prev => {
            const existing = prev.filter(c => c.id !== channelId)
            return [...existing, { id: channelId, status, label }]
          })
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

  return { agents, hubConnected, wsConnected, messages, logs, channels, nicknames, setNicknames }
}
