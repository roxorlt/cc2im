/**
 * cc2im Hub — 常驻进程，核心路由 + 插件加载
 */

import { existsSync, readFileSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { HubSocketServer } from './socket-server.js'
import { Router } from './router.js'
import { AgentManager } from './agent-manager.js'
import { HubContextImpl } from './hub-context.js'
import { PluginManager } from './plugin-manager.js'
import { createPersistencePlugin } from '../plugins/persistence/index.js'
import { createCronSchedulerPlugin } from '../plugins/cron-scheduler/index.js'
import { WeixinChannel } from '../plugins/weixin/weixin-channel.js'
import { WebChannel } from '../plugins/web-channel/index.js'
import { loadChannelConfigs } from '../shared/channel-config.js'
import { createChannelManagerPlugin } from '../plugins/channel-manager/index.js'
import { createWebMonitorPlugin } from '../plugins/web-monitor/index.js'
import { SOCKET_DIR } from '../shared/socket.js'
import type { AgentsConfig, SpokeToHub } from '../shared/types.js'
import type { Cc2imChannel } from '../shared/channel.js'

// --- Config ---
const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

function loadAgentsConfig(): AgentsConfig {
  if (existsSync(AGENTS_JSON_PATH)) {
    return JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  }
  return { defaultAgent: 'brain', agents: {} }
}

const MAX_LOG_BYTES = 50 * 1024 * 1024 // 50 MB

function truncateLogs() {
  const logDir = SOCKET_DIR
  for (const name of ['hub.log', 'hub.error.log']) {
    const p = join(logDir, name)
    try {
      if (existsSync(p) && statSync(p).size > MAX_LOG_BYTES) {
        truncateSync(p, 0)
        console.log(`[hub] Truncated oversized log: ${name}`)
      }
    } catch {}
  }
}

// --- Main ---
export async function startHub(options?: { autoStartAgents?: boolean }) {
  truncateLogs()
  const config = loadAgentsConfig()
  const router = new Router(config)

  let socketServer: HubSocketServer
  let ctx: HubContextImpl

  const agentManager = new AgentManager(
    () => socketServer.getConnectedAgents(),
    (kind, agentId, extra) => {
      const event = { kind: kind as any, agentId, timestamp: new Date().toISOString(), ...extra }
      ctx.broadcastMonitor(event)
      if (kind === 'agent_dead') ctx.emit('agent:dead', agentId)
    },
  )

  socketServer = new HubSocketServer(
    async (agentId: string, msg: SpokeToHub) => {
      // Management messages are core — handle before emitting to plugins
      if (msg.type === 'management') {
        await handleManagement(agentId, msg, agentManager, router, socketServer, ctx)
        return
      }
      ctx.emit('spoke:message', agentId, msg)
    },
    {
      onEvict: (agentId: string) => {
        ctx.emit('agent:evicted', agentId)
        // Kill the process — child.on('exit') in AgentManager will handle restart
        if (agentManager.isManaged(agentId)) {
          agentManager.killForRestart(agentId)
        }
      },
      onAgentOnline: (agentId: string) => ctx.emit('agent:online', agentId),
      onAgentOffline: (agentId: string) => ctx.emit('agent:offline', agentId),
    },
  )

  ctx = new HubContextImpl(socketServer, agentManager, router, config)
  const pluginManager = new PluginManager()

  const channelConfigs = loadChannelConfigs()
  const channels: Cc2imChannel[] = channelConfigs.map(cfg => {
    switch (cfg.type) {
      case 'weixin':
        return new WeixinChannel(cfg.id, cfg.accountName)
      default:
        console.warn(`[hub] Unknown channel type: ${cfg.type}, skipping "${cfg.id}"`)
        return null
    }
  }).filter((ch): ch is WeixinChannel => ch !== null)

  if (channels.length === 0) {
    console.warn('[hub] No channels configured, creating default weixin channel')
    channels.push(new WeixinChannel())
  }

  // Dashboard chat — built-in web channel, always present, not persisted in channels.json
  channels.push(new WebChannel())
  pluginManager.register(createPersistencePlugin())
  pluginManager.register(createCronSchedulerPlugin())
  pluginManager.register(createChannelManagerPlugin(channels))
  pluginManager.register(createWebMonitorPlugin())

  // --- Start ---
  await socketServer.start()
  await pluginManager.initAll(ctx)

  if (options?.autoStartAgents) {
    agentManager.startAutoAgents()
  }

  ctx.emit('hub:ready')

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[hub] Shutting down...')
    ctx.emit('hub:shutdown')
    await pluginManager.destroyAll()
    await agentManager.stopAll()
    socketServer.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

/** Handle management messages (agent register/start/stop/list) — core logic */
async function handleManagement(
  agentId: string,
  msg: any,
  agentManager: AgentManager,
  router: Router,
  socketServer: HubSocketServer,
  ctx: HubContextImpl,
) {
  console.log(`[hub] Management request from ${agentId}: ${msg.action}`)
  const targetName = msg.params?.name
  const isSelfAction = targetName === agentId &&
    (msg.action === 'stop' || msg.action === 'deregister')

  const sendResult = (result: { success: boolean; data?: any; error?: string }) => {
    socketServer.send(agentId, {
      type: 'management_result',
      requestId: msg.requestId,
      success: result.success,
      data: result.data,
      error: result.error,
    })
  }

  let result: { success: boolean; data?: any; error?: string }

  switch (msg.action) {
    case 'register': {
      result = agentManager.register(msg.params!.name!, msg.params!.cwd!, msg.params!.claudeArgs)
      if (result.success) {
        router.updateConfig(agentManager.getConfig())
        ctx.broadcastMonitor({ kind: 'config_changed' as any, agentId: msg.params!.name!, timestamp: new Date().toISOString() })
      }
      break
    }
    case 'deregister': {
      if (isSelfAction) {
        sendResult({ success: true })
        await agentManager.deregister(msg.params!.name!)
        router.updateConfig(agentManager.getConfig())
        ctx.broadcastMonitor({ kind: 'config_changed' as any, agentId: msg.params!.name!, timestamp: new Date().toISOString() })
        return
      }
      result = await agentManager.deregister(msg.params!.name!)
      if (result.success) {
        router.updateConfig(agentManager.getConfig())
        ctx.broadcastMonitor({ kind: 'config_changed' as any, agentId: msg.params!.name!, timestamp: new Date().toISOString() })
      }
      break
    }
    case 'start': {
      result = agentManager.start(msg.params!.name!)
      break
    }
    case 'restart': {
      // No isManaged guard: restart() must work for stopped / crashed / orphan-only
      // agents too — that is the whole point of a recovery action. restart() itself
      // rejects unregistered names.
      // Self-restart would kill this agent before the result is delivered — ack first.
      if (targetName === agentId) {
        sendResult({ success: true })
        await agentManager.restart(msg.params!.name!)
        return
      }
      result = await agentManager.restart(msg.params!.name!)
      break
    }
    case 'rename': {
      const oldName = msg.params!.name!
      const newName = msg.params!.newName!
      // Self-rename restarts this very connection under the new agent-id, so the
      // old socket can't receive the result — validate up front, ack, then execute.
      if (oldName === agentId) {
        const err = agentManager.validateRename(oldName, newName)
        if (err) { result = { success: false, error: err }; break }
        sendResult({ success: true, data: { renamedTo: newName } })
        await agentManager.rename(oldName, newName)
        await migrateAgentReferences(oldName, newName)
        router.updateConfig(agentManager.getConfig())
        ctx.broadcastMonitor({ kind: 'config_changed' as any, agentId: newName, timestamp: new Date().toISOString() })
        return
      }
      const renameRes = await agentManager.rename(oldName, newName)
      if (renameRes.success) {
        await migrateAgentReferences(oldName, newName)
        router.updateConfig(agentManager.getConfig())
        ctx.broadcastMonitor({ kind: 'config_changed' as any, agentId: newName, timestamp: new Date().toISOString() })
      }
      result = { success: renameRes.success, error: renameRes.error, data: renameRes.warning ? { warning: renameRes.warning } : undefined }
      break
    }
    case 'stop': {
      if (!agentManager.isManaged(targetName!)) {
        result = { success: false, error: `Agent "${targetName}" is not managed by this hub (started externally)` }
        break
      }
      if (isSelfAction) {
        sendResult({ success: true })
        await agentManager.stop(msg.params!.name!)
        return
      }
      result = await agentManager.stop(msg.params!.name!)
      break
    }
    case 'list': {
      result = { success: true, data: agentManager.list() }
      break
    }
    case 'cron_create': {
      const { createJob: dbCreate, CronScheduler: Sched } = await import('../plugins/cron-scheduler/index.js')
      const p = msg.params!
      const tmpSched = new Sched(ctx)
      const nextRun = tmpSched.calcNextRun(p.scheduleType!, p.scheduleValue!, p.timezone || 'Asia/Shanghai')

      if (!nextRun) {
        const errMsg = p.scheduleType === 'once'
          ? 'Once schedule is in the past'
          : `Invalid schedule: ${p.scheduleType} "${p.scheduleValue}"`
        result = { success: false, error: errMsg }
        break
      }

      const job = dbCreate({
        name: p.name!,
        agentId: p.agentId || agentId,
        scheduleType: p.scheduleType!,
        scheduleValue: p.scheduleValue!,
        timezone: p.timezone || 'Asia/Shanghai',
        message: p.message!,
        enabled: true,
        nextRun,
        createdBy: agentId,
      })
      result = { success: true, data: job }
      break
    }

    case 'cron_list': {
      const { listJobs: dbList, getRecentRuns: dbRuns } = await import('../plugins/cron-scheduler/index.js')
      const jobs = dbList(msg.params?.agentId)
      const data = jobs.map(j => ({
        ...j,
        recentRuns: dbRuns(j.id, 5),
      }))
      result = { success: true, data }
      break
    }

    case 'cron_delete': {
      const { deleteJob: dbDelete } = await import('../plugins/cron-scheduler/index.js')
      const ok = dbDelete(msg.params!.jobId!)
      result = ok ? { success: true } : { success: false, error: 'Job not found' }
      break
    }

    case 'cron_update': {
      const { updateJob: dbUpdate } = await import('../plugins/cron-scheduler/index.js')
      const { jobId, ...updates } = msg.params as any
      const ok = dbUpdate(jobId, updates)
      result = ok ? { success: true } : { success: false, error: 'Job not found' }
      break
    }

    default:
      result = { success: false, error: `Unknown action: ${msg.action}` }
  }

  if (!isSelfAction) {
    sendResult(result!)
  }
}

/** After an agent is renamed, repoint its rows in the SQLite tables that
 *  reference agents by name (cron jobs + persisted/pending messages), so cron
 *  keeps firing and the offline queue replays under the new name. */
async function migrateAgentReferences(oldName: string, newName: string) {
  try {
    const { renameAgent: renameCron } = await import('../plugins/cron-scheduler/db.js')
    const n = renameCron(oldName, newName)
    if (n > 0) console.log(`[hub] rename: repointed ${n} cron job(s) ${oldName} → ${newName}`)
  } catch (err: any) {
    console.error(`[hub] rename: cron migration failed: ${err?.message ?? err}`)
  }
  try {
    const { renameAgent: renameMsgs } = await import('../plugins/persistence/db.js')
    const n = renameMsgs(oldName, newName)
    if (n > 0) console.log(`[hub] rename: repointed ${n} persisted message(s) ${oldName} → ${newName}`)
  } catch (err: any) {
    console.error(`[hub] rename: message migration failed: ${err?.message ?? err}`)
  }
}

// Run if executed directly (not imported)
const isDirectRun = process.argv[1]?.includes('hub/index')
if (isDirectRun) {
  startHub().catch((err) => {
    console.error(`[hub] Fatal: ${err.message}`)
    process.exit(1)
  })
}
