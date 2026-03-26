# Plugin Architecture Refactor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 重构 cc2im 为「核心 + 插件」架构——核心只做 hub-spoke 通信和 agent 管理，WeChat 连接、Web 面板等功能以插件形式加载。后续新功能（消息持久化、定时任务）均以插件方式添加，不膨胀核心。

**Architecture:** Hub 核心暴露 HubContext 事件接口，PluginManager 在启动时加载 `src/plugins/` 下的插件模块。每个插件通过 `init(ctx)` 注册事件监听，通过 `destroy()` 清理资源。重构过程是纯搬迁——不改行为只搬代码，每步可独立验证。

**Tech Stack:** Node.js 22+, TypeScript, EventEmitter, 现有依赖不变

---

## 架构设计

### 重构前

```
src/hub/index.ts (371 行大函数)
  ├── Router           消息路由
  ├── WeixinConnection 微信连接 + 收发 + 权限
  ├── AgentManager     Agent 生命周期
  ├── HubSocketServer  Unix socket 通信
  └── 权限状态管理      pendingPermissions[]
```

hub/index.ts 是一个 371 行的 `startHub()` 函数，直接 import 并 wire 所有模块。添加新功能（如消息持久化）必须修改这个文件。

### 重构后

```
src/
├── hub/                        # 核心（精简后 ~250 行）
│   ├── index.ts               入口：创建核心 → 加载插件 → 启动
│   ├── hub-context.ts         HubContext 实现（事件发射 + 服务暴露）
│   ├── plugin-manager.ts      插件加载器
│   ├── socket-server.ts       不变
│   ├── agent-manager.ts       不变
│   ├── router.ts              不变
│   └── launchd.ts             不变
│
├── plugins/                    # 内置插件
│   ├── weixin/                微信 IM 连接器
│   │   ├── index.ts          插件入口（init/destroy）
│   │   ├── connection.ts     原 hub/weixin.ts
│   │   ├── chunker.ts        原 hub/chunker.ts
│   │   ├── media.ts          原 hub/media.ts
│   │   └── permission.ts     权限状态管理（从 hub/index.ts 提取）
│   │
│   └── web-monitor/           Web 监控面板
│       ├── index.ts          插件入口
│       ├── server.ts         原 web/index.ts
│       ├── monitor-client.ts 原 web/monitor-client.ts
│       ├── log-tailer.ts     原 web/log-tailer.ts
│       ├── token-stats.ts    原 web/token-stats.ts
│       ├── stats-reader.ts   原 web/stats-reader.ts
│       └── frontend-v2/      原 web/frontend-v2/（整个目录搬迁）
│
├── spoke/                      # 不变
├── shared/                     # 加 Plugin 类型定义
└── cli.ts                      # 微调 import 路径
```

### 插件接口

```typescript
// shared/plugin.ts
import type { EventEmitter } from 'node:events'
import type { AgentManager } from '../hub/agent-manager.js'
import type { HubSocketServer } from '../hub/socket-server.js'
import type { Router } from '../hub/router.js'
import type { AgentsConfig, SpokeToHub, HubToSpoke, HubEventData } from './types.js'

/** 插件可用的 Hub 服务和事件 */
export interface HubContext extends EventEmitter {
  // --- 服务 ---
  deliverToAgent(agentId: string, msg: HubToSpoke): boolean
  broadcastMonitor(event: HubEventData): void
  getConnectedAgents(): string[]
  getAgentManager(): AgentManager
  getRouter(): Router
  getConfig(): AgentsConfig

  // --- 事件（通过 EventEmitter on/emit）---
  // 'spoke:message'     (agentId: string, msg: SpokeToHub)  — spoke 发来的消息
  // 'agent:online'      (agentId: string)                   — spoke 注册成功
  // 'agent:offline'     (agentId: string)                   — spoke 断连
  // 'agent:evicted'     (agentId: string)                   — 心跳超时被踢
  // 'hub:ready'         ()                                  — hub 启动完成
  // 'hub:shutdown'      ()                                  — hub 关闭中
}

/** 插件接口 */
export interface Cc2imPlugin {
  name: string
  init(ctx: HubContext): Promise<void> | void
  destroy(): Promise<void> | void
}
```

### 事件流（重构后）

```
微信消息到达:
  WeixinPlugin.onWeixinMessage()
    → ctx.getRouter().route(text)
    → ctx.deliverToAgent(agentId, msg)
    → ctx.broadcastMonitor({ kind: 'message_in', ... })

Spoke 回复:
  Hub 收到 spoke 消息 → ctx.emit('spoke:message', agentId, msg)
    → WeixinPlugin 监听 → weixin.send(userId, text)
    → ctx.broadcastMonitor({ kind: 'message_out', ... })

Web 面板:
  WebMonitorPlugin.init()
    → 启动 HTTP server
    → ctx.on('spoke:message' | 'agent:online' | ...) → WebSocket broadcast
```

### 风险控制

| 风险 | 控制措施 |
|------|---------|
| 搬代码改坏逻辑 | 每个 task 只搬不改，行为不变 |
| import 路径出错 | 每步 `npx tsc --noEmit` 验证 |
| 微信消息中断 | 每步重启 hub + 微信发消息验证 |
| 插件加载顺序 | weixin 先于 web-monitor 初始化 |
| 在 feature branch 上做 | main 服务不受影响 |

---

## 任务列表

### Task 1: 定义插件接口和 HubContext 类型

**Files:**
- Create: `src/shared/plugin.ts`

**改动**：

```typescript
// src/shared/plugin.ts
import type { EventEmitter } from 'node:events'
import type { AgentManager } from '../hub/agent-manager.js'
import type { HubSocketServer } from '../hub/socket-server.js'
import type { Router } from '../hub/router.js'
import type { AgentsConfig, SpokeToHub, HubToSpoke, HubEventData } from './types.js'

/** 插件可用的 Hub 服务和事件 */
export interface HubContext extends EventEmitter {
  deliverToAgent(agentId: string, msg: HubToSpoke): boolean
  broadcastMonitor(event: HubEventData): void
  getConnectedAgents(): string[]
  getAgentManager(): AgentManager
  getRouter(): Router
  getConfig(): AgentsConfig
}

/** 插件定义 */
export interface Cc2imPlugin {
  name: string
  init(ctx: HubContext): Promise<void> | void
  destroy(): Promise<void> | void
}
```

**验证**：`npx tsc --noEmit`（新文件不影响现有代码）

**Commit**: `feat: define plugin interface and HubContext type`

---

### Task 2: 实现 HubContext 和 PluginManager

**Files:**
- Create: `src/hub/hub-context.ts`
- Create: `src/hub/plugin-manager.ts`

**hub-context.ts** — 包装 socket-server、agent-manager、router 为统一事件接口：

```typescript
// src/hub/hub-context.ts
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
```

**plugin-manager.ts** — 加载、初始化、销毁插件：

```typescript
// src/hub/plugin-manager.ts
import type { Cc2imPlugin, HubContext } from '../shared/plugin.js'

export class PluginManager {
  private plugins: Cc2imPlugin[] = []

  register(plugin: Cc2imPlugin) {
    this.plugins.push(plugin)
    console.log(`[plugin] Registered: ${plugin.name}`)
  }

  async initAll(ctx: HubContext) {
    for (const plugin of this.plugins) {
      try {
        await plugin.init(ctx)
        console.log(`[plugin] Initialized: ${plugin.name}`)
      } catch (err: any) {
        console.error(`[plugin] Failed to init "${plugin.name}": ${err.message}`)
      }
    }
  }

  async destroyAll() {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.destroy()
        console.log(`[plugin] Destroyed: ${plugin.name}`)
      } catch (err: any) {
        console.error(`[plugin] Failed to destroy "${plugin.name}": ${err.message}`)
      }
    }
  }
}
```

**验证**：`npx tsc --noEmit`

**Commit**: `feat: implement HubContext and PluginManager`

---

### Task 3: 重构 hub/index.ts — 接入 HubContext 事件

**Files:**
- Modify: `src/hub/index.ts`
- Modify: `src/hub/socket-server.ts`（加事件回调）

**这是最关键的一步**。目标：hub/index.ts 创建 HubContext，现有逻辑不变，但所有 spoke 消息通过 `ctx.emit('spoke:message')` 发射，agent 上下线通过 `ctx.emit('agent:online')` 等发射。

**socket-server.ts 改动**：加 `onAgentOnline` 和 `onAgentOffline` 回调，类似现有的 `onEvict`：

```typescript
// HubSocketServer 构造函数加两个可选回调
constructor(
  onMessage: (agentId: string, msg: SpokeToHub) => void,
  opts?: {
    onEvict?: (agentId: string) => void
    onAgentOnline?: (agentId: string) => void
    onAgentOffline?: (agentId: string) => void
  },
)

// register 处理中调用 onAgentOnline
// socket close 处理中调用 onAgentOffline
```

**hub/index.ts 改动**：

1. 创建 HubContext 和 PluginManager
2. 在 `onMessage` 回调中 emit `'spoke:message'`
3. 在 socket-server 回调中 emit agent 事件
4. 所有现有逻辑保持不变（weixin、permission、management 仍然直接处理）
5. 添加 `ctx.emit('hub:ready')` 和 `ctx.emit('hub:shutdown')`

重点：**这一步不搬任何代码**，只是在现有逻辑中穿插 `ctx.emit()`。WeChat 处理、权限管理全部留在 hub/index.ts。这确保行为零变化。

```typescript
// hub/index.ts 新增的 import
import { HubContextImpl } from './hub-context.js'
import { PluginManager } from './plugin-manager.js'

export async function startHub(options?: { autoStartAgents?: boolean }) {
  const config = loadAgentsConfig()
  const router = new Router(config)

  let socketServer: HubSocketServer
  const agentManager = new AgentManager(...)

  const pluginManager = new PluginManager()
  // 暂时不注册任何插件——后续 task 逐步搬迁

  socketServer = new HubSocketServer(
    async (agentId, msg) => {
      ctx.emit('spoke:message', agentId, msg)  // ← 新增：发射事件
      // ... 现有 switch/case 逻辑不变 ...
    },
    {
      onEvict: (agentId) => {
        ctx.emit('agent:evicted', agentId)  // ← 新增
        // ... 现有 auto-restart 逻辑不变 ...
      },
      onAgentOnline: (agentId) => ctx.emit('agent:online', agentId),
      onAgentOffline: (agentId) => ctx.emit('agent:offline', agentId),
    },
  )

  const ctx = new HubContextImpl(socketServer, agentManager, router, config)

  // ... 现有 weixin 处理逻辑全部不变 ...

  await socketServer.start()
  await pluginManager.initAll(ctx)  // ← 新增（目前无插件，no-op）

  // ... 现有启动逻辑不变 ...

  ctx.emit('hub:ready')

  const shutdown = async () => {
    ctx.emit('hub:shutdown')
    await pluginManager.destroyAll()
    // ... 现有关闭逻辑 ...
  }
}
```

**验证**：
1. `npx tsc --noEmit`
2. 重启 hub：`npx tsx src/cli.ts uninstall && npx tsx src/cli.ts install`
3. 微信发消息验证收发正常
4. 检查 hub.log 无异常

**Commit**: `refactor: wire HubContext events into hub/index.ts (no behavior change)`

---

### Task 4: 提取 web-monitor 插件

**风险最低的搬迁**——web 原本就是独立进程，改为 hub 内插件。

**Files:**
- Create: `src/plugins/web-monitor/index.ts`（插件入口）
- Move: `src/web/index.ts` → `src/plugins/web-monitor/server.ts`
- Move: `src/web/monitor-client.ts` → `src/plugins/web-monitor/monitor-client.ts`
- Move: `src/web/log-tailer.ts` → `src/plugins/web-monitor/log-tailer.ts`
- Move: `src/web/token-stats.ts` → `src/plugins/web-monitor/token-stats.ts`
- Move: `src/web/stats-reader.ts` → `src/plugins/web-monitor/stats-reader.ts`
- Move: `src/web/frontend-v2/` → `src/plugins/web-monitor/frontend-v2/`
- Modify: `src/hub/index.ts`（注册 web-monitor 插件）
- Modify: `src/cli.ts`（更新 `web` 命令的 import 路径）

**插件入口**：

```typescript
// src/plugins/web-monitor/index.ts
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'

const DEFAULT_PORT = 3721

export function createWebMonitorPlugin(port = DEFAULT_PORT): Cc2imPlugin {
  let server: any = null

  return {
    name: 'web-monitor',
    async init(ctx: HubContext) {
      const { startWeb } = await import('./server.js')
      server = await startWeb({ port })
      console.log(`[web-monitor] Dashboard at http://127.0.0.1:${port}`)
    },
    async destroy() {
      if (server) server.close()
    },
  }
}
```

**server.ts 改动**（原 web/index.ts）：
- 更新相对 import 路径（`./monitor-client.js`, `./log-tailer.js` 等）
- `startWeb()` 函数签名不变
- MonitorClient 仍然独立连接 hub socket（不依赖 HubContext 事件）

> 注意：web-monitor 作为 hub 内插件启动后，用户不再需要单独执行 `cc2im web`。Dashboard 随 hub 自动启动。`cc2im web` CLI 命令保留用于调试（独立启动 web server）。

**hub/index.ts 改动**：

```typescript
import { createWebMonitorPlugin } from '../plugins/web-monitor/index.js'

// 在 pluginManager 创建后注册
pluginManager.register(createWebMonitorPlugin())
```

**验证**：
1. `npx tsc --noEmit`
2. 重启 hub
3. 浏览器打开 `http://127.0.0.1:3721`，确认 dashboard 正常
4. 微信发消息，确认 dashboard 实时显示
5. 确认不再需要单独 `cc2im web`

**Commit**: `refactor: extract web-monitor as plugin`

---

### Task 5: 提取 weixin 插件

**最复杂的搬迁**。将微信连接、消息分段、媒体处理、权限状态管理从 hub/index.ts 提取到 `plugins/weixin/`。

**Files:**
- Create: `src/plugins/weixin/index.ts`（插件入口）
- Move: `src/hub/weixin.ts` → `src/plugins/weixin/connection.ts`
- Move: `src/hub/chunker.ts` → `src/plugins/weixin/chunker.ts`
- Move: `src/hub/media.ts` → `src/plugins/weixin/media.ts`
- Create: `src/plugins/weixin/permission.ts`（从 hub/index.ts 提取权限逻辑）
- Modify: `src/hub/index.ts`（删除 weixin/permission 相关代码，注册插件）
- Modify: `src/cli.ts`（更新 login 命令的 import 路径）

**插件入口**（核心设计）：

```typescript
// src/plugins/weixin/index.ts
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { WeixinConnection } from './connection.js'
import { PermissionManager } from './permission.js'

export function createWeixinPlugin(): Cc2imPlugin {
  let weixin: WeixinConnection
  let permissionMgr: PermissionManager
  let cleanupInterval: ReturnType<typeof setInterval>

  return {
    name: 'weixin',
    async init(ctx: HubContext) {
      weixin = new WeixinConnection()
      permissionMgr = new PermissionManager()

      // --- Spoke → WeChat：监听 spoke 消息 ---
      ctx.on('spoke:message', async (agentId: string, msg: any) => {
        switch (msg.type) {
          case 'reply':
            ctx.broadcastMonitor({ kind: 'message_out', agentId, userId: msg.userId, text: msg.text, timestamp: new Date().toISOString() })
            await weixin.send(msg.userId, msg.text)
            break
          case 'permission_request':
            permissionMgr.handleRequest(agentId, msg, ctx, weixin)
            break
          case 'status':
            console.log(`[hub] Agent ${agentId} status: ${msg.status}`)
            break
          case 'permission_timeout':
            permissionMgr.handleTimeout(msg.requestId)
            break
        }
      })

      // --- WeChat → Spoke：微信消息路由 ---
      weixin.setMessageHandler(async (weixinMsg) => {
        const userId = weixinMsg.userId

        // 权限审批检测
        if (permissionMgr.tryHandleVerdict(weixinMsg, userId, ctx)) return

        // 路由消息到 agent
        const router = ctx.getRouter()
        const routed = router.route(weixinMsg.text || '')
        const agentManager = ctx.getAgentManager()

        // 拦截命令（restart, effort）
        if (routed.intercepted) {
          // ... 命令处理逻辑（从 hub/index.ts 搬过来）...
          return
        }

        // 检查 agent 是否在线
        const connected = ctx.getConnectedAgents()
        if (!connected.includes(routed.agentId)) {
          await weixin.send(userId, `⚠ Agent "${routed.agentId}" 不在线。在线: ${connected.join(', ') || '无'}`)
          return
        }

        // 转发到 spoke
        const text = buildMessageContent(weixinMsg, routed.text)
        ctx.broadcastMonitor({ kind: 'message_in', agentId: routed.agentId, userId, text: routed.text, timestamp: new Date().toISOString() })
        ctx.deliverToAgent(routed.agentId, {
          type: 'message', userId, text,
          msgType: weixinMsg.type,
          mediaPath: weixinMsg.mediaPath ?? undefined,
          timestamp: weixinMsg.timestamp?.toISOString() ?? new Date().toISOString(),
        })
      })

      // 权限清理
      cleanupInterval = setInterval(() => permissionMgr.cleanup(), 60_000)

      // 登录并开始监听
      await weixin.login()
      weixin.startListening()
      await weixin.startPolling()
    },

    async destroy() {
      clearInterval(cleanupInterval)
      // weixin SDK cleanup if needed
    },
  }
}

function buildMessageContent(msg: any, routedText: string): string {
  // 原 hub/index.ts 的 buildMessageContent 函数，原样搬过来
  if (msg.type === 'voice' && msg.voiceText) return `[微信 ${msg.userId}] (语音转文字) ${msg.voiceText}`
  if (msg.type === 'voice') return `[微信 ${msg.userId}] (语音消息，无法识别)`
  if (msg.mediaPath) return `[微信 ${msg.userId}] (${msg.type} 已下载到 ${msg.mediaPath})`
  if (msg.type !== 'text') return `[微信 ${msg.userId}] (${msg.type} 消息，下载失败)`
  return `[微信 ${msg.userId}] ${routedText}`
}
```

**permission.ts**（从 hub/index.ts 提取的权限状态管理）：

```typescript
// src/plugins/weixin/permission.ts
import type { HubContext } from '../../shared/plugin.js'
import type { WeixinConnection } from './connection.js'

interface PendingPermission {
  requestId: string
  agentId: string
  toolName: string
  userId: string
  createdAt: number
}

const PERMISSION_TTL_MS = 6 * 60 * 1000
const SIMPLE_RE = /^\s*(y|yes|ok|好|批准|always|始终|总是|n|no|不|拒绝)\s*$/i

export class PermissionManager {
  private pending: PendingPermission[] = []

  handleRequest(agentId: string, msg: any, ctx: HubContext, weixin: WeixinConnection) {
    // 原 hub/index.ts permission_request 分支的逻辑，原样搬入
    // ...
  }

  tryHandleVerdict(weixinMsg: any, userId: string, ctx: HubContext): boolean {
    // 原 hub/index.ts 微信消息处理中的权限审批检测逻辑
    // 返回 true 表示已处理（是权限审批回复），false 表示不是
    // ...
  }

  handleTimeout(requestId: string) {
    // 原 hub/index.ts permission_timeout 逻辑
    // ...
  }

  cleanup() {
    // 原 cleanupStalePermissions 逻辑
    // ...
  }
}
```

**hub/index.ts 精简后**（~100 行）：

```typescript
import { HubContextImpl } from './hub-context.js'
import { PluginManager } from './plugin-manager.js'
import { HubSocketServer } from './socket-server.js'
import { Router } from './router.js'
import { AgentManager } from './agent-manager.js'
import { createWeixinPlugin } from '../plugins/weixin/index.js'
import { createWebMonitorPlugin } from '../plugins/web-monitor/index.js'

export async function startHub(options?: { autoStartAgents?: boolean }) {
  const config = loadAgentsConfig()
  const router = new Router(config)

  let socketServer: HubSocketServer
  const agentManager = new AgentManager(
    () => socketServer.getConnectedAgents(),
    (kind, agentId, extra) => ctx.broadcastMonitor({ kind: kind as any, agentId, timestamp: new Date().toISOString(), ...extra }),
  )

  const pluginManager = new PluginManager()

  socketServer = new HubSocketServer(
    (agentId, msg) => ctx.emit('spoke:message', agentId, msg),
    {
      onEvict: (agentId) => {
        ctx.emit('agent:evicted', agentId)
        const agentConfig = agentManager.getConfig().agents[agentId]
        if (agentConfig?.autoStart && agentManager.isManaged(agentId)) {
          console.log(`[hub] Auto-restarting evicted agent "${agentId}"`)
          setTimeout(() => agentManager.start(agentId), 5000)
        }
      },
      onAgentOnline: (agentId) => ctx.emit('agent:online', agentId),
      onAgentOffline: (agentId) => ctx.emit('agent:offline', agentId),
    },
  )

  const ctx = new HubContextImpl(socketServer, agentManager, router, config)

  // --- 注册插件 ---
  pluginManager.register(createWeixinPlugin())
  pluginManager.register(createWebMonitorPlugin())

  // --- 启动 ---
  await socketServer.start()
  await pluginManager.initAll(ctx)

  if (options?.autoStartAgents) {
    agentManager.startAutoAgents()
  }

  ctx.emit('hub:ready')

  const shutdown = async () => {
    console.log('[hub] Shutting down...')
    ctx.emit('hub:shutdown')
    await pluginManager.destroyAll()
    await agentManager.stopAll()
    socketServer.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
```

**注意事项**：
- `management` 类型的 spoke 消息（agent_register/start/stop/list）仍在核心处理——它们操作 agentManager，属于核心逻辑。在 `spoke:message` 事件发射前，hub/index.ts 先检查 `msg.type === 'management'` 并直接处理，不发射给插件
- `lastUserByAgent` 跟踪逻辑移入 weixin 插件
- `buildMessageContent()` 移入 weixin 插件
- CLI 的 `login` 命令需要更新 import 路径（`import { WeixinConnection } from '../plugins/weixin/connection.js'`）

**验证**：
1. `npx tsc --noEmit`
2. 重启 hub
3. **关键验证**：
   - 微信发普通消息 → 收到回复 ✓
   - 微信发 `@brain xxx` → 正确路由 ✓
   - 触发权限请求 → 微信收到审批提示 → 回复 yes → 操作执行 ✓
   - Dashboard 正常显示消息流 ✓
   - `cc2im login` 命令正常 ✓
4. 检查 hub.log 无异常

**Commit**: `refactor: extract weixin connector as plugin`

---

### Task 6: 清理遗留文件 + 更新文档

**Files:**
- Delete: `src/hub/weixin.ts`（已搬到 plugins/weixin/connection.ts）
- Delete: `src/hub/chunker.ts`（已搬到 plugins/weixin/chunker.ts）
- Delete: `src/hub/media.ts`（已搬到 plugins/weixin/media.ts）
- Delete: `src/web/index.ts`（已搬到 plugins/web-monitor/server.ts）
- Delete: `src/web/monitor-client.ts`（已搬到 plugins/web-monitor/）
- Delete: `src/web/log-tailer.ts`
- Delete: `src/web/token-stats.ts`
- Delete: `src/web/stats-reader.ts`
- Delete: `src/web/frontend-v2/`
- Keep: `src/web/frontend/`（v1 暂时保留，如不需要也可删除）
- Modify: `TODO.md`（标记 #2 完成）

**验证**：
1. `npx tsc --noEmit`
2. 最终重启验证一切正常

**Commit**: `chore: remove migrated files, update TODO`

---

### Task 7: 最终集成验证

**不写代码，只做验证**。

**验证清单**：

```bash
# 1. 编译
npx tsc --noEmit

# 2. 重新安装服务
npx tsx src/cli.ts uninstall && npx tsx src/cli.ts install

# 3. 等 hub + agents 启动
sleep 10 && tail -10 ~/.cc2im/hub.log

# 4. 检查插件加载日志
grep '\[plugin\]' ~/.cc2im/hub.log

# 5. 检查 dashboard
curl -s http://127.0.0.1:3721 | head -5

# 6. 检查进程
ps aux | grep 'spoke/index' | grep -v grep | wc -l

# 7. 微信消息测试（手动）
# 发送普通消息 → 收到回复
# 发送 @brain xxx → 收到回复
# 触发权限请求 → 微信审批
```

---

## 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | `npx tsc --noEmit` 无报错 | 编译检查 |
| 2 | Hub 启动日志显示 `[plugin] Initialized: weixin` 和 `[plugin] Initialized: web-monitor` | `grep plugin hub.log` |
| 3 | 微信普通消息收发正常 | 手动验证 |
| 4 | `@agent` 路由正常 | 微信发 `@brain test` |
| 5 | 权限审批流程正常 | 触发需要审批的操作 |
| 6 | Dashboard 自动随 hub 启动，`http://127.0.0.1:3721` 可访问 | 浏览器验证 |
| 7 | Dashboard 实时显示消息流和 agent 状态 | 发消息后看 dashboard |
| 8 | `cc2im login` 命令正常工作 | 执行命令 |
| 9 | Agent 自动重启正常（zombie 修复不受影响） | kill CC → 检查 spoke 退出 + 重启 |
| 10 | hub/index.ts 精简到 ~100 行，不再直接 import weixin/media/chunker | `wc -l src/hub/index.ts` + 检查 imports |
| 11 | `src/plugins/` 目录存在 weixin/ 和 web-monitor/ 两个插件 | `ls src/plugins/` |
| 12 | 旧文件已清理（src/hub/weixin.ts 等不存在） | `ls src/hub/weixin.ts` 报错 |

---

## 后续路线（不在本次范围内）

插件架构就位后，新功能以插件形式添加：

```
plugins/
├── weixin/          ← 本次搬迁
├── web-monitor/     ← 本次搬迁
├── persistence/     ← TODO #1：消息持久化 + SQLite
├── scheduler/       ← TODO #5：Hub 定时任务
├── token-stats/     ← TODO #4：成本指标（可从 web-monitor 拆出）
└── telegram/        ← 未来：Telegram IM 连接器
```

核心代码冻结在 ~250 行，所有新功能都是新插件。
