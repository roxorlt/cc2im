import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HubSocketServer } from './socket-server.js'
import type { AgentManager } from './agent-manager.js'
import type { Router } from './router.js'
import type { HubContext } from '../shared/plugin.js'
import type { AgentsConfig, HubToSpoke, HubEventData } from '../shared/types.js'
import type { Cc2imChannel } from '../shared/channel.js'

export class HubContextImpl extends EventEmitter implements HubContext {
  private channels = new Map<string, Cc2imChannel>()

  constructor(
    private socketServer: HubSocketServer,
    private agentManager: AgentManager,
    private router: Router,
    private config: AgentsConfig,
  ) {
    super()
  }

  deliverToAgent(agentId: string, msg: HubToSpoke): boolean {
    const messageId = randomUUID()
    this.emit('deliver:before', agentId, msg, messageId)
    const ok = this.socketServer.send(agentId, msg)
    this.emit('deliver:after', messageId, ok)
    return ok
  }

  broadcastMonitor(event: HubEventData): void {
    this.socketServer.broadcast(event)
  }

  getConnectedAgents(): string[] {
    return this.socketServer.getConnectedAgents()
  }

  getAgentManager(): AgentManager {
    return this.agentManager
  }

  getRouter(): Router {
    return this.router
  }

  getConfig(): AgentsConfig {
    return this.config
  }

  registerChannel(channel: Cc2imChannel): void {
    this.channels.set(channel.id, channel)
  }

  getChannel(channelId: string): Cc2imChannel | undefined {
    return this.channels.get(channelId)
  }

  getChannels(): Cc2imChannel[] {
    return Array.from(this.channels.values())
  }

  async addChannel(type: string, channelId: string, accountName: string): Promise<void> {
    this.emit('channel:add', type, channelId, accountName)
  }

  async removeChannel(channelId: string): Promise<void> {
    const ch = this.channels.get(channelId)
    if (ch) {
      await ch.disconnect()
      this.channels.delete(channelId)
    }
    this.emit('channel:remove', channelId)
  }
}
