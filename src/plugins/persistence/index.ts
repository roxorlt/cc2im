import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { openDb, closeDb, storeInbound, storeOutbound, markDelivered, getPending, cleanup } from './db.js'
import type { HubToSpokeMessage } from '../../shared/types.js'

const REPLAY_DELAY_MS = 500
const CLEANUP_INTERVAL = 60 * 60 * 1000

export function createPersistencePlugin(): Cc2imPlugin {
  let cleanupTimer: ReturnType<typeof setInterval>
  const pendingDeliveries = new Map<string, { agentId: string; messageId: string }>()
  let replaying = false  // flag to skip storing replay messages

  return {
    name: 'persistence',
    init(ctx: HubContext) {
      openDb()
      console.log('[persistence] SQLite opened')

      // Store inbound messages before delivery
      ctx.on('deliver:before', (agentId: string, msg: any, deliveryId: string) => {
        if (msg.type !== 'message') return
        if (replaying) return  // don't re-store replayed messages
        if (msg.userId === 'system') return  // don't store system messages
        const m = msg as HubToSpokeMessage
        const dbId = storeInbound(agentId, m.userId, m.text, m.msgType, m.mediaPath)
        pendingDeliveries.set(deliveryId, { agentId, messageId: dbId })
      })

      // Mark delivered after successful send
      ctx.on('deliver:after', (deliveryId: string, delivered: boolean) => {
        const entry = pendingDeliveries.get(deliveryId)
        if (!entry) return
        pendingDeliveries.delete(deliveryId)
        if (delivered) {
          markDelivered(entry.messageId)
        }
      })

      // Store outbound replies for history
      ctx.on('spoke:message', (_agentId: string, msg: any) => {
        if (msg.type === 'reply') {
          storeOutbound(msg.agentId, msg.userId, msg.text)
        }
      })

      // Replay pending messages when agent comes online
      ctx.on('agent:online', async (agentId: string) => {
        const pending = getPending(agentId)
        if (pending.length === 0) return

        console.log(`[persistence] Replaying ${pending.length} queued message(s) to "${agentId}"`)

        // Send a heads-up first
        replaying = true
        ctx.deliverToAgent(agentId, {
          type: 'message',
          userId: 'system',
          text: `[系统] 你离线期间收到 ${pending.length} 条消息，正在回放：`,
          msgType: 'text',
          timestamp: new Date().toISOString(),
        })

        for (const msg of pending) {
          await new Promise(r => setTimeout(r, REPLAY_DELAY_MS))
          const ok = ctx.deliverToAgent(agentId, {
            type: 'message',
            userId: msg.userId,
            text: msg.text,
            msgType: msg.msgType,
            mediaPath: msg.mediaPath ?? undefined,
            timestamp: msg.createdAt,
          })
          if (ok) markDelivered(msg.id)
        }
        replaying = false

        console.log(`[persistence] Replay complete for "${agentId}"`)
      })

      // Periodic cleanup
      cleanupTimer = setInterval(() => {
        const { expired, deleted } = cleanup()
        if (expired > 0 || deleted > 0) {
          console.log(`[persistence] Cleanup: ${expired} expired, ${deleted} deleted`)
        }
      }, CLEANUP_INTERVAL)

      cleanup()  // Run once on startup
    },

    destroy() {
      if (cleanupTimer) clearInterval(cleanupTimer)
      closeDb()
      console.log('[persistence] SQLite closed')
    },
  }
}
