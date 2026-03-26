/**
 * WeChat connector plugin — bridges WeChat ↔ hub ↔ spokes.
 * Owns: WeixinConnection, PermissionManager, user tracking, message routing.
 */

import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { WeixinConnection } from './connection.js'
import { PermissionManager } from './permission.js'

export function createWeixinPlugin(): Cc2imPlugin {
  let weixin: WeixinConnection
  let permissionMgr: PermissionManager
  let cleanupInterval: ReturnType<typeof setInterval>
  const lastUserByAgent = new Map<string, string>()
  let lastGlobalUser: string | null = null

  return {
    name: 'weixin',
    async init(ctx: HubContext) {
      weixin = new WeixinConnection()
      permissionMgr = new PermissionManager()

      // --- Spoke → WeChat: handle spoke messages ---
      ctx.on('spoke:message', async (agentId: string, msg: any) => {
        switch (msg.type) {
          case 'reply': {
            console.log(`[hub] Reply from ${agentId} to ${msg.userId}: ${msg.text.slice(0, 100)}`)
            ctx.broadcastMonitor({ kind: 'message_out', agentId, userId: msg.userId, text: msg.text, timestamp: new Date().toISOString() })
            await weixin.send(msg.userId, msg.text)
            break
          }
          case 'permission_request': {
            console.log(`[hub] Permission request from ${agentId}: ${msg.toolName}`)
            await permissionMgr.handleRequest(agentId, msg, ctx, weixin, lastUserByAgent, lastGlobalUser)
            break
          }
          case 'status': {
            console.log(`[hub] Agent ${agentId} status: ${msg.status}`)
            break
          }
          case 'permission_timeout': {
            permissionMgr.handleTimeout(msg.requestId)
            break
          }
          // NOTE: 'management' type is handled by hub core, not by this plugin
        }
      })

      // --- WeChat → Spoke: handle incoming WeChat messages ---
      weixin.setMessageHandler(async (incomingMsg) => {
        const userId = incomingMsg.userId
        lastGlobalUser = userId

        // Permission verdict detection
        if (permissionMgr.tryHandleVerdict(incomingMsg, ctx)) return

        // Route message
        const router = ctx.getRouter()
        const routed = router.route(incomingMsg.text || '')
        lastUserByAgent.set(routed.agentId, userId)

        // Unknown agent
        if (routed.unknownAgent) {
          const available = router.getAgentNames()
          await weixin.send(userId, `⚠ Agent "${routed.agentId}" 不存在，可用的 agent: ${available.join(', ') || '无'}`)
          return
        }

        // Intercepted commands (restart, effort)
        if (routed.intercepted) {
          const agentManager = ctx.getAgentManager()
          switch (routed.intercepted.command) {
            case 'restart': {
              await weixin.send(userId, `正在重启 ${routed.agentId}...`)
              const result = await agentManager.restart(routed.agentId)
              await weixin.send(userId, result.success ? `✓ ${routed.agentId} 已重启` : `✗ 重启失败: ${result.error}`)
              return
            }
            case 'effort': {
              const effort = routed.intercepted.args![0]
              agentManager.updateEffort(routed.agentId, effort)
              await weixin.send(userId, `正在以 --effort ${effort} 重启 ${routed.agentId}...`)
              const result = await agentManager.restart(routed.agentId)
              await weixin.send(userId, result.success ? `✓ ${routed.agentId} 已重启 (effort: ${effort})` : `✗ 重启失败: ${result.error}`)
              return
            }
          }
        }

        // Forward to spoke — persistence plugin will queue if offline
        const text = buildMessageContent(incomingMsg, routed.text)
        console.log(`[hub] Forwarding to ${routed.agentId}: ${text.substring(0, 80)}`)
        ctx.broadcastMonitor({ kind: 'message_in', agentId: routed.agentId, userId, text: routed.text, timestamp: new Date().toISOString() })
        const sent = ctx.deliverToAgent(routed.agentId, {
          type: 'message',
          userId,
          text,
          msgType: incomingMsg.type,
          mediaPath: incomingMsg.mediaPath ?? undefined,
          timestamp: incomingMsg.timestamp?.toISOString() ?? new Date().toISOString(),
        })
        if (!sent) {
          console.log(`[hub] Message queued for offline agent "${routed.agentId}"`)
          await weixin.send(userId, `📬 ${routed.agentId} 暂时离线，消息已排队，上线后自动投递。`)
        }
      })

      // Permission cleanup
      cleanupInterval = setInterval(() => permissionMgr.cleanup(), 60_000)

      // Login and start listening
      await weixin.login()
      weixin.startListening()
      // startPolling() is a long-poll loop that never returns — fire and forget
      weixin.startPolling().catch((err: any) => {
        console.error(`[weixin] Polling error: ${err.message}`)
      })
    },

    async destroy() {
      if (cleanupInterval) clearInterval(cleanupInterval)
    },
  }
}

function buildMessageContent(msg: any, routedText: string): string {
  if (msg.type === 'voice' && msg.voiceText) return `[微信 ${msg.userId}] (语音转文字) ${msg.voiceText}`
  if (msg.type === 'voice') return `[微信 ${msg.userId}] (语音消息，无法识别)`
  if (msg.mediaPath) return `[微信 ${msg.userId}] (${msg.type} 已下载到 ${msg.mediaPath})`
  if (msg.type !== 'text') return `[微信 ${msg.userId}] (${msg.type} 消息，下载失败)`
  return `[微信 ${msg.userId}] ${routedText}`
}
