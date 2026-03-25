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
  userId?: string // originating user who triggered the action
}

// Spoke → Hub: 状态上报
export interface SpokeToHubStatus {
  type: 'status'
  agentId: string
  status: 'ready' | 'busy' | 'error'
}

// Hub → Spoke: management result
export interface HubToSpokeManagementResult {
  type: 'management_result'
  requestId: string
  success: boolean
  data?: any
  error?: string
}

// Spoke → Hub: management request
export interface SpokeToHubManagement {
  type: 'management'
  agentId: string
  requestId: string
  action: 'register' | 'deregister' | 'start' | 'stop' | 'list'
  params?: {
    name?: string
    cwd?: string
    claudeArgs?: string[]
  }
}

// Spoke → Hub: 首条消息，注册 agentId
export interface SpokeToHubRegister {
  type: 'register'
  agentId: string
}

export type HubToSpoke = HubToSpokeMessage | HubToSpokePermission | HubToSpokeManagementResult

// Spoke → Hub: 心跳
export interface SpokeToHubHeartbeat {
  type: 'heartbeat'
  agentId: string
}

export type SpokeToHub = SpokeToHubRegister | SpokeToHubReply | SpokeToHubPermissionRequest | SpokeToHubStatus | SpokeToHubPermissionTimeout | SpokeToHubManagement | SpokeToHubHeartbeat

// Agent 配置
export interface AgentConfig {
  name: string           // 显示名，如 "brain"
  cwd: string            // 工作目录
  claudeArgs?: string[]  // 额外 claude CLI 参数
  createdAt: string
  autoStart?: boolean    // hub 启动时自动拉起
  autoMode?: boolean     // 启用 CC auto-mode（自动批准安全操作，默认 true）
}

// --- Monitor 协议（Web UI 观察者） ---

export interface MonitorRegister {
  type: 'register_monitor'
}

export interface HubEventData {
  kind: 'agent_online' | 'agent_offline' | 'message_in' | 'message_out'
    | 'permission_request' | 'permission_verdict' | 'agent_started' | 'agent_stopped'
  agentId: string
  timestamp: string
  userId?: string
  text?: string
  toolName?: string
  behavior?: string
  code?: number
}

export interface HubEvent {
  type: 'hub_event'
  event: HubEventData
}

// agents.json 结构
export interface AgentsConfig {
  defaultAgent: string   // 无 @前缀时路由到的 agent
  agents: Record<string, AgentConfig>
}
