/**
 * cc2im Web — REST API route handler
 *
 * All /api/* routes for the dashboard. Extracted from server.ts
 * so each concern lives in its own file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { getTokenStats } from './token-stats.js'
import { getUsageStats } from './usage-stats.js'
import { getDeepseekBalance } from './deepseek-balance.js'
import { readStats } from './stats-reader.js'
import type { HubEventData } from '../../shared/types.js'
import type { HubContext } from '../../shared/plugin.js'
import { getNicknames, setNickname } from '../persistence/db.js'
import { WebChannel, WEB_CHANNEL_ID } from '../web-channel/index.js'
import { openInTerminal, handoffCommand, type OpenTerminalResult } from '../../shared/open-terminal.js'
import { isValidAgentName } from '../../shared/agent-name.js'

/** CSRF guard for state-changing / process-spawning endpoints. Modern browsers
 *  send Sec-Fetch-Site; reject cross-site. Absent header (curl/tests) is allowed —
 *  the dashboard is 127.0.0.1-only, so this just blocks drive-by CSRF from other sites. */
function isCrossSite(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return typeof site === 'string' && site !== 'same-origin' && site !== 'same-site' && site !== 'none'
}
import { listJobs, createJob, deleteJob, updateJob, getRecentRuns } from '../cron-scheduler/db.js'
import { CronScheduler } from '../cron-scheduler/scheduler.js'
import { Cron } from 'croner'
import { fetchQrCode, checkQrStatus, saveCredentials, POLL_INTERVAL, type QrStatus } from '../weixin/qr-login.js'

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
  /** Injectable for tests — defaults to the real openInTerminal (opens a GUI window). */
  openTerminalFn?: (cwd: string, command: string) => OpenTerminalResult
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
  const openTerminalFn = deps.openTerminalFn ?? openInTerminal

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

    if (url.pathname === '/api/deepseek-balance') {
      getDeepseekBalance().then(data => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      }).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: err?.message || String(err), lastUpdated: new Date().toISOString() }))
      })
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

    // --- Dashboard chat: inject a message into the web channel ---

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      if (!ctx) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"no hub context"}'); return }
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', async () => {
        try {
          const { text, agentId } = JSON.parse(body)
          if (typeof text !== 'string' || !text.trim()) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end('{"error":"text required"}')
            return
          }
          const web = ctx!.getChannel(WEB_CHANNEL_ID)
          if (!web || !(web instanceof WebChannel)) {
            res.writeHead(503, { 'Content-Type': 'application/json' })
            res.end('{"error":"web channel unavailable"}')
            return
          }
          // @agent 前缀交给 router 解析；带 agentId 时替用户拼好
          const trimmed = text.trim()
          const composed = agentId && !trimmed.startsWith('@') ? `@${agentId} ${trimmed}` : trimmed
          await web.injectIncoming(composed)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"ok":true}')
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })
      return
    }

    // --- Onboard a local directory as a cc2im agent ---

    if (url.pathname === '/api/onboard' && req.method === 'POST') {
      if (!ctx) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"no hub context"}'); return }
      if (isCrossSite(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"cross-site request refused"}'); return }
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', async () => {
        const fail = (code: number, msg: string) => {
          res.writeHead(code, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: msg }))
        }
        try {
          const { name, cwd, autoStart = true, startNow = false } = JSON.parse(body)
          // agentId 会进 expect 脚本 + 文件系统路径，收紧字符集防注入/路径穿越（与 rename 共用校验）
          if (!isValidAgentName(name)) {
            return fail(400, 'name 非法：仅允许字母/数字/中文/._- 且 1-64 字符')
          }
          if (typeof cwd !== 'string' || !cwd.trim() || /[\n\r\0]/.test(cwd)) {
            return fail(400, 'cwd 非法（空或含控制字符）')
          }
          if (!isAbsolute(cwd)) return fail(400, 'cwd 必须是绝对路径')
          if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return fail(400, `目录不存在或不是目录：${cwd}`)

          const mgr = ctx!.getAgentManager()
          const reg = mgr.register(name, cwd, undefined, !!autoStart)
          if (!reg.success) return fail(409, reg.error || 'register 失败')

          // Write .mcp.json before announcing the agent — if it fails, roll back
          // the registration so agents.json stays clean and the user can retry.
          const wrote = mgr.writeMcpJson(name)
          if (!wrote.success) {
            await mgr.deregister(name)
            return fail(500, wrote.error || 'writeMcpJson 失败')
          }

          ctx!.getRouter().updateConfig(mgr.getConfig())
          ctx!.broadcastMonitor({ kind: 'config_changed' as any, agentId: name, timestamp: new Date().toISOString() })

          let started = false
          if (startNow) {
            const s = mgr.start(name)
            started = s.success
            if (!s.success) {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, registered: true, started: false, startError: s.error }))
              return
            }
          }
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, registered: true, started, name, cwd, autoStart: !!autoStart }))
        } catch (err: any) {
          fail(500, err.message)
        }
      })
      return
    }

    // --- One-click handoff: stop a managed agent + open its cwd in a terminal ---

    if (url.pathname.match(/^\/api\/agents\/[^/]+\/handoff$/) && req.method === 'POST') {
      if (!ctx) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"no hub context"}'); return }
      if (isCrossSite(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"cross-site request refused"}'); return }
      const name = decodeURIComponent(url.pathname.split('/')[3])
      ;(async () => {
        try {
          const config = existsSync(agentsJsonPath) ? JSON.parse(readFileSync(agentsJsonPath, 'utf8')) : { agents: {} }
          const agent = config.agents?.[name]
          if (!agent) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"agent not found"}'); return }

          const mgr = ctx!.getAgentManager()
          // Stop it if the hub is managing it, so the terminal's --continue resumes cleanly.
          let stopped = false
          if (mgr.isManaged(name)) {
            const s = await mgr.stop(name)
            stopped = s.success
          }

          const result = openTerminalFn(agent.cwd, handoffCommand())
          if (!result.ok) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: result.error || 'open terminal failed', stopped }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, stopped, app: result.app, cwd: agent.cwd }))
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: err.message }))
        }
      })()
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
          health: typeof ch.getHealth === 'function' ? ch.getHealth() : null,
        }))
        res.end(JSON.stringify(channels))
      } else {
        res.end('[]')
      }
      return
    }

    if (url.pathname.match(/^\/api\/channels\/[^/]+\/health$/) && req.method === 'GET') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ctx) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":"no hub context"}'); return }
      const ch = ctx.getChannel(channelId)
      if (!ch) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"channel not found"}'); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(typeof ch.getHealth === 'function' ? ch.getHealth() : null))
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

          // Start background polling (auto-expire after 5 minutes as safety net)
          const pollStart = Date.now()
          const MAX_POLL_MS = 5 * 60 * 1000
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
      if (channelId === WEB_CHANNEL_ID) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"built-in web channel cannot be removed"}')
        return
      }
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

          // If re-enabling a job, recalculate nextRun so it doesn't fire immediately
          if (updates.enabled === true) {
            const jobs = listJobs()
            const job = jobs.find(j => j.id === jobId)
            if (job) {
              if (job.scheduleType === 'cron') {
                try {
                  const c = new Cron(job.scheduleValue, { timezone: job.timezone })
                  const next = c.nextRun()
                  if (next) updates.nextRun = next.toISOString()
                } catch { /* invalid cron — let it be */ }
              } else if (job.scheduleType === 'interval') {
                const ms = parseInt(job.scheduleValue, 10)
                if (!isNaN(ms) && ms > 0) {
                  updates.nextRun = new Date(Date.now() + ms).toISOString()
                }
              }
              // 'once' type: don't recalculate — if it already fired, it stays disabled
            }
          }

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
