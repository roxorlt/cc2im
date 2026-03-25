import type { AgentsConfig } from '../shared/types.js'

export interface RouteResult {
  agentId: string
  text: string
  /** true when @mentioned an agent not in config */
  unknownAgent: boolean
  /** intercepted hub command (not forwarded to spoke) */
  intercepted?: { command: 'restart' | 'effort'; args?: string[] }
}

export class Router {
  constructor(private config: AgentsConfig) {}

  route(text: string): RouteResult {
    const match = text.match(/^@(\S+)\s+([\s\S]+)$/)
    if (match) {
      const name = match[1]
      const content = match[2].trim()

      if (this.config.agents[name]) {
        // Check for intercepted commands
        if (/^(重启|restart)$/i.test(content)) {
          return { agentId: name, text: content, unknownAgent: false, intercepted: { command: 'restart' } }
        }
        const effortMatch = content.match(/^\/effort\s+(\S+)$/i)
        if (effortMatch) {
          return { agentId: name, text: content, unknownAgent: false, intercepted: { command: 'effort', args: [effortMatch[1]] } }
        }
        return { agentId: name, text: content, unknownAgent: false }
      }

      // @name not found in config
      return { agentId: name, text, unknownAgent: true }
    }

    return { agentId: this.config.defaultAgent, text, unknownAgent: false }
  }

  getAgentNames(): string[] {
    return Object.keys(this.config.agents)
  }

  updateConfig(config: AgentsConfig) {
    this.config = config
  }
}
