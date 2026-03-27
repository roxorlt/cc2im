/**
 * cc2im Hub — 常驻进程，核心路由 + 插件加载
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HubSocketServer } from './socket-server.js'
import { Router } from './router.js'
import { AgentManager } from './agent-manager.js'
import { HubContextImpl } from './hub-context.js'
import { PluginManager } from './plugin-manager.js'
import { createPersistencePlugin } from '../plugins/persistence/index.js'
import { WeixinChannel } from '../plugins/weixin/weixin-channel.js'
import { loadChannelConfigs } from '../shared/channel-config.js'
import { createChannelManagerPlugin } from '../plugins/channel-manager/index.js'
import { createWebMonitorPlugin } from '../plugins/web-monitor/index.js'
import { SOCKET_DIR } from '../shared/socket.js'
import type { AgentsConfig, SpokeToHub } from '../shared/types.js'

// --- Config ---
const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

function loadAgentsConfig(): AgentsConfig {
  if (existsSync(AGENTS_JSON_PATH)) {
    return JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  }
  return { defaultAgent: 'brain', agents: {} }
}

// --- Main ---
export async function startHub(options?: { autoStartAgents?: boolean }) {
  const config = loadAgentsConfig()
  const router = new Router(config)

  let socketServer: HubSocketServer
  let ctx: HubContextImpl

  const agentManager = new AgentManager(
    () => socketServer.getConnectedAgents(),
    (kind, agentId, extra) => {
      ctx.broadcastMonitor({ kind: kind as any, agentId, timestamp: new Date().toISOString(), ...extra })
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
  const channels = channelConfigs.map(cfg => {
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
  pluginManager.register(createPersistencePlugin())
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
    default:
      result = { success: false, error: `Unknown action: ${msg.action}` }
  }

  if (!isSelfAction) {
    sendResult(result!)
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
