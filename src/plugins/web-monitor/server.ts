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
import { getTokenStats } from './token-stats.js'
import { readStats } from './stats-reader.js'
import { LogTailer } from './log-tailer.js'
import { SOCKET_DIR } from '../../shared/socket.js'
import type { HubEvent, HubEventData } from '../../shared/types.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

interface AgentStatus {
  name: string
  status: 'connected' | 'starting' | 'stopped'
  cwd: string
  autoStart: boolean
  isDefault: boolean
  onlineSince?: string
}

export async function startWeb(options: { port: number }) {
  const { port } = options
  const host = '127.0.0.1'

  // --- Track agent state from monitor events ---
  const agentState = new Map<string, { status: string; onlineSince?: string }>()
  const MAX_HISTORY = 200
  const HISTORY_PATH = join(SOCKET_DIR, 'web-messages.json')

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

  // --- HTTP Server ---
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`)

    // REST API
    if (url.pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      try {
        const config = existsSync(AGENTS_JSON_PATH)
          ? JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
          : { defaultAgent: '', agents: {} }
        res.end(JSON.stringify(config))
      } catch {
        res.end('{}')
      }
      return
    }

    if (url.pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(readStats() || {}))
      return
    }

    if (url.pathname === '/api/tokens') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getTokenStats()))
      return
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hubConnected: monitor.isConnected(),
        uptime: process.uptime(),
        wsClients: wsClients.size,
      }))
      return
    }

    if (url.pathname === '/api/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const agentId = url.searchParams.get('agent')
      const filtered = agentId
        ? messageHistory.filter(m => m.event.agentId === agentId)
        : messageHistory
      res.end(JSON.stringify(filtered))
      return
    }

    // Serve frontend static files
    const frontendDir = join(import.meta.dirname!, '..', '..', '..', 'dist', 'web-frontend')
    const srcFrontendDir = join(import.meta.dirname!, '..', '..', 'web', 'frontend')

    // Try built assets first, then source index.html as fallback
    let filePath = join(frontendDir, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!existsSync(filePath) && existsSync(join(srcFrontendDir, 'index.html'))) {
      // Dev mode: serve source index.html (use with Vite dev server proxy instead)
      filePath = join(srcFrontendDir, url.pathname === '/' ? 'index.html' : url.pathname)
    }
    if (!existsSync(filePath)) {
      // SPA fallback: serve index.html for all routes
      filePath = join(frontendDir, 'index.html')
    }
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end('Not found. Run `npx vite build` first.')
      return
    }

    const ext = filePath.split('.').pop() || ''
    const mimeTypes: Record<string, string> = {
      html: 'text/html', js: 'application/javascript', css: 'text/css',
      json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
    res.end(readFileSync(filePath))
  })

  // --- WebSocket Server ---
  const wsClients = new Set<WebSocket>()
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

  function broadcastWs(msg: any) {
    if (wsClients.size === 0) return
    const data = JSON.stringify(msg)
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data)
      }
    }
  }

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
    return {
      agents,
      hubConnected: monitor.isConnected(),
      recentMessages: messageHistory.slice(-50),
      recentLogs: logBuffer.slice(-100),
    }
  }

  // --- Start ---
  monitor.connect()

  httpServer.listen(port, host, () => {
    console.log(`[web] Dashboard: http://${host}:${port}`)
    console.log(`[web] WebSocket: ws://${host}:${port}/ws`)
    console.log(`[web] Hub: ${monitor.isConnected() ? 'connected' : 'connecting...'}`)
  })

  // Graceful shutdown
  const shutdown = () => {
    console.log('[web] Shutting down...')
    logTailer.stop()
    monitor.disconnect()
    wss.close()
    httpServer.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
