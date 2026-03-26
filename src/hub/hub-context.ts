import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { HubSocketServer } from './socket-server.js'
import type { AgentManager } from './agent-manager.js'
import type { Router } from './router.js'
import type { HubContext } from '../shared/plugin.js'
import type { AgentsConfig, HubToSpoke, HubEventData } from '../shared/types.js'

export class HubContextImpl extends EventEmitter implements HubContext {
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
}
