import type { EventEmitter } from 'node:events'
import type { AgentManager } from '../hub/agent-manager.js'
import type { Router } from '../hub/router.js'
import type { AgentsConfig, HubToSpoke, HubEventData } from './types.js'

/** Hub services and events available to plugins */
export interface HubContext extends EventEmitter {
  deliverToAgent(agentId: string, msg: HubToSpoke): boolean
  broadcastMonitor(event: HubEventData): void
  getConnectedAgents(): string[]
  getAgentManager(): AgentManager
  getRouter(): Router
  getConfig(): AgentsConfig
}

/** Plugin definition */
export interface Cc2imPlugin {
  name: string
  init(ctx: HubContext): Promise<void> | void
  destroy(): Promise<void> | void
}
