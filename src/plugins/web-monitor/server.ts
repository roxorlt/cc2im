/**
 * cc2im Web — monitoring dashboard server
 *
 * Independent process: connects to hub.sock as monitor,
 * serves React frontend + WebSocket events to browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'
import { MonitorClient } from './monitor-client.js'
import { getTokenStats } from './token-stats.js'
import { getUsageStats } from './usage-stats.js'
import { readStats } from './stats-reader.js'
import { LogTailer } from './log-tailer.js'
import { SOCKET_DIR } from '../../shared/socket.js'
import type { HubEvent, HubEventData } from '../../shared/types.js'
import type { HubContext } from '../../shared/plugin.js'
import { getNicknames, setNickname } from '../persistence/db.js'
import { listJobs, createJob, deleteJob, updateJob, getRecentRuns } from '../cron-scheduler/db.js'
import { CronScheduler } from '../cron-scheduler/scheduler.js'
import { fetchQrCode, checkQrStatus, saveCredentials, POLL_INTERVAL, type QrStatus } from '../weixin/qr-login.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

interface AgentStatus {
  name: string
  status: 'connected' | 'starting' | 'stopped'
  cwd: string
  autoStart: boolean
  isDefault: boolean
  onlineSince?: string
}

// --- Dependencies injected into the API handler ---

export interface ApiHandlerDeps {
  agentsJsonPath: string
  mediaDir: string
  messageHistory: Array<{ event: HubEventData; receivedAt: string }>
  monitor: { isConnected(): boolean }
  wsClients: { size: number }
  ctx?: HubContext
  activeQrPolls: Map<string, ReturnType<typeof setInterval>>
  broadcastWs: (msg: any) => void
  frontendDir?: string
}

/**
 * Create the HTTP request handler used by the web dashboard.
 * Extracted so integration tests can exercise the real routing logic
 * with mock dependencies (no SQLite, no hub socket, no filesystem).
 */
export function createApiHandler(deps: ApiHandlerDeps) {
  const {
    agentsJsonPath, mediaDir, messageHistory, monitor,
    wsClients, ctx, activeQrPolls, broadcastWs, frontendDir,
  } = deps

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost')

    // REST API
    if (url.pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      try {
        const config = existsSync(agentsJsonPath)
          ? JSON.parse(readFileSync(agentsJsonPath, 'utf8'))
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

    if (url.pathname === '/api/usage') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(getUsageStats()))
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

    // Serve media files from mediaDir
    if (url.pathname.startsWith('/media/')) {
      const filename = url.pathname.slice('/media/'.length)
      if (!filename) { res.writeHead(400); res.end('Bad request'); return }
      const filePath = resolve(mediaDir, filename)
      // Security: canonical path must be inside mediaDir
      if (!filePath.startsWith(mediaDir + sep)) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }
      if (!existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      const ext = filename.split('.').pop() || ''
      const mediaMime: Record<string, string> = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
        webp: 'image/webp', mp4: 'video/mp4', pdf: 'application/pdf', bin: 'application/octet-stream',
      }
      res.writeHead(200, {
        'Content-Type': mediaMime[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      })
      res.end(readFileSync(filePath))
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

    // --- Channel & Nickname API ---

    if (url.pathname === '/api/channels' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (ctx) {
        const channels = ctx.getChannels().map(ch => ({
          id: ch.id,
          type: ch.type,
          label: ch.label,
          status: ch.getStatus(),
        }))
        res.end(JSON.stringify(channels))
      } else {
        res.end('[]')
      }
      return
    }

    if (url.pathname === '/api/channels' && req.method === 'POST') {
      if (!ctx) { res.writeHead(503); res.end('{"error":"no hub context"}'); return }
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', async () => {
        try {
          const { type, accountName } = JSON.parse(body)
          if (!type || !accountName) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end('{"error":"type and accountName required"}')
            return
          }
          const channelId = `${type}-${accountName}`
          if (ctx!.getChannel(channelId)) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: `Channel "${channelId}" already exists` }))
            return
          }
          await ctx!.addChannel(type, channelId, accountName)
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: channelId, type, label: accountName, status: 'disconnected' }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    if (url.pathname.match(/^\/api\/channels\/[^/]+\/disconnect$/) && req.method === 'POST') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ctx) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"no hub context"}'); return }
      const ch = ctx.getChannel(channelId)
      if (!ch) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"channel not found"}'); return }
      ;(async () => {
        try {
          await ch.disconnect()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: channelId, status: ch.getStatus() }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })()
      return
    }

    if (url.pathname.match(/^\/api\/channels\/[^/]+\/probe$/) && req.method === 'POST') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ctx) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"error":"no hub context"}')
        return
      }
      const ch = ctx.getChannel(channelId)
      if (!ch) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":"channel not found"}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: channelId, status: ch.getStatus() }))
      return
    }

    // --- QR Login ---
    if (url.pathname.match(/^\/api\/channels\/[^/]+\/login$/) && req.method === 'POST') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ctx) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end('{"error":"no hub context"}')
        return
      }
      // Note: we intentionally don't check ctx.getChannel(channelId) here.
      // The channel:add listener is async (dynamic import) and may not have
      // registered the channel yet. QR login only needs to fetch a QR code
      // and poll; reconnectChannel (called on confirmed) will find it by then.

      ;(async () => {
        try {
          // Cancel any existing poll for this channel
          if (activeQrPolls.has(channelId)) {
            clearInterval(activeQrPolls.get(channelId)!)
            activeQrPolls.delete(channelId)
          }

          const qr = await fetchQrCode()

          // Respond with QR data URL immediately
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ qrUrl: qr.qrDataUrl }))

          // Broadcast initial QR status to browser (use data URL for rendering)
          broadcastWs({ type: 'qr_status', channelId, status: 'pending' as QrStatus, qrUrl: qr.qrDataUrl })

          // Start background polling (auto-expire after 10 minutes as safety net)
          const pollStart = Date.now()
          const MAX_POLL_MS = 10 * 60 * 1000
          const poll = setInterval(async () => {
            if (Date.now() - pollStart > MAX_POLL_MS) {
              clearInterval(poll)
              activeQrPolls.delete(channelId)
              broadcastWs({ type: 'qr_status', channelId, status: 'expired', qrUrl: qr.qrDataUrl })
              return
            }
            try {
              const result = await checkQrStatus(qr.qrToken)
              broadcastWs({ type: 'qr_status', channelId, status: result.status, qrUrl: qr.qrDataUrl })

              if (result.status === 'confirmed' && result.credentials) {
                clearInterval(poll)
                activeQrPolls.delete(channelId)
                saveCredentials(result.credentials, channelId)
                // Reconnect channel with new credentials
                try {
                  await ctx!.reconnectChannel(channelId)
                } catch (err: any) {
                  console.error(`[web] QR login reconnect failed: ${err.message}`)
                }
              } else if (result.status === 'expired') {
                clearInterval(poll)
                activeQrPolls.delete(channelId)
              }
            } catch (err: any) {
              console.error(`[web] QR poll error: ${err.message}`)
              // Don't stop polling on transient errors
            }
          }, POLL_INTERVAL)
          activeQrPolls.set(channelId, poll)
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
          }
        }
      })()
      return
    }

    // Cancel QR polling (called when user dismisses QR overlay)
    if (url.pathname.match(/^\/api\/channels\/[^/]+\/login$/) && req.method === 'DELETE') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (activeQrPolls.has(channelId)) {
        clearInterval(activeQrPolls.get(channelId)!)
        activeQrPolls.delete(channelId)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    if (url.pathname.startsWith('/api/channels/') && !url.pathname.includes('/probe') && !url.pathname.includes('/disconnect') && !url.pathname.includes('/login') && req.method === 'DELETE') {
      if (!ctx) { res.writeHead(503); res.end('{"error":"no hub context"}'); return }
      const channelId = decodeURIComponent(url.pathname.slice('/api/channels/'.length))
      if (!ctx.getChannel(channelId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{"error":"channel not found"}')
        return
      }
      if (ctx.getChannels().length <= 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"cannot delete the last channel"}')
        return
      }
      ;(async () => {
        try {
          await ctx!.removeChannel(channelId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })()
      return
    }

    if (url.pathname === '/api/nicknames' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      try {
        res.end(JSON.stringify(getNicknames()))
      } catch {
        res.end('[]')
      }
      return
    }

    if (url.pathname.startsWith('/api/nicknames/') && req.method === 'PATCH') {
      const parts = url.pathname.slice('/api/nicknames/'.length).split('/')
      if (parts.length !== 2) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"expected /api/nicknames/:channelId/:userId"}')
        return
      }
      const [channelId, userId] = parts.map(decodeURIComponent)
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', () => {
        try {
          const { nickname } = JSON.parse(body)
          if (!nickname || typeof nickname !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end('{"error":"nickname required"}')
            return
          }
          setNickname(channelId, userId, nickname.trim())
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    // --- Cron Jobs API ---

    if (url.pathname === '/api/cron-jobs' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const { name, agentId, scheduleType, scheduleValue, timezone, message } = JSON.parse(body)

          if (!name || !scheduleType || !scheduleValue || !message) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Missing required fields: name, scheduleType, scheduleValue, message' }))
            return
          }

          // Calculate nextRun
          const sched = new CronScheduler({} as any)
          const tz = timezone || 'Asia/Shanghai'
          const nextRun = sched.calcNextRun(scheduleType, scheduleValue, tz)

          if (!nextRun) {
            const errMsg = scheduleType === 'once' ? 'Once schedule is in the past' : `Invalid schedule: ${scheduleType} "${scheduleValue}"`
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: errMsg }))
            return
          }

          const job = createJob({
            name, agentId: agentId || 'brain', scheduleType, scheduleValue,
            timezone: tz, message, enabled: true, nextRun, createdBy: 'dashboard',
          })

          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(job))
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'DELETE') {
      const jobId = decodeURIComponent(url.pathname.slice('/api/cron-jobs/'.length))
      const ok = deleteJob(jobId)
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(ok ? { success: true } : { error: 'Job not found' }))
      return
    }

    if (url.pathname.startsWith('/api/cron-jobs/') && req.method === 'PATCH') {
      const jobId = decodeURIComponent(url.pathname.slice('/api/cron-jobs/'.length))
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const updates = JSON.parse(body)
          const ok = updateJob(jobId, updates)
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(ok ? { success: true } : { error: 'Job not found' }))
        } catch (err: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    if (url.pathname === '/api/cron-jobs') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      try {
        const jobs = listJobs()
        const data = jobs.map(j => ({ ...j, recentRuns: getRecentRuns(j.id, 5) }))
        res.end(JSON.stringify(data))
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err.message }))
      }
      return
    }

    // Serve frontend static files
    if (frontendDir) {
      let filePath = join(frontendDir, url.pathname === '/' ? 'index.html' : url.pathname)
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
        jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' })
      res.end(readFileSync(filePath))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  }
}

export async function startWeb(options: { port: number; ctx?: HubContext }) {
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
