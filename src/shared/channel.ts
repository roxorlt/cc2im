/**
 * Channel abstraction — unified interface for IM platform instances.
 *
 * A "channel" is a platform INSTANCE (not type). You can have multiple
 * WeChat channels (weixin-roxor, weixin-family) each with its own
 * session, QR code, and user pool.
 */

export type ChannelStatus = 'connected' | 'disconnected' | 'expired' | 'connecting'

export type ChannelType = 'weixin' | 'telegram' | 'slack' | 'discord'

export interface IncomingChannelMessage {
  channelId: string         // instance ID: "weixin-roxor"
  channelType: ChannelType  // platform type: "weixin"
  userId: string            // platform-native user ID
  text?: string
  type: 'text' | 'image' | 'video' | 'voice' | 'file'
  mediaPath?: string
  voiceText?: string
  timestamp: Date
  raw?: any
}

export interface Cc2imChannel {
  /** Instance ID, e.g. "weixin-roxor", "weixin-family" */
  readonly id: string
  /** Platform type, e.g. "weixin". Determines UI icon and grouping */
  readonly type: ChannelType
  /** Display label, e.g. "roxor·微信" */
  readonly label: string

  // --- lifecycle ---
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): ChannelStatus

  // --- outbound ---
  sendText(userId: string, text: string): Promise<void>
  sendFile(userId: string, filePath: string): Promise<void>
  startTyping(userId: string): Promise<void>
  stopTyping(userId: string): Promise<void>

  // --- inbound ---
  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void

  // --- status events ---
  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void
}
