/**
 * cc2im Web — monitoring dashboard server
 *
 * Independent process: connects to hub.sock as monitor,
 * serves React frontend + WebSocket events to browser.
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { MonitorClient } from './monitor-client.js'
import { LogTailer } from './log-tailer.js'
import { SOCKET_DIR } from '../../shared/socket.js'
import type { HubEvent, HubEventData } from '../../shared/types.js'
import type { HubContext } from '../../shared/plugin.js'
import { getNicknames } from '../persistence/db.js'
import { listJobs, getRecentRuns } from '../cron-scheduler/db.js'
import { createApiHandler } from './api-routes.js'

// Re-export for test backward compat
export { createApiHandler, type ApiHandlerDeps } from './api-routes.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

interface AgentStatus {
  name: string
  status: 'connected' | 'starting' | 'stopped'
  cwd: string
  autoStart: boolean
  isDefault: boolean
  onlineSince?: string
}

export async function startWeb(options: { port: number; ctx?: HubContext }): Promise<{ shutdown: () => void }> {
  const { port, ctx } = options
  const host = '127.0.0.1'

  // --- Track agent state from monitor events ---
  const agentState = new Map<string, { status: string; onlineSince?: string }>()
  const MAX_HISTORY = 200
  const HISTORY_PATH = join(SOCKET_DIR, 'web-messages.json')

  const activeQrPolls = new Map<string, ReturnType<typeof setInterval>>()

  // Load persisted history on startup
  let messageHistory: Array<{ event: HubEventData; receivedAt: string }> = []
  try {
    if (existsSync(HISTORY_PATH)) {
      messageHistory = JSON.parse(readFileSync(HISTORY_PATH, 'utf8')).slice(-MAX_HISTORY)
    }
  } catch {}

  let historyDirty = false
  function pushHistory(event: HubEventData) {
    messageHistory.push({ event, receivedAt: new Date().toISOString() })
    if (messageHistory.length > MAX_HISTORY) messageHistory.shift()
    historyDirty = true
  }

  // Persist to disk every 5s if changed
  setInterval(() => {
    if (!historyDirty) return
    historyDirty = false
    try { writeFileSync(HISTORY_PATH, JSON.stringify(messageHistory)) } catch {}
  }, 5000)

  // --- Monitor Client ---
  const monitor = new MonitorClient((hubEvent: HubEvent) => {
    const ev = hubEvent.event

    // Update local agent state
    if (ev.kind === 'agent_online') {
      agentState.set(ev.agentId, { status: 'connected', onlineSince: ev.timestamp })
    } else if (ev.kind === 'agent_offline') {
      agentState.set(ev.agentId, { status: 'stopped' })
    }

    // Track message history
    if (['message_in', 'message_out', 'permission_request', 'permission_verdict'].includes(ev.kind)) {
      pushHistory(ev)
    }

    // Broadcast to all browser WebSocket clients
    broadcastWs({ type: 'hub_event', event: ev })
  })

  // --- Log Tailer ---
  const MAX_LOG_LINES = 200
  const logBuffer: Array<{ source: string; line: string }> = []

  let wsReady = false
  const logTailer = new LogTailer((source, line) => {
    logBuffer.push({ source, line })
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift()
    if (wsReady) broadcastWs({ type: 'log', source, line })
  })

  // Tail hub log
  const hubLogPath = join(SOCKET_DIR, 'hub.log')
  logTailer.tail('hub', hubLogPath)

  // Tail spoke logs for known agents
  function tailAgentLogs() {
    if (!existsSync(AGENTS_JSON_PATH)) return
    try {
      const config = JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
      for (const name of Object.keys(config.agents)) {
        const spokeLog = join(SOCKET_DIR, 'agents', name, 'spoke.log')
        logTailer.tail(name, spokeLog)
      }
    } catch {}
  }
  tailAgentLogs()

  // --- WebSocket (declared early so handler can reference wsClients) ---
  const wsClients = new Set<WebSocket>()

  function broadcastWs(msg: any) {
    if (wsClients.size === 0) return
    const data = JSON.stringify(msg)
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

  // --- HTTP Server ---
  const frontendDir = join(import.meta.dirname!, '..', '..', '..', 'dist', 'web-frontend')
  const handler = createApiHandler({
    agentsJsonPath: AGENTS_JSON_PATH,
    mediaDir: join(SOCKET_DIR, 'media'),
    messageHistory,
    monitor,
    wsClients,
    ctx,
    activeQrPolls,
    broadcastWs,
    frontendDir,
  })
  const httpServer = createServer(handler)
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wsReady = true

  wss.on('connection', (ws) => {
    wsClients.add(ws)
    console.log(`[web] Browser connected (${wsClients.size} clients)`)

    // Send snapshot on connect
    const snapshot = getSnapshot()
    ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }))

    ws.on('close', () => {
      wsClients.delete(ws)
      console.log(`[web] Browser disconnected (${wsClients.size} clients)`)
    })
  })

  function getSnapshot() {
    let agents: AgentStatus[] = []
    try {
      if (existsSync(AGENTS_JSON_PATH)) {
        const config = JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
        agents = Object.entries(config.agents).map(([name, agent]: [string, any]) => {
          const state = agentState.get(name)
          return {
            name,
            status: (state?.status || 'stopped') as AgentStatus['status'],
            cwd: agent.cwd,
            autoStart: agent.autoStart ?? false,
            isDefault: config.defaultAgent === name,
            onlineSince: state?.onlineSince,
          }
        })
      }
    } catch {}

    let channelList: Array<{ id: string; type: string; label: string; status: string }> = []
    if (ctx) {
      channelList = ctx.getChannels().map(ch => ({
        id: ch.id, type: ch.type, label: ch.label, status: ch.getStatus(),
      }))
    }

    let nicknameList: Array<{ channelId: string; userId: string; nickname: string }> = []
    try {
      nicknameList = getNicknames()
    } catch {}

    let cronJobList: any[] = []
    try {
      cronJobList = listJobs().map(j => ({ ...j, recentRuns: getRecentRuns(j.id, 5) }))
    } catch {}

    return {
      agents,
      hubConnected: monitor.isConnected(),
      recentMessages: messageHistory.slice(-50),
      recentLogs: logBuffer.slice(-100),
      channels: channelList,
      nicknames: nicknameList,
      cronJobs: cronJobList,
    }
  }

  // --- Start ---
  monitor.connect()

  httpServer.on('error', (err: any) => {
    console.error(`[web] HTTP server error: ${err.message}`)
  })
  wss.on('error', (err: any) => {
    console.error(`[web] WebSocket server error: ${err.message}`)
  })
  httpServer.listen(port, host, () => {
    console.log(`[web] Dashboard: http://${host}:${port}`)
    console.log(`[web] WebSocket: ws://${host}:${port}/ws`)
    console.log(`[web] Hub: ${monitor.isConnected() ? 'connected' : 'connecting...'}`)
  })

  // Return shutdown handle — caller manages when to invoke
  return {
    shutdown() {
      console.log('[web] Shutting down...')
      logTailer.stop()
      monitor.disconnect()
      wss.close()
      httpServer.close()
    },
  }
}
