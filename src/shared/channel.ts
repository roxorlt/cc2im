/**
 * Channel abstraction — unified interface for IM platform instances.
 *
 * A "channel" is a platform INSTANCE (not type). You can have multiple
 * WeChat channels (weixin-alice, weixin-bob) each with its own
 * session, QR code, and user pool.
 */

export type ChannelStatus = 'connected' | 'disconnected' | 'expired' | 'connecting'

export type ChannelType = 'weixin' | 'telegram' | 'slack' | 'discord' | 'web'

/** Health snapshot for a channel — surfaced on the dashboard so long-poll
 *  stalls / reconnect churn are visible without tailing hub logs. */
export interface ChannelHealth {
  status: ChannelStatus
  consecutiveErrors: number    // errors since last successful receive (resets to 0 on message)
  totalErrors: number          // cumulative poll errors since connect
  stallCount: number           // times the stall threshold was hit
  reconnectCount: number       // auto-reconnect attempts (filled by channel-manager)
  lastReceiveAt?: string       // ISO — last inbound message
  lastSendAt?: string          // ISO — last outbound message
  connectedSince?: string      // ISO — when the current connection was established
}

export interface IncomingChannelMessage {
  channelId: string         // instance ID: "weixin-alice"
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
  /** Instance ID, e.g. "weixin-alice", "weixin-bob" */
  readonly id: string
  /** Platform type, e.g. "weixin". Determines UI icon and grouping */
  readonly type: ChannelType
  /** Display label, e.g. "Alice·微信" */
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

  // --- health (optional) ---
  /** Return a health snapshot, or undefined if the channel doesn't track health. */
  getHealth?(): ChannelHealth
}
