/**
 * WebChannel — built-in channel backing the dashboard chat input.
 *
 * Inbound: the dashboard POSTs /api/chat → injectIncoming() fires the same
 * onMessage pipeline as any IM channel (routing, persistence, pending-ack).
 * Outbound: sendText/sendFile are no-ops — channel-manager already broadcasts
 * message_out to monitors before calling them, and the dashboard renders
 * replies from that monitor stream. Delivering here would double-send.
 */

import type { Cc2imChannel, ChannelStatus, IncomingChannelMessage } from '../../shared/channel.js'

export const WEB_CHANNEL_ID = 'web'
export const WEB_USER_ID = 'dashboard'

export class WebChannel implements Cc2imChannel {
  readonly id = WEB_CHANNEL_ID
  readonly type = 'web' as const
  readonly label = '面板·Web'

  private handler: ((msg: IncomingChannelMessage) => Promise<void>) | null = null

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  getStatus(): ChannelStatus {
    // In-process channel — alive as long as the hub is
    return 'connected'
  }

  async sendText(_userId: string, _text: string): Promise<void> {}
  async sendFile(_userId: string, _filePath: string): Promise<void> {}
  async startTyping(_userId: string): Promise<void> {}
  async stopTyping(_userId: string): Promise<void> {}

  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void {
    this.handler = handler
  }

  onStatusChange(_handler: (status: ChannelStatus, detail?: string) => void): void {}

  /** Inject a dashboard-originated message into the normal routing pipeline. */
  async injectIncoming(text: string, userId: string = WEB_USER_ID): Promise<void> {
    if (!this.handler) throw new Error('WebChannel not wired to channel-manager yet')
    await this.handler({
      channelId: this.id,
      channelType: this.type,
      userId,
      text,
      type: 'text',
      timestamp: new Date(),
    })
  }
}
