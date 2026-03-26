import { EventEmitter } from 'node:events'
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
    return this.socketServer.send(agentId, msg)
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
