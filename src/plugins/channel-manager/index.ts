/**
 * ChannelManager plugin — unified channel lifecycle, routing, and permissions.
 *
 * Replaces the weixin plugin's "glue" logic with a channel-agnostic implementation.
 * Owns: channel lifecycle, message routing (channel<->agent), typing indicators,
 * pending-ack timers, permission management, and user-tracking per agent.
 */

import { basename, join } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import type { Cc2imChannel, IncomingChannelMessage } from '../../shared/channel.js'
import { SOCKET_DIR } from '../../shared/socket.js'
import { PermissionManager, type UserRef } from '../weixin/permission.js'

const TYPING_ACK_DELAY_MS = 10_000 // 10s before "processing..." ack

export function createChannelManagerPlugin(channels: Cc2imChannel[]): Cc2imPlugin {
  let permissionMgr: PermissionManager
  let cleanupInterval: ReturnType<typeof setInterval>

  const lastUserByAgent = new Map<string, UserRef>()
  let lastGlobalUser: UserRef | null = null

  // Per-agent pending ack timer: agentId -> { ref, timer }
  const pendingAck = new Map<string, { ref: UserRef; timer: ReturnType<typeof setTimeout> }>()

  // Channel lookup by id
  const channelMap = new Map<string, Cc2imChannel>()
  for (const ch of channels) {
    channelMap.set(ch.id, ch)
  }

  return {
    name: 'channel-manager',
    async init(ctx: HubContext) {
      // Register channels into HubContext so other plugins can access them
      for (const ch of channels) {
        ctx.registerChannel(ch)
      }

      // Helper: find channel by id
      function getChannel(channelId: string): Cc2imChannel | undefined {
        return channelMap.get(channelId)
      }

      // Helper: send text via channel, with fallback log
      async function channelSendText(ref: UserRef, text: string): Promise<void> {
        const ch = getChannel(ref.channelId)
        if (!ch) {
          console.error(`[channel-manager] Channel "${ref.channelId}" not found, cannot send to ${ref.userId}`)
          return
        }
        await ch.sendText(ref.userId, text)
      }

      // --- Permission manager ---
      // PermissionManager needs a send function for permission prompts.
      // We provide a callback that resolves channel from lastUserByAgent.
      permissionMgr = new PermissionManager()

      // --- Pending ack management ---

      function clearPendingAck(agentId: string) {
        const pending = pendingAck.get(agentId)
        if (pending) {
          clearTimeout(pending.timer)
          pendingAck.delete(agentId)
          const ch = getChannel(pending.ref.channelId)
          ch?.stopTyping(pending.ref.userId).catch(() => {})
        }
      }

      function startPendingAck(agentId: string, ref: UserRef) {
        clearPendingAck(agentId) // clear any previous
        const ch = getChannel(ref.channelId)
        ch?.startTyping(ref.userId).catch(() => {})
        const timer = setTimeout(async () => {
          pendingAck.delete(agentId)
          await channelSendText(ref, `\u23F3 \u6536\u5230\uFF0C\u6B63\u5728\u5904\u7406...`).catch(() => {})
        }, TYPING_ACK_DELAY_MS)
        pendingAck.set(agentId, { ref, timer })
      }

      // --- Spoke -> Channel: handle spoke messages ---

      ctx.on('spoke:message', async (agentId: string, msg: any) => {
        switch (msg.type) {
          case 'reply': {
            clearPendingAck(agentId)
            // Resolve which channel to reply on
            const ref = resolveUserRef(agentId, msg.userId)
            if (!ref) {
              console.error(`[channel-manager] Cannot resolve channel for reply from ${agentId} to ${msg.userId}`)
              return
            }
            console.log(`[hub] Reply from ${agentId} to ${msg.userId}: ${msg.text.slice(0, 100)}`)
            ctx.broadcastMonitor({ kind: 'message_out', agentId, userId: msg.userId, text: msg.text, timestamp: new Date().toISOString(), channelId: ref.channelId })
            await channelSendText(ref, msg.text)
            break
          }

          case 'permission_request': {
            console.log(`[hub] Permission request from ${agentId}: ${msg.toolName}`)
            // sendFn resolves channel from the agent's tracked UserRef
            const sendFn = async (userId: string, text: string) => {
              const ref = resolveUserRef(agentId, userId)
              if (ref) {
                await channelSendText(ref, text)
              } else {
                console.error(`[channel-manager] Cannot resolve channel for permission prompt to ${userId}`)
              }
            }
            await permissionMgr.handleRequest(agentId, msg, ctx, sendFn, lastUserByAgent, lastGlobalUser)
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

          case 'send_file': {
            clearPendingAck(agentId)
            const ref = resolveUserRef(agentId, msg.userId)
            if (!ref) {
              console.error(`[channel-manager] Cannot resolve channel for send_file from ${agentId} to ${msg.userId}`)
              return
            }

            const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
            const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'webm'])
            const ext = msg.filePath.split('.').pop()?.toLowerCase() || ''
            const isImage = IMAGE_EXTS.has(ext)
            const isVideo = VIDEO_EXTS.has(ext)
            const msgType = isImage ? 'image' : isVideo ? 'video' : 'file'

            try {
              const ch = getChannel(ref.channelId)
              if (!ch) throw new Error(`Channel "${ref.channelId}" not found`)
              await ch.sendFile(ref.userId, msg.filePath)

              // Copy to media dir so dashboard can preview
              const mediaDir = join(SOCKET_DIR, 'media')
              const mediaName = `${Date.now()}-${basename(msg.filePath)}`
              try {
                mkdirSync(mediaDir, { recursive: true })
                copyFileSync(msg.filePath, join(mediaDir, mediaName))
              } catch {}

              console.log(`[hub] File sent from ${agentId} to ${msg.userId}: ${msg.filePath}`)
              ctx.broadcastMonitor({
                kind: 'message_out', agentId, userId: msg.userId,
                text: isImage ? '[\u56FE\u7247]' : `[${msgType}] ${basename(msg.filePath)}`,
                timestamp: new Date().toISOString(),
                msgType,
                mediaUrl: `/media/${mediaName}`,
                channelId: ref.channelId,
              })
            } catch (err: any) {
              console.error(`[hub] Failed to send file from ${agentId}: ${err.message}`)
            }
            break
          }
          // NOTE: 'management' type is handled by hub core, not by this plugin
        }
      })

      // --- Channel -> Agent: wire up message + status handlers ---

      function wireChannel(ch: Cc2imChannel) {
        ch.onMessage(async (incomingMsg: IncomingChannelMessage) => {
          const userId = incomingMsg.userId
          const channelId = incomingMsg.channelId
          const ref: UserRef = { userId, channelId }
          lastGlobalUser = ref

          // Permission verdict detection
          if (permissionMgr.tryHandleVerdict(
            { type: incomingMsg.type, text: incomingMsg.text, userId },
            ctx,
          )) return

          // Route message
          const router = ctx.getRouter()
          const routed = router.route(incomingMsg.text || '', channelId)
          lastUserByAgent.set(routed.agentId, ref)

          // Unknown agent
          if (routed.unknownAgent) {
            const available = router.getAgentNames()
            await channelSendText(ref, `\u26A0 Agent "${routed.agentId}" \u4E0D\u5B58\u5728\uFF0C\u53EF\u7528\u7684 agent: ${available.join(', ') || '\u65E0'}`)
            return
          }

          // Intercepted commands (restart, effort)
          if (routed.intercepted) {
            const agentManager = ctx.getAgentManager()
            switch (routed.intercepted.command) {
              case 'restart': {
                await channelSendText(ref, `\u6B63\u5728\u91CD\u542F ${routed.agentId}...`)
                const result = await agentManager.restart(routed.agentId)
                await channelSendText(ref, result.success ? `\u2713 ${routed.agentId} \u5DF2\u91CD\u542F` : `\u2717 \u91CD\u542F\u5931\u8D25: ${result.error}`)
                return
              }
              case 'effort': {
                const effort = routed.intercepted.args![0]
                agentManager.updateEffort(routed.agentId, effort)
                await channelSendText(ref, `\u6B63\u5728\u4EE5 --effort ${effort} \u91CD\u542F ${routed.agentId}...`)
                const result = await agentManager.restart(routed.agentId)
                await channelSendText(ref, result.success ? `\u2713 ${routed.agentId} \u5DF2\u91CD\u542F (effort: ${effort})` : `\u2717 \u91CD\u542F\u5931\u8D25: ${result.error}`)
                return
              }
            }
          }

          // Forward to spoke — persistence plugin will queue if offline
          const text = buildMessageContent(incomingMsg, routed.text)
          console.log(`[hub] Forwarding to ${routed.agentId}: ${text.substring(0, 80)}`)
          const mediaUrl = incomingMsg.mediaPath ? `/media/${basename(incomingMsg.mediaPath)}` : undefined
          ctx.broadcastMonitor({ kind: 'message_in', agentId: routed.agentId, userId, text: routed.text, timestamp: new Date().toISOString(), msgType: incomingMsg.type, mediaUrl, channelId: incomingMsg.channelId, channelType: incomingMsg.channelType })
          const sent = ctx.deliverToAgent(routed.agentId, {
            type: 'message',
            userId,
            text,
            msgType: incomingMsg.type,
            mediaPath: incomingMsg.mediaPath ?? undefined,
            timestamp: incomingMsg.timestamp?.toISOString() ?? new Date().toISOString(),
            channelId: incomingMsg.channelId,
          })
          if (sent) {
            startPendingAck(routed.agentId, ref)
          } else {
            console.log(`[hub] Message queued for offline agent "${routed.agentId}"`)
            await channelSendText(ref, `\uD83D\uDCEC ${routed.agentId} \u6682\u65F6\u79BB\u7EBF\uFF0C\u6D88\u606F\u5DF2\u6392\u961F\uFF0C\u4E0A\u7EBF\u540E\u81EA\u52A8\u6295\u9012\u3002`)
          }
        })

        // Channel status change -> monitor broadcast
        ch.onStatusChange((status, detail) => {
          console.log(`[channel-manager] ${ch.label} status: ${status}${detail ? ` (${detail})` : ''}`)
          ctx.broadcastMonitor({
            kind: 'channel_status',
            agentId: ch.id,  // reuse agentId field for channelId
            timestamp: new Date().toISOString(),
            text: `${ch.label}: ${status}${detail ? ` — ${detail}` : ''}`,
          })
        })
      }

      for (const ch of channels) {
        wireChannel(ch)
      }

      // --- Runtime channel add/remove ---

      ctx.on('channel:add', async (type: string, channelId: string, accountName: string) => {
        if (channelMap.has(channelId)) return  // already exists

        if (type === 'weixin') {
          const { WeixinChannel } = await import('../weixin/weixin-channel.js')
          const ch = new WeixinChannel(channelId, accountName)
          channelMap.set(channelId, ch)
          ctx.registerChannel(ch)
          wireChannel(ch)

          // Persist
          const { loadChannelConfigs, saveChannelConfigs } = await import('../../shared/channel-config.js')
          const configs = loadChannelConfigs()
          if (!configs.find(c => c.id === channelId)) {
            configs.push({ id: channelId, type: 'weixin', accountName })
            saveChannelConfigs(configs)
          }

          // Connect
          try {
            await ch.connect()
            console.log(`[channel-manager] ${ch.label} connected (runtime add)`)
          } catch (err: any) {
            console.error(`[channel-manager] ${ch.label} connect failed: ${err.message}`)
          }
        } else {
          console.warn(`[channel-manager] Unknown channel type: ${type}`)
        }
      })

      ctx.on('channel:remove', async (channelId: string) => {
        const ch = channelMap.get(channelId)
        if (ch) {
          try { await ch.disconnect() } catch {}
          channelMap.delete(channelId)
        }

        // Clean up user refs pointing to deleted channel
        for (const [agentId, ref] of lastUserByAgent) {
          if (ref.channelId === channelId) lastUserByAgent.delete(agentId)
        }
        if (lastGlobalUser?.channelId === channelId) lastGlobalUser = null

        // Persist
        const { loadChannelConfigs, saveChannelConfigs } = await import('../../shared/channel-config.js')
        const configs = loadChannelConfigs().filter(c => c.id !== channelId)
        saveChannelConfigs(configs)
        console.log(`[channel-manager] Channel "${channelId}" removed`)
      })

      ctx.on('channel:reconnect', async (channelId: string) => {
        const ch = channelMap.get(channelId)
        if (!ch) {
          console.warn(`[channel-manager] reconnect: channel "${channelId}" not found`)
          return
        }
        console.log(`[channel-manager] Reconnecting "${channelId}"...`)
        try {
          await ch.disconnect()
        } catch (err: any) {
          console.warn(`[channel-manager] disconnect before reconnect failed: ${err.message}`)
        }
        try {
          await ch.connect()
          console.log(`[channel-manager] "${channelId}" reconnected`)
        } catch (err: any) {
          console.error(`[channel-manager] "${channelId}" reconnect failed: ${err.message}`)
        }
      })

      // --- Helper: resolve UserRef for outbound messages ---

      function resolveUserRef(agentId: string, userId?: string): UserRef | null {
        // If we have a tracked ref for this agent, use it
        const tracked = lastUserByAgent.get(agentId)
        if (tracked) {
          // If userId matches or no userId specified, use tracked ref
          if (!userId || tracked.userId === userId) return tracked
          // userId specified but differs from tracked — use tracked channelId with specified userId
          return { userId, channelId: tracked.channelId }
        }
        // Fall back to global last user
        if (lastGlobalUser) {
          if (!userId || lastGlobalUser.userId === userId) return lastGlobalUser
          return { userId, channelId: lastGlobalUser.channelId }
        }
        // No ref available
        if (userId) {
          // Try first channel as fallback
          const firstChannel = channels[0]
          if (firstChannel) return { userId, channelId: firstChannel.id }
        }
        return null
      }

      // Permission cleanup interval
      cleanupInterval = setInterval(() => permissionMgr.cleanup(), 60_000)

      // --- Connect all channels ---
      for (const ch of channels) {
        try {
          await ch.connect()
          console.log(`[channel-manager] ${ch.label} connected`)
        } catch (err: any) {
          console.error(`[channel-manager] ${ch.label} connect failed: ${err.message}`)
        }
      }
    },

    async destroy() {
      if (cleanupInterval) clearInterval(cleanupInterval)
      // Disconnect all channels
      for (const ch of channels) {
        try {
          await ch.disconnect()
          console.log(`[channel-manager] ${ch.label} disconnected`)
        } catch (err: any) {
          console.error(`[channel-manager] ${ch.label} disconnect failed: ${err.message}`)
        }
      }
    },
  }
}

/**
 * Build the message content string sent to the spoke agent.
 * Includes channel info and handles media/voice messages.
 */
function buildMessageContent(msg: IncomingChannelMessage, routedText: string): string {
  const tag = `[${msg.channelType} ${msg.userId}]`
  if (msg.type === 'voice' && msg.voiceText) return `${tag} (\u8BED\u97F3\u8F6C\u6587\u5B57) ${msg.voiceText}`
  if (msg.type === 'voice') return `${tag} (\u8BED\u97F3\u6D88\u606F\uFF0C\u65E0\u6CD5\u8BC6\u522B)`
  if (msg.mediaPath) return `${tag} (${msg.type} \u5DF2\u4E0B\u8F7D\u5230 ${msg.mediaPath})`
  if (msg.type !== 'text') return `${tag} (${msg.type} \u6D88\u606F\uFF0C\u4E0B\u8F7D\u5931\u8D25)`
  return `${tag} ${routedText}`
}
