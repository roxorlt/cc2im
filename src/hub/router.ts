import type { AgentsConfig } from '../shared/types.js'

export class Router {
  constructor(private config: AgentsConfig) {}

  /**
   * 解析消息文本，提取 @agentName 和实际内容
   * "@brain 收录这篇文章" → { agentId: "brain", text: "收录这篇文章" }
   * "今天天气" → { agentId: config.defaultAgent, text: "今天天气" }
   */
  route(text: string): { agentId: string; text: string } {
    const match = text.match(/^@(\S+)\s+(.+)$/s)
    if (match) {
      const name = match[1]
      if (this.config.agents[name]) {
        return { agentId: name, text: match[2] }
      }
      // @名字不存在 → 仍然路由到 default，保留原文
    }
    return { agentId: this.config.defaultAgent, text }
  }

  updateConfig(config: AgentsConfig) {
    this.config = config
  }
}
