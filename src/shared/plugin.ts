import type { EventEmitter } from 'node:events'
import type { AgentManager } from '../hub/agent-manager.js'
import type { Router } from '../hub/router.js'
import type { AgentsConfig, HubToSpoke, HubEventData } from './types.js'
import type { Cc2imChannel } from './channel.js'

/** Hub services and events available to plugins */
export interface HubContext extends EventEmitter {
  deliverToAgent(agentId: string, msg: HubToSpoke): boolean
  broadcastMonitor(event: HubEventData): void
  getConnectedAgents(): string[]
  getAgentManager(): AgentManager
  getRouter(): Router
  getConfig(): AgentsConfig

  /** Register a channel (called by ChannelManager during init) */
  registerChannel(channel: Cc2imChannel): void
  /** Look up a channel by its instance ID */
  getChannel(channelId: string): Cc2imChannel | undefined
  /** Get all registered channels */
  getChannels(): Cc2imChannel[]

  /** Add a channel at runtime (persists to channels.json) */
  addChannel(type: string, channelId: string, accountName: string): Promise<void>
  /** Remove a channel at runtime (persists to channels.json) */
  removeChannel(channelId: string): Promise<void>
  /** Reconnect a channel (disconnect + connect with fresh credentials) */
  reconnectChannel(channelId: string): Promise<void>
}

/** Plugin definition */
export interface Cc2imPlugin {
  name: string
  init(ctx: HubContext): Promise<void> | void
  destroy(): Promise<void> | void
}
