/**
 * WeixinChannel — wraps WeixinConnection as a Cc2imChannel implementation.
 *
 * Composition adapter: translates between the WeChat-specific WeixinConnection
 * API and the platform-agnostic Cc2imChannel interface. Supports multi-instance
 * via constructor-injected id/label (e.g. "weixin-roxor", "weixin-family").
 */

import type {
  Cc2imChannel,
  ChannelStatus,
  IncomingChannelMessage,
} from '../../shared/channel.js'
import { WeixinConnection } from './connection.js'

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])

export class WeixinChannel implements Cc2imChannel {
  readonly id: string
  readonly type = 'weixin' as const
  readonly label: string

  private weixin: WeixinConnection
  private status: ChannelStatus = 'disconnected'
  private messageHandlers: Array<(msg: IncomingChannelMessage) => Promise<void>> = []
  private statusHandlers: Array<(status: ChannelStatus, detail?: string) => void> = []

  constructor(id = 'weixin', label = '微信') {
    this.id = id
    this.label = label
    this.weixin = new WeixinConnection()
  }

  // ── lifecycle ────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.setStatus('connecting')
    try {
      await this.weixin.login(this.id)
      this.weixin.restoreContextCache(this.id)
      this.registerMessageBridge()
      this.weixin.startListening()

      // startPolling is a long-running loop — fire-and-forget.
      // If it exits (session expired / network error), mark status.
      this.weixin.startPolling().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[${this.id}] Polling error: ${msg}`)
        this.setStatus('expired', msg)
      })

      this.setStatus('connected')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[${this.id}] Connect failed: ${msg}`)
      this.setStatus('disconnected', msg)
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.weixin.saveContextCache(this.id)
    this.weixin.stop()
    this.setStatus('disconnected')
  }

  getStatus(): ChannelStatus {
    return this.status
  }

  // ── outbound ─────────────────────────────────────────────────────

  async sendText(userId: string, text: string): Promise<void> {
    await this.weixin.send(userId, text)
  }

  async sendFile(userId: string, filePath: string): Promise<void> {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    if (IMAGE_EXTS.has(ext)) {
      await this.weixin.sendImage(userId, filePath)
    } else {
      await this.weixin.sendFile(userId, filePath)
    }
  }

  async startTyping(userId: string): Promise<void> {
    await this.weixin.startTyping(userId)
  }

  async stopTyping(userId: string): Promise<void> {
    await this.weixin.stopTyping(userId)
  }

  // ── inbound ──────────────────────────────────────────────────────

  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void {
    this.messageHandlers.push(handler)
  }

  // ── status events ────────────────────────────────────────────────

  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void {
    this.statusHandlers.push(handler)
  }

  // ── private ──────────────────────────────────────────────────────

  /**
   * Wire WeixinConnection's single-handler callback into our multi-handler
   * fan-out. Called once during connect(), before startListening().
   */
  private registerMessageBridge(): void {
    this.weixin.setMessageHandler(async (msg) => {
      const channelMsg: IncomingChannelMessage = {
        channelId: this.id,
        channelType: this.type,
        userId: msg.userId,
        text: msg.text,
        type: (msg.type || 'text') as IncomingChannelMessage['type'],
        mediaPath: msg.mediaPath ?? undefined,
        voiceText: msg.voiceText ?? undefined,
        timestamp: msg.timestamp || new Date(),
        raw: msg.raw,
      }

      for (const handler of this.messageHandlers) {
        try {
          await handler(channelMsg)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          console.error(`[${this.id}] Message handler error: ${errMsg}`)
        }
      }
    })
  }

  private setStatus(status: ChannelStatus, detail?: string): void {
    this.status = status
    for (const handler of this.statusHandlers) {
      try {
        handler(status, detail)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error(`[${this.id}] Status handler error: ${errMsg}`)
      }
    }
  }
}
