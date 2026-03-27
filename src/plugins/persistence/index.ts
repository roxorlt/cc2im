import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { openDb, closeDb, storeInbound, storeOutbound, markDelivered, getPending, cleanup } from './db.js'
import type { HubToSpokeMessage } from '../../shared/types.js'

const REPLAY_DELAY_MS = 500
const CLEANUP_INTERVAL = 60 * 60 * 1000

/**
 * Replay pending messages for an agent. Safe to call multiple times —
 * only replays messages not yet marked as delivered.
 */
async function doReplay(ctx: HubContext, agentId: string): Promise<number> {
  const pending = getPending(agentId)
  if (pending.length === 0) return 0

  console.log(`[persistence] Replaying ${pending.length} queued message(s) to "${agentId}"`)

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

  console.log(`[persistence] Replay complete for "${agentId}"`)
  return pending.length
}

export function createPersistencePlugin(): Cc2imPlugin {
  let cleanupTimer: ReturnType<typeof setInterval>
  const pendingDeliveries = new Map<string, { agentId: string; messageId: string }>()

  return {
    name: 'persistence',
    init(ctx: HubContext) {
      openDb()
      console.log('[persistence] SQLite opened')

      // Store inbound messages before delivery (skip system messages)
      ctx.on('deliver:before', (agentId: string, msg: any, deliveryId: string) => {
        if (msg.type !== 'message') return
        if (msg.userId === 'system') return
        const m = msg as HubToSpokeMessage
        const dbId = storeInbound(agentId, m.userId, m.text, m.msgType, m.mediaPath, m.channelId)
        pendingDeliveries.set(deliveryId, { agentId, messageId: dbId })
      })

      // Mark delivered after successful socket send
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

      // Primary replay: when agent comes online
      // Works when WeChat context tokens are restored from cache
      ctx.on('agent:online', (agentId: string) => {
        doReplay(ctx, agentId).catch((err) => {
          console.error(`[persistence] Replay failed for "${agentId}":`, err instanceof Error ? err.message : String(err))
        })
      })

      // Periodic cleanup
      cleanupTimer = setInterval(() => {
        const { expired, deleted } = cleanup()
        if (expired > 0 || deleted > 0) {
          console.log(`[persistence] Cleanup: ${expired} expired, ${deleted} deleted`)
        }
      }, CLEANUP_INTERVAL)

      cleanup()
    },

    destroy() {
      if (cleanupTimer) clearInterval(cleanupTimer)
      closeDb()
      console.log('[persistence] SQLite closed')
    },
  }
}
