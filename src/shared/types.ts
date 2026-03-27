// Hub → Spoke: 新消息到达
export interface HubToSpokeMessage {
  type: 'message'
  userId: string
  text: string
  msgType: string // 'text' | 'image' | 'video' | 'file' | 'voice'
  mediaPath?: string // 媒体文件路径（hub 下载后传给 spoke）
  timestamp: string
  channelId?: string  // internal use: persistence tracks channel source
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

// Spoke → Hub: 发送文件/图片到微信
export interface SpokeToHubSendFile {
  type: 'send_file'
  agentId: string
  userId: string
  filePath: string
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
  action: 'register' | 'deregister' | 'start' | 'stop' | 'list' | 'cron_create' | 'cron_list' | 'cron_delete' | 'cron_update'
  params?: {
    name?: string
    cwd?: string
    claudeArgs?: string[]
    // cron fields
    scheduleType?: 'cron' | 'once' | 'interval'
    scheduleValue?: string
    timezone?: string
    agentId?: string
    message?: string
    jobId?: string
    enabled?: boolean
  }
}

// Spoke → Hub: 首条消息，注册 agentId
export interface SpokeToHubRegister {
  type: 'register'
  agentId: string
  pid?: number  // spoke 进程 PID，用于 hub-side kill
}

export type HubToSpoke = HubToSpokeMessage | HubToSpokePermission | HubToSpokeManagementResult

// Spoke → Hub: 心跳
export interface SpokeToHubHeartbeat {
  type: 'heartbeat'
  agentId: string
}

export type SpokeToHub = SpokeToHubRegister | SpokeToHubReply | SpokeToHubPermissionRequest | SpokeToHubStatus | SpokeToHubPermissionTimeout | SpokeToHubManagement | SpokeToHubHeartbeat | SpokeToHubSendFile

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
    | 'config_changed' | 'channel_status' | 'cron_fired'
  agentId: string
  timestamp: string
  userId?: string
  text?: string
  toolName?: string
  behavior?: string
  code?: number
  msgType?: string    // 'text' | 'image' | 'video' | 'file' | 'voice'
  mediaUrl?: string   // '/media/{filename}' — only for media messages
  channelId?: string    // source channel instance ID (e.g. "weixin-alice")
  channelType?: string  // channel platform type (e.g. "weixin", "telegram")
}

export interface HubEvent {
  type: 'hub_event'
  event: HubEventData
}

// agents.json 结构
export interface AgentsConfig {
  defaultAgent: string   // 无 @前缀时路由到的 agent
  agents: Record<string, AgentConfig>
  channelDefaults?: Record<string, string>  // channelId → defaultAgent
}

// --- Cron Scheduler 类型 ---

export interface CronJob {
  id: string
  name: string
  agentId: string
  scheduleType: 'cron' | 'once' | 'interval'
  scheduleValue: string   // cron 表达式 | ISO 时间戳 | 毫秒数
  timezone: string         // IANA 时区，默认系统时区
  message: string          // 发给 agent 的消息内容
  enabled: boolean
  nextRun: string | null   // ISO 时间戳
  createdAt: string
  createdBy: string        // 'dashboard' | agent 名
}

export interface CronRun {
  id: string
  jobId: string
  firedAt: string
  status: 'delivered' | 'queued' | 'failed'
  detail?: string
}
