# cc2im Architecture & Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建一个 IM 网关，通过微信（未来可扩展其他 IM）对接多个本地 Claude Code CLI 实例，每个实例有独立的 workspace、skills、MCP servers。

**Architecture:** Hub/Spoke 架构。Hub 进程常驻后台（launchd），持有唯一的微信连接，负责消息路由和 agent 生命周期管理。每个 CC 实例加载一个 Spoke（MCP channel server），通过 Unix socket 与 Hub 通信。Hub 自身也挂载一个 CC 实例作为「管理员 agent」，处理无 @前缀的消息和自然语言管理指令。

**Tech Stack:** Node.js 22+, TypeScript, @modelcontextprotocol/sdk, @pinixai/weixin-bot, Unix domain sockets, launchd (macOS)

---

## 核心架构

```
手机微信
  ↓ iLink Bot API (long-poll)
  ↓
┌──────────────────────────────────────────────┐
│  cc2im-hub（常驻进程，launchd 托管）           │
│                                                │
│  ┌─────────────┐  ┌────────────────────────┐ │
│  │ WeixinBot   │  │ Agent Router           │ │
│  │ (唯一连接)   │  │ · @mention 解析        │ │
│  │             │  │ · binding 匹配         │ │
│  │             │  │ · permission 路由      │ │
│  └──────┬──────┘  └───────────┬────────────┘ │
│         │                     │               │
│  ┌──────▼─────────────────────▼────────────┐ │
│  │ Agent Manager                            │ │
│  │ · agents.json 读写                       │ │
│  │ · launchd plist 生成/加载/卸载            │ │
│  │ · 健康检查 (heartbeat)                   │ │
│  │ · presence 状态广播                      │ │
│  └──────┬──────────────────────┬────────────┘ │
│         │ Unix socket          │ Unix socket   │
└─────────┼──────────────────────┼──────────────┘
          ↓                      ↓
┌─────────────────┐  ┌─────────────────┐
│ cc2im-spoke     │  │ cc2im-spoke     │
│ (MCP channel    │  │ (MCP channel    │
│  server, stdio) │  │  server, stdio) │
│                 │  │                 │
│ Claude Code #1  │  │ Claude Code #2  │
│ cwd: ~/brain    │  │ cwd: ~/project  │
│ 知识库助手       │  │ 开发助手         │
└─────────────────┘  └─────────────────┘
```

## 从 cc2wx 继承的代码

以下模块从 cc2wx v1.3.1 直接搬入 spoke，逻辑不变：

| 模块 | cc2wx 位置 | cc2im 目标位置 | 改动 |
|------|-----------|--------------|------|
| 媒体下载 + AES 解密 | cc2wx.ts:31-106 | spoke/media.ts | 提取为独立模块 |
| 消息分段发送 | cc2wx.ts:217-233 | hub/chunker.ts | 移到 hub（统一出口） |
| Permission relay 逻辑 | cc2wx.ts:257-425 | spoke/permission.ts + hub/permission-router.ts | 拆分：spoke 处理 CC↔hub，hub 处理 hub↔微信 |
| Always-allow 持久化 | cc2wx.ts:148-174 | spoke/always-allow.ts | per-agent 独立文件 |
| 微信登录 | login.mjs | hub/login.ts | 基本不变 |

## 从 OpenClaw 借鉴的设计

| 设计 | OC 实现 | cc2im 简化版 |
|------|--------|-------------|
| **Multi-agent routing** | binding rules (sender/group/channel/account) | Phase 1 仅 @mention，Phase 2 加 binding 规则 |
| **Agent isolation** | 独立 workspace + agentDir + session store | 独立 cwd + 独立 always-allow + 独立 launchd plist |
| **Gateway daemon** | 单进程常驻，launchd/systemd | 同，launchd plist 自动生成 |
| **Session 管理** | session key + pruning + compaction | **不需要。** 每个 CC CLI 进程天然是隔离 session，compaction 由 CC 自动处理。OC 需要 session 隔离是因为多用户共享一个 LLM API，cc2im 每个 agent 是独立进程，不存在此问题 |
| **Presence** | agent 在线/离线/忙碌 | 简单三态：running / stopped / busy |
| **Command queue** | 消息排队防并发 | hub 层消息队列，per-agent 串行分发 |

## 不从 OpenClaw 搬的部分

- Agent runtime / LLM 调用循环 → CC CLI 自带
- Memory / compaction → CC CLI 自带
- Model failover → CC CLI 自带
- Web Control UI → Phase 3 再考虑
- Plugin 机制 → Phase 3 再考虑
- 多 IM 渠道抽象 → Phase 2 预留接口，不提前实现

---

## Phase 1: Hub/Spoke 基础通信 + 单 Agent

**目标：** 用 hub/spoke 架构替代 cc2wx 的单进程模式，单 agent 验证全链路通信。

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/hub/index.ts` (入口骨架)
- Create: `src/spoke/index.ts` (入口骨架)
- Create: `src/shared/types.ts` (共享类型)
- Create: `.gitignore`

**Step 1: 初始化 npm 项目**

```bash
cd ~/brain/30-projects/cc2im
npm init -y
```

修改 package.json：
```json
{
  "name": "cc2im",
  "version": "0.1.0",
  "description": "IM gateway for multiple local Claude Code instances",
  "type": "module",
  "bin": {
    "cc2im": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev:hub": "npx tsx src/hub/index.ts",
    "dev:spoke": "npx tsx src/spoke/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.1",
    "@pinixai/weixin-bot": "^1.2.0",
    "qrcode-terminal": "^0.12.0",
    "tsx": "^4.21.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "@types/node": "^22.0.0"
  }
}
```

**Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src"]
}
```

**Step 3: 创建共享类型 `src/shared/types.ts`**

Hub ↔ Spoke 通信协议（Unix socket 上的 JSON 消息）：

```typescript
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
  behavior: 'allow' | 'deny'
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
export type SpokeToHub = SpokeToHubReply | SpokeToHubPermissionRequest | SpokeToHubStatus

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
```

**Step 4: 创建 hub 入口骨架 `src/hub/index.ts`**

```typescript
import { AgentsConfig } from '../shared/types.js'

console.log('[cc2im-hub] Starting...')
// Phase 1: 骨架，后续 task 填充
```

**Step 5: 创建 spoke 入口骨架 `src/spoke/index.ts`**

```typescript
console.log('[cc2im-spoke] Starting...')
// Phase 1: 骨架，后续 task 填充
```

**Step 6: 创建 .gitignore**

```
node_modules/
dist/
*.js.map
.mcp.json
```

**Step 7: npm install + 验证编译**

```bash
npm install
npx tsc --noEmit
```

**Step 8: git init + 首次提交**

```bash
git init
git add .
git commit -m "chore: project scaffold"
```

---

### Task 2: Unix Socket 通信层

**Files:**
- Create: `src/shared/socket.ts`
- Create: `src/hub/socket-server.ts`
- Create: `src/spoke/socket-client.ts`
- Test: 手动启动 hub + spoke 验证双向通信

Hub 监听 Unix socket，每个 spoke 连接上来后注册 agentId。消息以换行分隔的 JSON 帧传输（ndjson）。

**Step 1: 共享 socket 工具 `src/shared/socket.ts`**

```typescript
import { createServer, createConnection, Socket } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

export const SOCKET_DIR = join(homedir(), '.cc2im')
export const HUB_SOCKET_PATH = join(SOCKET_DIR, 'hub.sock')

export function ensureSocketDir() {
  mkdirSync(SOCKET_DIR, { recursive: true })
}

// ndjson 帧编码/解码
export function encodeFrame(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data) + '\n')
}

export function createFrameParser(onFrame: (data: unknown) => void) {
  let buffer = ''
  return (chunk: Buffer) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) {
        try { onFrame(JSON.parse(line)) }
        catch (e) { console.error('[socket] Bad frame:', line) }
      }
    }
  }
}
```

**Step 2: Hub socket server `src/hub/socket-server.ts`**

```typescript
import { createServer, Socket } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'
import {
  HUB_SOCKET_PATH, ensureSocketDir, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { SpokeToHub, HubToSpoke } from '../shared/types.js'

interface ConnectedSpoke {
  agentId: string
  socket: Socket
}

export class HubSocketServer {
  private spokes = new Map<string, ConnectedSpoke>()
  private server = createServer()
  private onMessage: (agentId: string, msg: SpokeToHub) => void

  constructor(onMessage: (agentId: string, msg: SpokeToHub) => void) {
    this.onMessage = onMessage
  }

  start() {
    ensureSocketDir()
    if (existsSync(HUB_SOCKET_PATH)) unlinkSync(HUB_SOCKET_PATH)

    this.server.on('connection', (socket) => {
      let agentId: string | null = null

      const parser = createFrameParser((frame: any) => {
        // 第一条消息必须是注册
        if (!agentId && frame.type === 'register') {
          agentId = frame.agentId
          this.spokes.set(agentId, { agentId, socket })
          console.log(`[hub] Spoke registered: ${agentId}`)
          return
        }
        if (agentId) {
          this.onMessage(agentId, frame as SpokeToHub)
        }
      })

      socket.on('data', parser)
      socket.on('close', () => {
        if (agentId) {
          this.spokes.delete(agentId)
          console.log(`[hub] Spoke disconnected: ${agentId}`)
        }
      })
      socket.on('error', (err) => {
        console.error(`[hub] Socket error (${agentId}):`, err.message)
      })
    })

    this.server.listen(HUB_SOCKET_PATH, () => {
      console.log(`[hub] Listening on ${HUB_SOCKET_PATH}`)
    })
  }

  send(agentId: string, msg: HubToSpoke): boolean {
    const spoke = this.spokes.get(agentId)
    if (!spoke) return false
    spoke.socket.write(encodeFrame(msg))
    return true
  }

  getConnectedAgents(): string[] {
    return [...this.spokes.keys()]
  }

  stop() {
    this.server.close()
    if (existsSync(HUB_SOCKET_PATH)) unlinkSync(HUB_SOCKET_PATH)
  }
}
```

**Step 3: Spoke socket client `src/spoke/socket-client.ts`**

```typescript
import { createConnection, Socket } from 'node:net'
import {
  HUB_SOCKET_PATH, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { HubToSpoke, SpokeToHub } from '../shared/types.js'

export class SpokeSocketClient {
  private socket: Socket | null = null
  private agentId: string
  private onMessage: (msg: HubToSpoke) => void

  constructor(agentId: string, onMessage: (msg: HubToSpoke) => void) {
    this.agentId = agentId
    this.onMessage = onMessage
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(HUB_SOCKET_PATH, () => {
        // 注册
        this.socket!.write(encodeFrame({ type: 'register', agentId: this.agentId }))
        console.log(`[spoke:${this.agentId}] Connected to hub`)
        resolve()
      })

      const parser = createFrameParser((frame) => {
        this.onMessage(frame as HubToSpoke)
      })

      this.socket.on('data', parser)
      this.socket.on('error', reject)
      this.socket.on('close', () => {
        console.log(`[spoke:${this.agentId}] Disconnected from hub`)
      })
    })
  }

  send(msg: SpokeToHub) {
    this.socket?.write(encodeFrame(msg))
  }

  disconnect() {
    this.socket?.end()
  }
}
```

**Step 4: 手动验证**

```bash
# Terminal 1: 启动 hub
npx tsx -e "
import { HubSocketServer } from './src/hub/socket-server.js'
const s = new HubSocketServer((id, msg) => console.log('Got:', id, msg))
s.start()
"

# Terminal 2: 启动 spoke
npx tsx -e "
import { SpokeSocketClient } from './src/spoke/socket-client.js'
const c = new SpokeSocketClient('test', (msg) => console.log('Got:', msg))
await c.connect()
c.send({ type: 'reply', agentId: 'test', userId: 'u1', text: 'hello' })
"
```

**Step 5: 提交**

```bash
git add src/shared/socket.ts src/hub/socket-server.ts src/spoke/socket-client.ts
git commit -m "feat: hub/spoke Unix socket communication layer"
```

---

### Task 3: Hub 核心 — 微信连接 + 消息路由

**Files:**
- Create: `src/hub/weixin.ts` (微信连接 + 收发，从 cc2wx 搬)
- Create: `src/hub/router.ts` (@mention 解析 + 路由)
- Create: `src/hub/media.ts` (媒体下载，从 cc2wx 搬)
- Create: `src/hub/chunker.ts` (消息分段，从 cc2wx 搬)
- Modify: `src/hub/index.ts` (串联各模块)

**Step 1: 搬迁微信连接 `src/hub/weixin.ts`**

从 cc2wx.ts 提取 WeixinBot 相关逻辑：bot.login(), bot.run(), bot.onMessage(), bot.reply(), bot.send()。
包含 ALLOWED_USERS 白名单过滤。

**Step 2: 搬迁媒体下载 `src/hub/media.ts`**

从 cc2wx.ts:31-106 提取：downloadMedia(), parseAesKey(), detectExt(), cleanupMedia()。
不变，直接搬。

**Step 3: 搬迁消息分段 `src/hub/chunker.ts`**

从 cc2wx.ts:217-233 提取 splitIntoChunks() 逻辑。

**Step 4: 路由器 `src/hub/router.ts`**

```typescript
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
```

**Step 5: 串联 hub/index.ts**

Hub 启动流程：
1. 加载 agents.json
2. 启动 Unix socket server
3. 登录微信
4. 微信 onMessage → router.route() → socketServer.send(agentId, msg)
5. 收到 spoke 的 reply → 微信发送
6. 收到 spoke 的 permission_request → 微信发送
7. 微信收到 permission verdict → 路由回对应 spoke

**Step 6: 提交**

```bash
git commit -m "feat: hub core — weixin connection, message routing, media download"
```

---

### Task 4: Spoke 核心 — MCP Channel Server + Hub 桥接

**Files:**
- Create: `src/spoke/channel-server.ts` (MCP channel server，从 cc2wx 搬)
- Create: `src/spoke/permission.ts` (permission relay，从 cc2wx 搬，改为走 hub)
- Modify: `src/spoke/index.ts` (串联)

**Step 1: MCP channel server `src/spoke/channel-server.ts`**

从 cc2wx.ts 提取 MCP Server 创建 + tool 定义（weixin_reply）。
关键改动：weixin_reply 不直接发微信，而是通过 SpokeSocketClient 发到 hub。

**Step 2: Permission relay `src/spoke/permission.ts`**

从 cc2wx.ts:257-425 提取。
关键改动：
- permission_request → 不直接发微信，发到 hub（SpokeToHubPermissionRequest）
- permission verdict → 从 hub 收到（HubToSpokePermission），转发给 CC

**Step 3: Spoke 启动流程 `src/spoke/index.ts`**

1. 从环境变量/参数读取 agentId
2. 连接 hub Unix socket，注册 agentId
3. 启动 MCP channel server（stdio transport，给 CC 用）
4. hub 消息 → MCP channel notification → CC
5. CC weixin_reply → spoke → hub → 微信
6. CC permission_request → spoke → hub → 微信
7. 微信 verdict → hub → spoke → CC

**Step 4: 提交**

```bash
git commit -m "feat: spoke core — MCP channel server bridged to hub"
```

---

### Task 5: 端到端验证 — 单 Agent 全链路

**Files:**
- Create: `src/cli.ts` (CLI 入口)
- Create: `~/.cc2im/agents.json` (默认配置)

**Step 1: CLI 入口 `src/cli.ts`**

```
cc2im login        # 微信扫码登录（复用 cc2wx 的 login 逻辑）
cc2im hub          # 启动 hub（前台，调试用）
cc2im start        # 启动 hub + 所有 autoStart agent
cc2im agent start <name>  # 手动启动一个 agent
cc2im agent stop <name>   # 停止一个 agent
cc2im agent list          # 列出所有 agent 及状态
```

**Step 2: 默认 agents.json**

```json
{
  "defaultAgent": "brain",
  "agents": {
    "brain": {
      "name": "brain",
      "cwd": "/Users/roxor/brain",
      "claudeArgs": ["--effort", "max"],
      "createdAt": "2026-03-24",
      "autoStart": true
    }
  }
}
```

**Step 3: 手动端到端测试**

```bash
# Terminal 1: 启动 hub
npx tsx src/cli.ts hub

# Terminal 2: 启动 spoke（模拟 CC 加载 spoke）
npx tsx src/spoke/index.ts --agent-id brain

# 手机微信发消息 → hub 收到 → 路由到 spoke → CC 处理 → spoke → hub → 微信回复
```

**Step 4: 提交**

```bash
git commit -m "feat: CLI entry point + end-to-end single-agent verification"
```

---

## Phase 2: 多 Agent 路由 + 生命周期管理

### Task 6: Agent 生命周期管理

**Files:**
- Create: `src/hub/agent-manager.ts`
- Modify: `src/hub/index.ts`

Agent Manager 负责：
- 读写 `~/.cc2im/agents.json`
- 启动 agent: spawn `caffeinate -i claude --dangerously-load-development-channels server:cc2im-spoke ...` 子进程
- 停止 agent: 杀掉子进程
- 注册新 agent: 写入 agents.json + 可选立即启动
- 注销 agent: 停止 + 从 agents.json 删除
- 健康检查: 检测 spoke 是否已连接到 hub socket

**关键：** agent 启动时需要把 spoke 配置为 CC 的 MCP channel server。方式类似 cc2wx 的 ensureMcpJson()，在 agent 的 cwd 下写入 .mcp.json 指向 cc2im-spoke。

---

### Task 7: MCP 管理工具（Hub 的 CC 实例可调用）

**Files:**
- Modify: `src/spoke/channel-server.ts` (hub 的管理 spoke 增加管理工具)

Hub 自身的管理 CC 暴露的 MCP tools：

```
agent_register(name, cwd, claude_args?)  → 注册 agent
agent_deregister(name)                   → 注销（停止 + 删除）
agent_start(name)                        → 启动
agent_stop(name)                         → 停止
agent_list()                             → 列出所有 agent + 状态
weixin_reply(text, user_id?)             → 回复微信（原有）
```

这样用户可以在微信里说：
- "在 ~/brain/30-projects/cc2wx 注册一个叫 code 的 agent" → 管理 CC 理解意图 → 调用 agent_register
- "停止 code" → agent_stop
- "状态" → agent_list

---

### Task 8: @mention 路由 + Permission 路由

**Files:**
- Modify: `src/hub/router.ts` (完善路由逻辑)
- Modify: `src/hub/index.ts` (permission 路由)

路由增强：
1. `@brain 做个任务` → 路由到 brain agent
2. `@code 修个 bug` → 路由到 code agent
3. `今天天气` → 路由到 defaultAgent
4. `@不存在的名字 xxx` → 提示用户该 agent 不存在，列出可用 agent

Permission 路由：
- hub 维护 `pendingPermissions` map: requestId → agentId
- spoke 发来 permission_request 时，记录来源 agentId
- 微信用户回复 yes/no 时，根据 FIFO 或 explicit ID 找到对应 agentId，路由回正确的 spoke

---

### Task 9: Hub 拦截指令

**Files:**
- Modify: `src/hub/router.ts`

Hub 识别并拦截的特殊指令（不转发给 CC）：

- `@brain 重启` / `@brain restart` → agent_stop + agent_start（等效于 /clear，清空 context 重来）
- `@brain /effort min` → 修改 claudeArgs，重启 agent

其他所有消息（包括 /compact）直接透传给 spoke → CC，由 CC 自己处理。

> **设计决策：** 不做 /clear 指令。CC CLI 自带 context 自动 compact，真想重新开始直接说「重启」。每个 CC 进程天然是独立 session，不需要自建 session 管理层。

---

## Phase 3: 后台服务化

### Task 10: launchd 集成

**Files:**
- Create: `src/hub/launchd.ts`
- Modify: `src/cli.ts`

```
cc2im install     # 生成 hub 的 launchd plist，加载服务
cc2im uninstall   # 卸载服务
cc2im status      # 查看 hub + 所有 agent 的运行状态
cc2im logs        # tail -f hub 日志
```

Hub 的 launchd plist:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.cc2im.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>node</string>
    <string>/path/to/cc2im/dist/hub/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/.cc2im/hub.log</string>
  <key>StandardErrorPath</key><string>~/.cc2im/hub.error.log</string>
</dict>
</plist>
```

---

## 数据目录结构

```
~/.cc2im/
├── agents.json              # agent 配置
├── hub.sock                 # hub Unix socket
├── hub.log                  # hub 日志
├── hub.error.log
├── media/                   # 下载的媒体文件（共享）
│   └── {timestamp}.{ext}
├── agents/
│   ├── brain/
│   │   └── always-allow.json  # per-agent 的始终批准列表
│   └── code/
│       └── always-allow.json
└── LaunchAgents/            # 生成的 plist 文件
    └── com.cc2im.hub.plist
```

---

## cc2wx 的未来

cc2wx 继续作为轻量版维护：
- 不需要 hub/spoke 的用户继续用 `npx cc2wx start`
- cc2im 的 README 中说明：「如果你只需要单 agent，用 cc2wx 更简单」
- cc2wx 不再加新 feature，bug fix only

---

## 验收标准

### Phase 1 验收：单 Agent 全链路 ✅ 2026-03-24

每条验收用例需要实际执行并确认结果，不能仅凭代码逻辑判断。

**AC-1.1: TypeScript 编译通过**
```bash
npx tsc --noEmit
# 期望：无错误退出
```

**AC-1.2: Hub 启动并监听 socket**
```bash
npx tsx src/hub/index.ts &
sleep 2
test -S ~/.cc2im/hub.sock && echo "PASS" || echo "FAIL"
# 期望：PASS，hub.sock 文件存在
```

**AC-1.3: Spoke 连接 Hub 并注册**
```bash
# Hub 已启动
npx tsx src/spoke/index.ts --agent-id test-agent &
sleep 2
# 检查 hub 日志
grep "Spoke registered: test-agent" ~/.cc2im/hub.log && echo "PASS" || echo "FAIL"
```

**AC-1.4: 微信消息 → Hub → Spoke → CC**
```
1. 启动 hub（已登录微信）
2. 启动 spoke + CC（agent: brain, cwd: ~/brain）
3. 手机微信发送 "你好"
4. 验证：
   - hub 日志显示收到消息并路由到 brain
   - CC 收到 channel notification
   - CC 调用 weixin_reply 回复
   - 手机微信收到回复
```

**AC-1.5: 媒体消息处理**
```
1. 手机微信发送一张图片
2. 验证：
   - hub 日志显示下载成功，文件存在于 ~/.cc2im/media/
   - spoke 收到消息包含 mediaPath
   - CC 收到含文件路径的 channel notification
```

**AC-1.6: Permission Relay 全链路**
```
1. CC 执行需要权限的操作（如 Bash 命令）
2. 验证：
   - spoke 发送 permission_request 到 hub
   - hub 转发权限提示到微信
   - 手机微信收到 "🔐 Claude 请求权限" 消息
   - 微信回复 "yes"
   - hub 路由 verdict 回 spoke
   - spoke 转发给 CC
   - CC 继续执行操作
```

**AC-1.7: Always-allow 持久化**
```
1. 微信回复 "always" 批准某个工具
2. 验证 ~/.cc2im/agents/brain/always-allow.json 已写入
3. 重启 spoke
4. 同一工具再次请求权限
5. 验证：自动批准，微信不收到提示
```

**AC-1.8: 长消息分段**
```
1. CC 回复一条超过 2000 字的消息
2. 验证：微信收到多条分段消息，每段带 [1/N] 标记
```

**AC-1.9: Spoke 断连恢复**
```
1. 杀掉 spoke 进程
2. 验证：hub 日志显示 "Spoke disconnected: brain"
3. 微信发消息
4. 验证：hub 日志显示消息无法路由（agent 不在线）
5. 重启 spoke
6. 验证：hub 日志显示 "Spoke registered: brain"
7. 微信发消息
8. 验证：消息正常路由，CC 正常回复
```

---

### Phase 2 验收：多 Agent 路由 ✅ 2026-03-25

**AC-2.1: @mention 路由** ✅ 2026-03-25
```
1. 注册两个 agent: brain (cwd: ~/brain) 和 code (cwd: ~/brain/30-projects/cc2wx)
2. 启动两个 agent
3. 微信发 "@brain 你好" → 验证 brain 的 CC 收到消息
4. 微信发 "@code 你好" → 验证 code 的 CC 收到消息
5. 微信发 "你好"（无@）→ 验证 defaultAgent 收到消息
```

**AC-2.2: Agent 注册（通过微信自然语言）** ✅ 2026-03-25
```
1. 微信发 "注册一个 agent 叫 test，目录是 /tmp/test-agent"
2. 验证：
   - ~/.cc2im/agents.json 新增 test 条目
   - 微信收到确认消息
```

**AC-2.3: Agent 启停** ✅ 2026-03-25
```
1. 微信发 "启动 test"
2. 验证：test agent 的 CC 进程启动，spoke 注册到 hub
3. 微信发 "停止 test"
4. 验证：CC 进程终止，spoke 从 hub 断开
5. 微信发 "@test 你好"
6. 验证：hub 提示 agent 未在线
```

**AC-2.4: Agent 列表查询** ✅ 2026-03-25
```
1. 微信发 "状态" 或 "agent list"
2. 验证微信收到所有 agent 列表，包含：
   - agent 名称
   - 运行状态（running/stopped）
   - cwd 路径
```

**AC-2.5: Agent 注销** ✅ 2026-03-25
```
1. 微信发 "注销 test"
2. 验证：
   - agent 进程停止
   - ~/.cc2im/agents.json 中 test 条目已删除
```

**AC-2.6: @不存在的 agent** ✅ 2026-03-25
```
1. 微信发 "@nonexistent 你好"
2. 验证：微信收到提示 "agent nonexistent 不存在，可用的 agent: brain, code"
```

**AC-2.7: Permission 多 agent 路由** ✅ 2026-03-25
```
1. brain 和 demo 同时在运行
2. brain 已有 Bash always-allow，直接执行
3. demo 请求 Bash 权限 → 微信收到权限提示
4. 微信回复 "always" → 验证 verdict 正确路由回 demo（不是 brain）
```

**AC-2.8: 重启指令** ✅ 2026-03-25
```
1. 微信发 "@demo 重启"
2. 验证：
   - demo 的 CC 进程终止 (code 143)
   - 新的 CC 进程启动
   - spoke 重新注册到 hub
   - 微信发 "@demo 你是谁"
   - 新 CC 正常响应（context 已清空）
```

---

### Phase 3 验收：后台服务化 ✅ 2026-03-25

**AC-3.1: launchd 安装** ✅ 2026-03-25
```bash
cc2im install
# 验证：
launchctl list | grep cc2im && echo "PASS" || echo "FAIL"
test -f ~/Library/LaunchAgents/com.cc2im.hub.plist && echo "PASS" || echo "FAIL"
```

**AC-3.2: 关终端仍在线** ✅ 2026-03-25
```
1. cc2im install（已安装 launchd 服务）
2. 关闭所有终端窗口
3. 手机微信发消息
4. 验证：收到 CC 回复（hub 在后台运行）
```

**AC-3.3: 合盖不断线** ✅ 2026-03-25
```
1. MacBook 合盖 30 秒后打开
2. 手机微信发消息
3. 验证：收到 CC 回复（caffeinate 防休眠生效）
```

**AC-3.4: 崩溃自动重启** ✅ 2026-03-25
```bash
# 找到 hub 进程并杀掉
kill $(pgrep -f "cc2im.*hub")
sleep 5
# 验证 launchd 自动重启
pgrep -f "cc2im.*hub" && echo "PASS: restarted" || echo "FAIL: not restarted"
```

**AC-3.5: 卸载** ✅ 2026-03-25
```bash
cc2im uninstall
launchctl list | grep cc2im && echo "FAIL: still loaded" || echo "PASS: unloaded"
test -f ~/Library/LaunchAgents/com.cc2im.hub.plist && echo "FAIL: plist exists" || echo "PASS: cleaned"
```

**AC-3.6: 日志查看** ✅ 2026-03-25
```bash
cc2im logs
# 验证：输出 hub 的实时日志（tail -f）
```

---

### 全局验收（发布前 checklist）

- [x] `npm pack --dry-run` 不包含 `docs/plans/` 目录 ✅
- [x] `npm pack --dry-run` 不包含个人路径、API key、token ✅
- [x] README 包含安装说明、使用说明、架构图 ✅
- [x] `npx cc2im --help` 输出所有命令说明 ✅
- [x] cc2wx 仍然正常工作（未被破坏）✅

---

## 开发日志

### 2026-03-24: Phase 1 完成（AC-1.1 ~ AC-1.9）

全部 9 条验收用例通过。关键实现：
- Hub/Spoke Unix socket 通信
- 微信 iLink Bot 连接 + 消息转发
- MCP channel server（stdio transport）
- Permission relay 全链路（请求 → 微信弹窗 → verdict 回传）
- Always-allow 持久化（per-agent JSON）
- Structure-aware chunker（代码块/表格/段落边界感知，3 级降级）
- Spoke 自动重连（指数退避 3s→30s）

### 2026-03-25: Phase 2 全部通过（AC-2.1 ~ AC-2.8）

**AC-2.1 @mention 路由**：@brain / @test / 无@ 三种路由全部正确。

**AC-2.2 Agent 注册**：微信发自然语言指令，brain agent 调用 agent_register MCP 工具，成功写入 agents.json。

**AC-2.3 Agent 启停**：后台启动 agent 遇到多个问题并逐一解决：

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| CC 无法启动 | `script` 在非 tty 环境下 `tcgetattr` 失败 | 改用 `expect` 创建独立 pty |
| CC 卡在信任提示 | 新工作目录首次使用需要确认 | expect 脚本匹配 "confirm" 自动应答 |
| brain 收不到消息 | 多个 zombie spoke 进程竞争 socket 注册 | spoke 添加 stdin EOF 检测自动退出 |
| 重复注册导致死连接 | hub 存了旧 socket 引用 | hub 端 stale connection 替换 + close 事件安全检查 |

最终方案：`caffeinate -i expect start.exp`，expect 脚本创建 pty → 启动 CC → 自动应答信任 → 等待 EOF。

验证通过：启动 demo agent → spoke 注册 → @demo 收发消息 → 停止 → code 143 + spoke 断开。

AC-2.3 解决后，AC-2.4 ~ AC-2.8 一次通过，无额外代码改动：
- **AC-2.4** agent_list 返回 name/status/default 标记
- **AC-2.5** agent_deregister 从 agents.json 移除条目
- **AC-2.6** 路由层直接拦截未知 agent，返回可用列表
- **AC-2.7** Permission verdict 正确路由回请求方 agent（demo 的 Bash 权限不会误发给 brain）
- **AC-2.8** @demo 重启：code 143 终止 → 新进程启动 → spoke 重注册 → context 清空确认

Phase 3 全部一次通过，无额外代码改动：
- **AC-3.1** `cc2im install` 写入 plist + launchctl load，hub 后台启动 + brain autoStart
- **AC-3.2** 关闭所有终端后微信发消息，正常收到回复
- **AC-3.3** MacBook 合盖 30s 后发消息，正常收到回复（caffeinate 生效）
- **AC-3.4** kill hub 进程后 5s 内 launchd 自动重启，新 PID 50812（旧 49979）
- **AC-3.5** `cc2im uninstall` 正确 unload + 删除 plist
- **AC-3.6** `cc2im logs` 输出 hub.log + error.log 实时日志
