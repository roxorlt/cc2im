// Hub → Spoke: 新消息到达
export interface HubToSpokeMessage {
  type: 'message'
  userId: string
  text: string
  msgType: string // 'text' | 'image' | 'video' | 'file' | 'voice'
  mediaPath?: string // 媒体文件路径（hub 下载后传给 spoke）
  timestamp: string
}

// Hub → Spoke: permission verdict（用户在微信回复了 yes/no）
export interface HubToSpokePermission {
  type: 'permission_verdict'
  requestId: string
  behavior: 'allow' | 'deny' | 'always'
  toolName?: string
}

// Spoke → Hub: permission 超时通知
export interface SpokeToHubPermissionTimeout {
  type: 'permission_timeout'
  agentId: string
  requestId: string
}

// Spoke → Hub: 回复微信消息
export interface SpokeToHubReply {
  type: 'reply'
  agentId: string
  userId: string
  text: string
}

// Spoke → Hub: 转发 permission request 到微信
export interface SpokeToHubPermissionRequest {
  type: 'permission_request'
  agentId: string
  requestId: string
  toolName: string
  description: string
  inputPreview: string
}

// Spoke → Hub: 状态上报
export interface SpokeToHubStatus {
  type: 'status'
  agentId: string
  status: 'ready' | 'busy' | 'error'
}

export type HubToSpoke = HubToSpokeMessage | HubToSpokePermission

export type SpokeToHub = SpokeToHubReply | SpokeToHubPermissionRequest | SpokeToHubStatus | SpokeToHubPermissionTimeout

// Agent 配置
export interface AgentConfig {
  name: string           // 显示名，如 "brain"
  cwd: string            // 工作目录
  claudeArgs?: string[]  // 额外 claude CLI 参数
  createdAt: string
  autoStart?: boolean    // hub 启动时自动拉起
}

// agents.json 结构
export interface AgentsConfig {
  defaultAgent: string   // 无 @前缀时路由到的 agent
  agents: Record<string, AgentConfig>
}
