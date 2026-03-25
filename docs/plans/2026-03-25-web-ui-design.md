# cc2im Web UI 设计文档

> 2026-03-25 brainstorming 讨论产出

## 目标

为 cc2im 添加浏览器监控面板，实时查看 agent 状态、消息流、日志和 token 统计。

优先级：监控面板 > 管理操作 > 对话界面（第一版只做监控）。

## 架构

```
浏览器（localhost:3721）
  ↕ WebSocket + HTTP
┌──────────────────────────────┐
│  cc2im web（独立进程）         │
│                               │
│  ┌─────────────────────────┐ │
│  │ HTTP Server             │ │
│  │ · 提供 React 静态页面    │ │
│  │ · 提供 stats API        │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │ WebSocket Server        │ │
│  │ · 推送实时事件给浏览器    │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │ Hub Monitor Client      │ │
│  │ · 连 hub.sock           │ │
│  │ · 注册为 monitor 类型    │ │
│  │ · 接收 hub 广播事件      │ │
│  └─────────────────────────┘ │
│  ┌─────────────────────────┐ │
│  │ Stats Reader            │ │
│  │ · 0.5s 读 stats-cache   │ │
│  └─────────────────────────┘ │
└──────────┬───────────────────┘
           │ Unix socket（monitor 类型）
┌──────────┴───────────────────┐
│  cc2im hub（现有进程，微改）   │
│  · 识别 monitor 客户端        │
│  · 广播事件（不改 spoke 通信） │
└──────────────────────────────┘
```

### 数据流

| 数据 | 来源 | 传输路径 |
|------|------|---------|
| Agent 状态（上下线） | hub socket 事件 | hub → monitor → WebSocket → 浏览器 |
| 消息收发 | hub socket 事件 | hub → monitor → WebSocket → 浏览器 |
| Permission 请求/审批 | hub socket 事件 | hub → monitor → WebSocket → 浏览器 |
| Hub 日志 | hub.log 文件 | web 进程 tail → WebSocket → 浏览器 |
| Spoke 日志 | spoke.log 文件 | web 进程 tail → WebSocket → 浏览器 |
| Token 统计 | ~/.claude/stats-cache.json | web 进程 0.5s 轮询 → HTTP API → 浏览器 |
| Agent 配置 | ~/.cc2im/agents.json | web 进程读取 → HTTP API → 浏览器 |

### 不做的功能（第一版）

- CC 工具调用过程展示（CC 交互模式无结构化事件输出）
- 管理操作（启停/注册/注销 agent）
- 对话界面（浏览器直接跟 agent 聊天）
- 远程/局域网访问（仅 localhost）

## Hub 侧改动

### Monitor 协议扩展

在现有 socket 协议上新增一种客户端类型。Monitor 不是 spoke，不参与消息路由，只接收事件。

**注册帧**：
```typescript
interface MonitorRegister {
  type: 'register_monitor'
}
```

**Hub 广播给 monitor 的事件**：
```typescript
interface HubEvent {
  type: 'hub_event'
  event:
    | { kind: 'agent_online'; agentId: string; timestamp: string }
    | { kind: 'agent_offline'; agentId: string; timestamp: string }
    | { kind: 'message_in'; agentId: string; userId: string; text: string; timestamp: string }
    | { kind: 'message_out'; agentId: string; userId: string; text: string; timestamp: string }
    | { kind: 'permission_request'; agentId: string; toolName: string; timestamp: string }
    | { kind: 'permission_verdict'; agentId: string; behavior: string; timestamp: string }
    | { kind: 'agent_started'; agentId: string; timestamp: string }
    | { kind: 'agent_stopped'; agentId: string; code: number; timestamp: string }
}
```

**改动范围**：
- `socket-server.ts`：识别 `register_monitor` 帧，维护 monitor 连接列表
- `index.ts`：在现有事件处理点插入 `broadcast(event)` 调用
- `types.ts`：新增 HubEvent 类型

### 改动原则

- Monitor 是只读的，不能发送指令给 hub
- Hub 没有 monitor 连接时，不做任何额外工作（零开销）
- Monitor 断开不影响 hub 正常运行

## Web 进程（`cc2im web`）

### 启动方式

```bash
cc2im web                  # 默认端口 3721
cc2im web --port 8080      # 自定义端口
```

### 进程组成

1. **Hub Monitor Client** — 连接 hub.sock，注册为 monitor，接收实时事件
2. **HTTP Server** — 提供 React 静态页面 + REST API
3. **WebSocket Server** — 将 hub 事件 + 日志流转发给浏览器
4. **Stats Reader** — 每 0.5 秒读取 `~/.claude/stats-cache.json`
5. **Log Tailer** — tail hub.log 和各 agent 的 spoke.log

### REST API

```
GET /api/agents          — agents.json 内容
GET /api/stats           — stats-cache.json 内容
GET /api/health          — web 进程 + hub 连接状态
```

### WebSocket 消息

```typescript
// 服务端 → 浏览器
type WsMessage =
  | { type: 'hub_event'; event: HubEvent }      // hub 实时事件
  | { type: 'log'; source: string; line: string } // 日志行（hub / agent name）
  | { type: 'snapshot'; agents: AgentStatus[] }   // 首次连接时的全量状态
```

## 安全

- HTTP/WebSocket 绑定 `127.0.0.1`（仅本机访问）
- 无认证（本机访问无需）
- 后续如需局域网访问，再加 token 认证 + 绑定 `0.0.0.0`

## 前端

### 技术栈

- React 19 + TypeScript
- Vite（开发 + 构建）
- 构建产物内嵌到 cc2im 包中，`cc2im web` 直接 serve

### 页面结构

```
┌─────────────────────────────────────────────────┐
│ 顶栏                                             │
│ Hub 运行时长 │ 今日消息 │ 总Token │ 输入/输出 │ TPD │
├────────────┬────────────────────────────────────┤
│ Agent 列表  │ 选中 Agent 详情                     │
│            │                                     │
│ ┌────────┐ │ ┌─────────────────────────────────┐│
│ │★ brain │ │ │ [消息流]  [日志]                  ││
│ │● online│ │ │                                  ││
│ │  3h 12m│ │ │ 17:39 [微信 user] 帮我看看...    ││
│ └────────┘ │ │ 17:39 → ~/brain/CLAUDE.md 共864行││
│ ┌────────┐ │ │ 17:40 [微信 user] 测试            ││
│ │  demo  │ │ │ 17:40 → 收到，连接正常 ✅          ││
│ │○ stopped│ │ │                                  ││
│ └────────┘ │ │                                  ││
│            │ └─────────────────────────────────┘│
└────────────┴────────────────────────────────────┘
```

### 顶栏指标

| 指标 | 数据源 | 刷新频率 |
|------|--------|---------|
| Hub 运行时长 | WebSocket snapshot | 实时 |
| 今日消息数 | stats-cache.json → dailyActivity | 0.5s |
| 总 Token | stats-cache.json → modelUsage | 0.5s |
| 输入 / 输出 Token | stats-cache.json → modelUsage.inputTokens / outputTokens | 0.5s |
| TPD 近 30 天 | stats-cache.json → dailyModelTokens（折线图） | 0.5s |

### Agent 卡片

- 名称 + 默认标记（★）
- 状态灯：绿色 connected / 黄色 starting / 灰色 stopped
- 运行时长（从 agent_online 事件开始计时）
- cwd 路径

### 消息流 Tab

- 按时间排列，区分输入（用户消息）和输出（agent 回复）
- Permission 请求/审批显示为特殊卡片
- 自动滚动到底部，可手动暂停

### 日志 Tab

- 实时滚动的 spoke.log 内容
- 等宽字体，保留日志格式

## 文件结构

```
src/
├── web/
│   ├── index.ts              # cc2im web 入口
│   ├── monitor-client.ts     # hub.sock monitor 连接
│   ├── stats-reader.ts       # stats-cache.json 轮询
│   ├── log-tailer.ts         # tail 日志文件
│   └── frontend/
│       ├── index.html
│       ├── App.tsx
│       ├── components/
│       │   ├── TopBar.tsx       # 顶栏指标
│       │   ├── AgentList.tsx    # 左侧 agent 卡片
│       │   ├── MessageFlow.tsx  # 消息流
│       │   ├── LogViewer.tsx    # 日志查看
│       │   └── TPDChart.tsx     # TPD 折线图
│       ├── hooks/
│       │   ├── useWebSocket.ts
│       │   └── useStats.ts
│       └── styles/
```

## 实现阶段

### Phase W1: Hub monitor 协议
- socket-server.ts 支持 monitor 注册
- index.ts 在关键事件点广播
- 验收：用 netcat 连 hub.sock 发 register_monitor，收到事件流

### Phase W2: Web 后端骨架
- `cc2im web` 命令入口
- monitor-client 连接 hub
- HTTP server + WebSocket server
- stats-reader + log-tailer
- 验收：浏览器打开 localhost:3721，WebSocket 连接成功，收到 snapshot

### Phase W3: 前端页面
- React + Vite 项目搭建
- TopBar（指标）+ AgentList（卡片）+ MessageFlow + LogViewer
- TPD 折线图
- 验收：完整页面可用，实时刷新

### Phase W4: 打包集成
- Vite 构建产物嵌入 cc2im 包
- `cc2im web` 直接 serve 构建产物
- 验收：`npm pack` 后 `cc2im web` 可用
