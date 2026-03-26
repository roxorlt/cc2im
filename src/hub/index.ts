/**
 * cc2im Hub — 常驻进程，持有唯一微信连接，消息路由 + agent 管理
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HubSocketServer } from './socket-server.js'
import { WeixinConnection } from './weixin.js'
import { Router } from './router.js'
import { AgentManager } from './agent-manager.js'
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

// --- Permission tracking ---
interface PendingPermission {
  requestId: string
  agentId: string
  toolName: string
  userId: string
  createdAt: number
}

const pendingPermissions: PendingPermission[] = []
const PERMISSION_TTL_MS = 6 * 60 * 1000 // 6 minutes (spoke timeout is 5 min)

/** Remove stale entries that the spoke may have missed sending timeout for */
function cleanupStalePermissions() {
  const now = Date.now()
  for (let i = pendingPermissions.length - 1; i >= 0; i--) {
    if (now - pendingPermissions[i].createdAt > PERMISSION_TTL_MS) {
      console.log(`[hub] Cleaning stale permission: ${pendingPermissions[i].requestId}`)
      pendingPermissions.splice(i, 1)
    }
  }
}

// --- Main ---
export async function startHub(options?: { autoStartAgents?: boolean }) {
  const config = loadAgentsConfig()
  const router = new Router(config)
  const weixin = new WeixinConnection()

  // --- Agent Manager (created before socket server to avoid reference race) ---
  let socketServer: HubSocketServer

  const agentManager = new AgentManager(
    () => socketServer.getConnectedAgents(),
    (kind, agentId, extra) => {
      socketServer.broadcast({ kind: kind as any, agentId, timestamp: new Date().toISOString(), ...extra })
    },
  )

  // --- Track which user last talked to which agent ---
  const lastUserByAgent = new Map<string, string>()
  let lastGlobalUser: string | null = null

  // Permission verdict detection
  const SIMPLE_RE = /^\s*(y|yes|ok|好|批准|always|始终|总是|n|no|不|拒绝)\s*$/i

  // Periodic cleanup of stale permissions
  const cleanupInterval = setInterval(cleanupStalePermissions, 60_000)

  // --- Socket Server: 接收 spoke 消息 ---
  socketServer = new HubSocketServer(async (agentId: string, msg: SpokeToHub) => {
    switch (msg.type) {
      case 'reply': {
        console.log(`[hub] Reply from ${agentId} to ${msg.userId}: ${msg.text.slice(0, 100)}`)
        socketServer.broadcast({ kind: 'message_out', agentId, userId: msg.userId, text: msg.text, timestamp: new Date().toISOString() })
        await weixin.send(msg.userId, msg.text)
        break
      }
      case 'permission_request': {
        console.log(`[hub] Permission request from ${agentId}: ${msg.toolName}`)
        // Prefer userId from spoke (tracks originating user), fall back to last known
        const targetUserId = msg.userId || lastUserByAgent.get(agentId) || lastGlobalUser
        if (!targetUserId) {
          console.log(`[hub] No user to forward permission request to`)
          break
        }

        pendingPermissions.push({
          requestId: msg.requestId,
          agentId,
          toolName: msg.toolName,
          userId: targetUserId,
          createdAt: Date.now(),
        })

        let preview = msg.inputPreview
        try {
          const parsed = JSON.parse(preview)
          if (parsed.command) preview = parsed.command
          else if (parsed.file_path) preview = parsed.file_path
          else preview = JSON.stringify(parsed, null, 2)
        } catch { /* keep original */ }

        const prompt = [
          `🔐 [${agentId}] Claude 请求权限`,
          `工具: ${msg.toolName}`,
          `说明: ${msg.description}`,
          '',
          preview.slice(0, 800),
          '',
          `回复 yes 批准 / always 始终批准 / no 拒绝`,
        ].join('\n')

        socketServer.broadcast({ kind: 'permission_request', agentId, toolName: msg.toolName, timestamp: new Date().toISOString() })
        await weixin.send(targetUserId, prompt)
        break
      }
      case 'status': {
        console.log(`[hub] Agent ${agentId} status: ${msg.status}`)
        break
      }
      case 'permission_timeout': {
        const idx = pendingPermissions.findIndex((p) => p.requestId === msg.requestId)
        if (idx >= 0) {
          pendingPermissions.splice(idx, 1)
          console.log(`[hub] Permission expired: ${msg.requestId} (removed from queue)`)
        }
        break
      }
      case 'management': {
        console.log(`[hub] Management request from ${agentId}: ${msg.action}`)
        const targetName = msg.params?.name
        // Is this agent operating on itself? If so, send reply before executing
        // destructive actions (stop/deregister kill the process & close the socket).
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
            result = agentManager.register(
              msg.params!.name!,
              msg.params!.cwd!,
              msg.params!.claudeArgs,
            )
            if (result.success) {
              router.updateConfig(agentManager.getConfig())
              socketServer.broadcast({ kind: 'config_changed', agentId: msg.params!.name!, timestamp: new Date().toISOString() })
            }
            break
          }
          case 'deregister': {
            if (isSelfAction) {
              sendResult({ success: true })
              await agentManager.deregister(msg.params!.name!)
              router.updateConfig(agentManager.getConfig())
              socketServer.broadcast({ kind: 'config_changed', agentId: msg.params!.name!, timestamp: new Date().toISOString() })
              break
            }
            result = await agentManager.deregister(msg.params!.name!)
            if (result.success) {
              router.updateConfig(agentManager.getConfig())
              socketServer.broadcast({ kind: 'config_changed', agentId: msg.params!.name!, timestamp: new Date().toISOString() })
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
              break
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
        break
      }
    }
  },
  // onEvict: zombie spoke 被踢后尝试重启
  (agentId: string) => {
    const agentConfig = agentManager.getConfig().agents[agentId]
    if (agentConfig?.autoStart && agentManager.isManaged(agentId)) {
      console.log(`[hub] Auto-restarting evicted agent "${agentId}"`)
      setTimeout(() => {
        const result = agentManager.start(agentId)
        if (!result.success) {
          console.log(`[hub] Failed to restart "${agentId}": ${result.error}`)
        }
      }, 5000)
    }
  },
  )

  // --- WeChat message handler ---
  weixin.setMessageHandler(async (msg) => {
    const userId = msg.userId
    lastGlobalUser = userId

    // Check for permission verdict — only match if the replying user is the one who was prompted
    if (msg.type === 'text' && msg.text && pendingPermissions.length > 0) {
      const simpleMatch = msg.text.match(SIMPLE_RE)
      if (simpleMatch) {
        const reply = simpleMatch[1].trim().toLowerCase()
        const isAlways = /^(always|始终|总是)$/.test(reply)
        const isAllow = isAlways || /^(y|yes|ok|好|批准)$/i.test(reply)

        // Find the first pending permission that was prompted to THIS user
        const idx = pendingPermissions.findIndex(p => p.userId === userId)
        if (idx >= 0) {
          const pending = pendingPermissions.splice(idx, 1)[0]
          const behavior = isAlways ? 'always' : isAllow ? 'allow' : 'deny'
          socketServer.send(pending.agentId, {
            type: 'permission_verdict',
            requestId: pending.requestId,
            behavior,
            toolName: pending.toolName,
          })
          console.log(`[hub] Permission verdict: ${pending.requestId} → ${behavior}`)
          socketServer.broadcast({ kind: 'permission_verdict', agentId: pending.agentId, behavior, timestamp: new Date().toISOString() })
          return
        }
        // No pending permission for this user — fall through to normal message routing
      }
    }

    // Route message
    const routed = router.route(msg.text || '')
    lastUserByAgent.set(routed.agentId, userId)

    // Unknown agent
    if (routed.unknownAgent) {
      const available = router.getAgentNames()
      await weixin.send(userId,
        `⚠ Agent "${routed.agentId}" 不存在，可用的 agent: ${available.join(', ') || '无'}`)
      return
    }

    // Intercepted commands (restart, effort)
    if (routed.intercepted) {
      switch (routed.intercepted.command) {
        case 'restart': {
          await weixin.send(userId, `正在重启 ${routed.agentId}...`)
          const result = await agentManager.restart(routed.agentId)
          if (result.success) {
            await weixin.send(userId, `✓ ${routed.agentId} 已重启`)
          } else {
            await weixin.send(userId, `✗ 重启失败: ${result.error}`)
          }
          return
        }
        case 'effort': {
          const effort = routed.intercepted.args![0]
          agentManager.updateEffort(routed.agentId, effort)
          await weixin.send(userId, `正在以 --effort ${effort} 重启 ${routed.agentId}...`)
          const result = await agentManager.restart(routed.agentId)
          if (result.success) {
            await weixin.send(userId, `✓ ${routed.agentId} 已重启 (effort: ${effort})`)
          } else {
            await weixin.send(userId, `✗ 重启失败: ${result.error}`)
          }
          return
        }
      }
    }

    // Check if agent is connected
    const connected = socketServer.getConnectedAgents()
    if (!connected.includes(routed.agentId)) {
      console.log(`[hub] Agent ${routed.agentId} not connected, dropping message`)
      await weixin.send(userId,
        `⚠ Agent "${routed.agentId}" 不在线。在线: ${connected.join(', ') || '无'}`)
      return
    }

    // Forward to spoke — use routed.text (with @mention stripped)
    const text = buildMessageContent(msg, routed.text)
    console.log(`[hub] Forwarding to ${routed.agentId}: ${text.substring(0, 80)}`)
    socketServer.broadcast({ kind: 'message_in', agentId: routed.agentId, userId, text: routed.text, timestamp: new Date().toISOString() })
    const sent = socketServer.send(routed.agentId, {
      type: 'message',
      userId,
      text,
      msgType: msg.type,
      mediaPath: msg.mediaPath ?? undefined,
      timestamp: msg.timestamp?.toISOString() ?? new Date().toISOString(),
    })
    if (!sent) {
      console.log(`[hub] ⚠ Failed to send to ${routed.agentId} (socket gone)`)
    }
  })

  // --- Start everything ---
  await socketServer.start()
  await weixin.login()
  weixin.startListening()

  // Auto-start agents if requested
  if (options?.autoStartAgents) {
    agentManager.startAutoAgents()
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[hub] Shutting down...')
    clearInterval(cleanupInterval)
    await agentManager.stopAll()
    socketServer.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await weixin.startPolling()
}

/** Build the text content forwarded to the spoke. Uses routedText (with @mention stripped). */
function buildMessageContent(msg: any, routedText: string): string {
  if (msg.type === 'voice' && msg.voiceText) {
    return `[微信 ${msg.userId}] (语音转文字) ${msg.voiceText}`
  } else if (msg.type === 'voice') {
    return `[微信 ${msg.userId}] (语音消息，无法识别)`
  } else if (msg.mediaPath) {
    return `[微信 ${msg.userId}] (${msg.type} 已下载到 ${msg.mediaPath})`
  } else if (msg.type !== 'text') {
    return `[微信 ${msg.userId}] (${msg.type} 消息，下载失败)`
  }
  return `[微信 ${msg.userId}] ${routedText}`
}

// Run if executed directly (not imported)
const isDirectRun = process.argv[1]?.includes('hub/index')
if (isDirectRun) {
  startHub().catch((err) => {
    console.error(`[hub] Fatal: ${err.message}`)
    process.exit(1)
  })
}
