# Channel 抽象层 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 cc2im 从"微信专用网关"升级为"多 channel IM 网关"，支持微信、Telegram 等多平台接入，同时保持 cc2im 独有的多 agent 优势。

**Architecture:** 在现有 Plugin 层之上抽象 Channel 接口。每个 IM 平台实现 Channel 接口，由 ChannelManager 统一管理生命周期。Router 扩展为 channel-aware，支持 channel:user → agent 路由映射。Dashboard 新增 channel 管理视图（连接状态、QR 码重登、用户列表）。

**Tech Stack:** TypeScript, EventEmitter, MCP, WebSocket (dashboard)

---

## 一、架构设计

### 1.1 现状分析

```
Hub (185行)
  ├── PluginManager
  │     ├── persistence (SQLite)
  │     ├── weixin (微信连接 + 路由 + 权限 + 媒体 — 全部耦合)
  │     └── web-monitor (Dashboard)
  ├── AgentManager (brain, 主线, geo, xq, KaaS)
  ├── Router (@mention → agent)
  └── SocketServer (spoke 通信)
```

**问题：**
- WeChat 是 plugin 不是 channel — 没有统一接口约束
- WeChat plugin 职责过重：连接管理 + 消息路由 + 权限管理 + 媒体发送 + typing indicator
- Router 不知道消息来自哪个 channel
- Dashboard 无 channel 状态展示
- 无法添加第二个 IM 平台

### 1.2 目标架构

```
Hub
  ├── PluginManager (不变)
  │     ├── persistence
  │     ├── channel-manager (新) — 管理所有 channel 的生命周期
  │     │     ├── WeixinChannel implements Cc2imChannel
  │     │     ├── TelegramChannel implements Cc2imChannel (未来)
  │     │     └── SlackChannel implements Cc2imChannel (未来)
  │     └── web-monitor (Dashboard + channel 管理页)
  │
  ├── AgentManager (不变)
  │     ├── brain, 主线, geo, xq, KaaS
  │
  ├── Router (扩展)
  │     ├── @mention → agent (保留)
  │     └── channel:user → defaultAgent 映射 (新)
  │
  └── SocketServer (不变)
```

### 1.3 Channel 接口设计

借鉴 NanoClaw 的简洁风格，结合 cc2im 的多 agent 需求：

```typescript
// src/shared/channel.ts

export type ChannelStatus = 'connected' | 'disconnected' | 'expired' | 'connecting'

export interface IncomingChannelMessage {
  channelId: string         // "weixin", "telegram"
  userId: string            // 平台原生用户 ID
  text?: string
  type: 'text' | 'image' | 'video' | 'voice' | 'file'
  mediaPath?: string
  voiceText?: string
  timestamp: Date
  raw?: any                 // 平台原始消息
}

export interface Cc2imChannel {
  /** 唯一标识，如 "weixin", "telegram" */
  readonly id: string
  /** 显示名，如 "微信", "Telegram" */
  readonly label: string

  // --- 生命周期 ---
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): ChannelStatus

  // --- 出站消息 ---
  sendText(userId: string, text: string): Promise<void>
  sendFile(userId: string, filePath: string): Promise<void>
  startTyping(userId: string): Promise<void>
  stopTyping(userId: string): Promise<void>

  // --- 入站消息回调 ---
  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void

  // --- 状态事件 ---
  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void
}
```

### 1.4 关键设计决策

**Q: Agent 和 Channel 的关系？**
A: **N:N**。任何 agent 都可以通过任何 channel 收发消息。路由规则：
- 用户 @mention 了 agent → 路由到指定 agent
- 没有 @mention → 按 channel 配置的 `defaultAgent` 路由
- 例：微信默认 → brain，Telegram 默认 → geo

**Q: 用户 ID 跨 channel 如何隔离？**
A: 内部用 `{channelId}:{platformUserId}` 作为全局唯一 ID。
- 微信用户 `o9cq80y...` → `weixin:o9cq80y...`
- Telegram 用户 `123456` → `telegram:123456`
- 消息持久化和 context token 都按此 key 隔离

**Q: Dashboard 如何展示 channel？**
A: 左侧边栏增加 channel 层级：
```
Channels
  ├── 微信 ● (connected)
  │     └── Agent 列表 (共享现有的)
  ├── Telegram ○ (disconnected)
  ...
```

**Q: 权限管理放哪？**
A: 保持在 channel plugin 内。不同 channel 的权限交互方式不同（微信回复 yes/no，Telegram inline button），不适合抽象。

**Q: Session 过期如何处理？**
A: Channel 通过 `onStatusChange('expired')` 通知。channel-manager 插件广播 monitor 事件，Dashboard 展示警告 + QR 码（微信特有）。

### 1.5 与现有代码的兼容策略

**渐进式重构，不破坏现有功能：**

1. 先创建 Channel 接口 + ChannelManager
2. 把 WeixinConnection 包装为 WeixinChannel（实现 Cc2imChannel）
3. 创建 channel-manager 插件，替代当前 weixin 插件的"胶水"职责
4. 当前 weixin 插件拆分为：WeixinChannel（连接/收发） + channel-manager（路由/权限/typing）
5. Router 增加 channelId 字段（向后兼容，可选）

---

## 二、开发计划

### Task 1: Channel 接口定义

**Files:**
- Create: `src/shared/channel.ts`

**Step 1: 创建 Channel 接口文件**

```typescript
// src/shared/channel.ts
export type ChannelStatus = 'connected' | 'disconnected' | 'expired' | 'connecting'

export interface IncomingChannelMessage {
  channelId: string
  userId: string
  text?: string
  type: 'text' | 'image' | 'video' | 'voice' | 'file'
  mediaPath?: string
  voiceText?: string
  timestamp: Date
  raw?: any
}

export interface Cc2imChannel {
  readonly id: string
  readonly label: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): ChannelStatus
  sendText(userId: string, text: string): Promise<void>
  sendFile(userId: string, filePath: string): Promise<void>
  startTyping(userId: string): Promise<void>
  stopTyping(userId: string): Promise<void>
  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void
  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void
}
```

**Step 2: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/shared/channel.ts
git commit -m "feat: define Cc2imChannel interface"
```

---

### Task 2: WeixinChannel — 包装现有 WeixinConnection

**Files:**
- Create: `src/plugins/weixin/weixin-channel.ts`
- Modify: `src/plugins/weixin/connection.ts` (小改，暴露 status)

**目标：** 把 WeixinConnection 包装为 Cc2imChannel 实现，不改变现有行为。

**Step 1: 实现 WeixinChannel**

```typescript
// src/plugins/weixin/weixin-channel.ts
import type { Cc2imChannel, ChannelStatus, IncomingChannelMessage } from '../../shared/channel.js'
import { WeixinConnection } from './connection.js'

export class WeixinChannel implements Cc2imChannel {
  readonly id = 'weixin'
  readonly label = '微信'
  private weixin: WeixinConnection
  private status: ChannelStatus = 'disconnected'
  private statusHandlers: Array<(status: ChannelStatus, detail?: string) => void> = []

  constructor() {
    this.weixin = new WeixinConnection()
  }

  async connect(): Promise<void> {
    this.setStatus('connecting')
    await this.weixin.login()
    this.weixin.restoreContextCache()
    this.weixin.startListening()
    this.weixin.startPolling().catch((err) => {
      console.error(`[weixin-channel] Polling error: ${err.message}`)
      this.setStatus('expired', err.message)
    })
    this.setStatus('connected')
  }

  async disconnect(): Promise<void> {
    this.weixin.saveContextCache()
    this.setStatus('disconnected')
  }

  getStatus(): ChannelStatus { return this.status }

  async sendText(userId: string, text: string): Promise<void> {
    await this.weixin.send(userId, text)
  }

  async sendFile(userId: string, filePath: string): Promise<void> {
    // 复用已有的 sendImage/sendFile 判断逻辑
    const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    if (IMAGE_EXTS.has(ext)) {
      await this.weixin.sendImage(userId, filePath)
    } else {
      await this.weixin.sendFile(userId, filePath)
    }
  }

  async startTyping(userId: string): Promise<void> {
    await this.weixin.startTyping(userId)
  }

  async stopTyping(userId: string): Promise<void> {
    await this.weixin.stopTyping(userId)
  }

  onMessage(handler: (msg: IncomingChannelMessage) => Promise<void>): void {
    this.weixin.setMessageHandler(async (msg) => {
      await handler({
        channelId: 'weixin',
        userId: msg.userId,
        text: msg.text,
        type: (msg.type || 'text') as any,
        mediaPath: msg.mediaPath ?? undefined,
        voiceText: msg.voiceText ?? undefined,
        timestamp: msg.timestamp || new Date(),
        raw: msg.raw,
      })
    })
  }

  onStatusChange(handler: (status: ChannelStatus, detail?: string) => void): void {
    this.statusHandlers.push(handler)
  }

  private setStatus(status: ChannelStatus, detail?: string) {
    this.status = status
    for (const h of this.statusHandlers) h(status, detail)
  }
}
```

**Step 2: TypeScript 检查 + Commit**

```bash
git add src/plugins/weixin/weixin-channel.ts
git commit -m "feat: WeixinChannel — wrap WeixinConnection as Cc2imChannel"
```

---

### Task 3: ChannelManager 插件

**Files:**
- Create: `src/plugins/channel-manager/index.ts`
- Modify: `src/hub/index.ts` — 注册 channel-manager 插件
- Modify: `src/shared/plugin.ts` — HubContext 增加 getChannels()

**目标：** 统一管理 channel 生命周期，替代当前 weixin 插件中的"胶水"逻辑。

**Step 1: HubContext 扩展**

```typescript
// src/shared/plugin.ts — 新增
import type { Cc2imChannel } from './channel.js'

export interface HubContext extends EventEmitter {
  // ... 现有方法不变 ...
  getChannel(channelId: string): Cc2imChannel | undefined
  getChannels(): Cc2imChannel[]
}
```

**Step 2: 创建 ChannelManager 插件**

```typescript
// src/plugins/channel-manager/index.ts
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import type { Cc2imChannel, IncomingChannelMessage } from '../../shared/channel.js'
import { PermissionManager } from '../weixin/permission.js'

const TYPING_ACK_DELAY_MS = 10_000

export function createChannelManagerPlugin(channels: Cc2imChannel[]): Cc2imPlugin {
  const channelMap = new Map<string, Cc2imChannel>()
  const pendingAck = new Map<string, { userId: string; channelId: string; timer: ReturnType<typeof setTimeout> }>()
  const lastUserByAgent = new Map<string, { userId: string; channelId: string }>()
  let lastGlobalUser: { userId: string; channelId: string } | null = null
  let permissionMgr: PermissionManager

  return {
    name: 'channel-manager',
    async init(ctx: HubContext) {
      permissionMgr = new PermissionManager()

      // Register all channels
      for (const ch of channels) {
        channelMap.set(ch.id, ch)

        // Status change → broadcast to monitor
        ch.onStatusChange((status, detail) => {
          ctx.broadcastMonitor({
            kind: 'channel_status' as any,
            agentId: ch.id,
            timestamp: new Date().toISOString(),
            text: `${ch.label}: ${status}${detail ? ' — ' + detail : ''}`,
          })
        })

        // Inbound messages → route to agent
        ch.onMessage(async (msg: IncomingChannelMessage) => {
          // 路由、权限、转发逻辑（从当前 weixin plugin 搬过来）
          // 用 msg.channelId 区分来源
          // 用 ctx.getRouter().route(msg.text) 找 agent
          // 用 ch.sendText() 回复
        })
      }

      // Outbound: spoke → channel
      ctx.on('spoke:message', async (agentId: string, msg: any) => {
        const target = lastUserByAgent.get(agentId)
        if (!target) return
        const ch = channelMap.get(target.channelId)
        if (!ch) return

        switch (msg.type) {
          case 'reply':
            clearPendingAck(agentId)
            await ch.sendText(msg.userId, msg.text)
            break
          case 'send_file':
            clearPendingAck(agentId)
            await ch.sendFile(msg.userId, msg.filePath)
            break
          // permission_request: 需要知道该发到哪个 channel
        }
      })

      // Connect all channels
      for (const ch of channels) {
        try {
          await ch.connect()
          console.log(`[channel-manager] ${ch.label} connected`)
        } catch (err: any) {
          console.error(`[channel-manager] ${ch.label} failed: ${err.message}`)
        }
      }

      // Typing ack helpers
      function clearPendingAck(agentId: string) { /* ... 同现有逻辑 ... */ }
      function startPendingAck(agentId: string, userId: string, channelId: string) { /* ... */ }

      // Permission cleanup
      setInterval(() => permissionMgr.cleanup(), 60_000)
    },

    async destroy() {
      for (const ch of channelMap.values()) {
        await ch.disconnect()
      }
    },
  }
}
```

**Step 3: Hub 注册 channel-manager 替代 weixin**

```typescript
// src/hub/index.ts
// 旧:
// pluginManager.register(createWeixinPlugin())

// 新:
import { WeixinChannel } from '../plugins/weixin/weixin-channel.js'
import { createChannelManagerPlugin } from '../plugins/channel-manager/index.js'

const weixinChannel = new WeixinChannel()
pluginManager.register(createChannelManagerPlugin([weixinChannel]))
```

**Step 4: TypeScript 检查 + Commit**

```bash
git add src/plugins/channel-manager/ src/hub/index.ts src/shared/plugin.ts
git commit -m "feat: ChannelManager plugin — unified channel lifecycle"
```

---

### Task 4: Router 扩展 — channel-aware 路由

**Files:**
- Modify: `src/hub/router.ts`
- Modify: `src/shared/types.ts` — AgentsConfig 增加 channel 默认 agent 映射

**Step 1: RouteResult 增加 channelId**

```typescript
// src/hub/router.ts
export interface RouteResult {
  agentId: string
  text: string
  unknownAgent: boolean
  intercepted?: { command: 'restart' | 'effort'; args?: string[] }
  channelId?: string  // 新增：消息来源 channel
}
```

**Step 2: route() 支持 channelId 参数**

```typescript
route(text: string, channelId?: string): RouteResult {
  // @mention 优先（不变）
  const match = text.match(/^@(\S+)\s+([\s\S]+)$/)
  if (match) { /* ... 现有逻辑不变 ... */ }

  // 没有 @mention → 按 channel 的 defaultAgent 路由
  const channelDefault = channelId
    ? this.config.channelDefaults?.[channelId]
    : undefined
  const agentId = channelDefault || this.config.defaultAgent

  return { agentId, text, unknownAgent: false, channelId }
}
```

**Step 3: AgentsConfig 增加 channelDefaults**

```typescript
// src/shared/types.ts
export interface AgentsConfig {
  defaultAgent: string
  agents: Record<string, AgentConfig>
  channelDefaults?: Record<string, string>  // 新增: channelId → defaultAgent
  // 例: { "weixin": "brain", "telegram": "geo" }
}
```

**Step 4: TypeScript 检查 + Commit**

```bash
git add src/hub/router.ts src/shared/types.ts
git commit -m "feat: channel-aware routing with per-channel defaultAgent"
```

---

### Task 5: Dashboard channel 状态展示

**Files:**
- Modify: `src/shared/types.ts` — HubEventData 增加 channel_status kind
- Modify: `src/plugins/web-monitor/server.ts` — channel 状态 API
- Modify: `src/plugins/web-monitor/frontend-v2/App.tsx` — channel 状态展示
- Modify: `src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts` — channel 状态 hook

**Step 1: HubEventData 增加 channel 事件**

```typescript
// src/shared/types.ts — HubEventData.kind 扩展
kind: '...' | 'channel_status'
// text 字段存状态描述: "微信: connected", "微信: expired — session timeout"
```

**Step 2: Dashboard Footer 展示 channel 状态**

在 Footer 现有的 `ws connected` 旁边，增加每个 channel 的状态指示灯：

```
cc2im v0.1.0 | USAGE ... | 微信 ● | ws ●
```

`●` 绿色 = connected，红色 = disconnected/expired

**Step 3: Session 过期时展示警告 Banner**

当某个 channel 状态变为 `expired`，在 Dashboard 顶部显示红色 banner：
```
⚠ 微信 session 已过期，需要重新扫码登录
```

**Step 4: Commit**

```bash
git add src/shared/types.ts src/plugins/web-monitor/
git commit -m "feat: dashboard channel status indicators + expiry warning"
```

---

### Task 6: 迁移测试 — 确保 WeChat 功能不变

**验证清单：**

1. Hub 启动 → WeixinChannel 自动连接 → Dashboard 显示 `微信 ●`
2. 微信发消息 → 路由到 defaultAgent → CC 回复 → 微信收到
3. @mention 路由正常（@geo xxx → geo agent）
4. 权限请求/审批正常
5. 消息持久化 + 离线投递正常
6. 媒体收发正常（图片/文件/语音）
7. typing indicator + 10s ack 正常
8. Agent 在线/离线事件正常
9. Dashboard 所有功能正常

```bash
# 编译 + 构建
npx tsc --noEmit
npx vite build

# 重启
pkill -f "cc2im"; sleep 2 && rm -f ~/.cc2im/hub.sock
npx tsx src/cli.ts start &>~/.cc2im/hub.log &

# 验证
curl -s http://127.0.0.1:3721/api/health
# 微信端测试发消息
```

**Step: 全部验证通过后 commit**

```bash
git add -A
git commit -m "test: verify channel abstraction migration — all WeChat features intact"
```

---

## 三、验收标准

### 功能验收

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 1 | Channel 接口定义完整 | `Cc2imChannel` 接口包含 connect/disconnect/sendText/sendFile/startTyping/stopTyping/onMessage/onStatusChange |
| 2 | WeixinChannel 实现 Cc2imChannel | 所有微信收发功能通过 WeixinChannel 接口调用，不直接依赖 WeixinConnection |
| 3 | ChannelManager 统一管理 | Hub 通过 channel-manager 插件管理所有 channel，不再直接注册 weixin 插件 |
| 4 | channel-aware 路由 | agents.json 支持 `channelDefaults` 配置，不同 channel 可路由到不同默认 agent |
| 5 | Dashboard 展示 channel 状态 | Footer 显示每个 channel 的连接状态指示灯 |
| 6 | Session 过期告警 | channel 状态变为 `expired` 时，Dashboard 显示红色警告 banner |

### 兼容性验收（不可回退）

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 7 | 微信消息收发不变 | 发消息、收回复、@mention 路由全部正常 |
| 8 | 权限流不变 | permission_request → 微信审批 → permission_verdict 正常 |
| 9 | 媒体收发不变 | 图片/文件/语音 双向正常 |
| 10 | typing + ack 不变 | 10s 内无回复自动发"收到，正在处理..." |
| 11 | 离线投递不变 | agent 离线 → 消息排队 → 上线重放 |
| 12 | Dashboard 不变 | 消息流、日志、用量、agent 列表全部正常 |
| 13 | TypeScript 编译无报错 | `npx tsc --noEmit` 通过 |

### 架构验收

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 14 | 添加新 channel 只需实现接口 | 新建一个 MockChannel 实现 Cc2imChannel，注册到 ChannelManager，能正常收发 |
| 15 | 旧 weixin 插件可删除 | `src/plugins/weixin/index.ts` 的"胶水"逻辑全部迁移到 channel-manager |
| 16 | 用户 ID 隔离 | 内部使用 `channelId:userId` 格式，防止跨 channel 冲突 |

---

## 四、风险与注意事项

1. **渐进式迁移**：不要一步全换。先让 WeixinChannel + ChannelManager 与旧 weixin 插件并存测试，确认无问题后再删旧代码。
2. **Permission 交互差异**：微信通过回复 yes/no 审批权限，Telegram 可能用 inline button。PermissionManager 需要适配不同 channel 的交互方式，这在后续添加 Telegram channel 时处理。
3. **Context Token 隔离**：WeChat 的 context token 是 channel-specific，不要放到通用层。保持在 WeixinChannel 内部。
4. **QR 码重登**：Session 过期后在 Dashboard 展示 QR 码是微信特有功能。Channel 接口不定义 QR 码方法，而是通过 channel-specific 的 web API 暴露（如 `/api/channels/weixin/qr`）。
5. **Hub 核心不膨胀**：hub/index.ts 应保持 <200 行。channel 管理逻辑在 channel-manager 插件中，不进入 hub 核心。
