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

## 实现阶段与验收标准

### Phase W1: Hub monitor 协议

**实现内容**：
- `types.ts`：新增 MonitorRegister、HubEvent 类型
- `socket-server.ts`：识别 `register_monitor` 帧，维护 monitor 连接列表，提供 `broadcast()` 方法
- `index.ts`：在消息收发、agent 上下线、permission 等事件点调用 `broadcast()`

**验收标准**：

AC-W1.1: Monitor 注册
```
1. 启动 hub（cc2im install 或前台 cc2im hub）
2. 用脚本连 hub.sock，发送 {"type":"register_monitor"}\n
3. 验证：hub 日志出现 "Monitor connected"
4. 验证：不影响现有 spoke 注册和消息路由
```

AC-W1.2: 事件广播 — agent 上下线
```
1. monitor 已连接
2. 启动一个 agent（微信发"启动 demo"）
3. 验证：monitor 收到 {"type":"hub_event","event":{"kind":"agent_online","agentId":"demo",...}}
4. 停止 agent
5. 验证：monitor 收到 agent_offline 事件
```

AC-W1.3: 事件广播 — 消息收发
```
1. monitor 已连接，brain 在线
2. 微信发消息
3. 验证：monitor 收到 message_in 事件（含 agentId、userId、text）
4. brain 回复后，验证：monitor 收到 message_out 事件
```

AC-W1.4: 事件广播 — permission
```
1. monitor 已连接，brain 在线，关闭 auto-mode 测试
2. 微信发需要权限审批的消息
3. 验证：monitor 收到 permission_request 事件
4. 微信回复 yes
5. 验证：monitor 收到 permission_verdict 事件
```

AC-W1.5: Monitor 断开不影响 hub
```
1. monitor 连接中
2. 强制断开 monitor
3. 微信发消息
4. 验证：hub 正常转发和回复，无报错
```

AC-W1.6: 无 monitor 时零开销
```
1. 没有 monitor 连接
2. 微信正常收发消息
3. 验证：hub 日志无 monitor 相关输出，行为与改动前完全一致
```

---

### Phase W2: Web 后端骨架

**实现内容**：
- `src/web/index.ts`：`cc2im web` 命令入口
- `src/web/monitor-client.ts`：连 hub.sock 作为 monitor
- `src/web/stats-reader.ts`：0.5s 读 `~/.claude/stats-cache.json`
- `src/web/log-tailer.ts`：tail hub.log + spoke.log
- HTTP server（提供 API）+ WebSocket server（推送事件）
- `src/cli.ts`：新增 `web` 子命令

**验收标准**：

AC-W2.1: Web server 启动
```
1. hub 正在运行
2. 运行 cc2im web
3. 验证：终端输出 "Listening on http://127.0.0.1:3721"
4. 浏览器打开 http://127.0.0.1:3721
5. 验证：返回 HTTP 200（哪怕是空白页）
```

AC-W2.2: 自定义端口
```
1. 运行 cc2im web --port 8080
2. 验证：监听在 8080
```

AC-W2.3: 仅绑定 localhost
```
1. cc2im web 运行中
2. 从另一台机器访问 http://<本机IP>:3721
3. 验证：连接被拒绝
```

AC-W2.4: WebSocket 连接 + 初始 snapshot
```
1. cc2im web 运行中，brain 在线
2. 浏览器打开 WebSocket ws://127.0.0.1:3721/ws
3. 验证：收到 {"type":"snapshot","agents":[{"name":"brain","status":"connected",...}]}
```

AC-W2.5: 实时事件转发
```
1. WebSocket 已连接
2. 微信发消息
3. 验证：WebSocket 收到 message_in 和 message_out 事件
```

AC-W2.6: REST API — agents
```
GET http://127.0.0.1:3721/api/agents
验证：返回 agents.json 内容
```

AC-W2.7: REST API — stats
```
GET http://127.0.0.1:3721/api/stats
验证：返回 stats-cache.json 内容（含 dailyActivity、modelUsage）
```

AC-W2.8: 日志流
```
1. WebSocket 已连接
2. hub 产生新日志（微信收发消息）
3. 验证：WebSocket 收到 {"type":"log","source":"hub","line":"..."}
```

AC-W2.9: Hub 未运行时的降级
```
1. 停止 hub
2. 运行 cc2im web
3. 验证：web server 正常启动，但提示 "Hub not connected"
4. 启动 hub
5. 验证：web 进程自动连上，开始收到事件
```

AC-W2.10: Web 进程退出不影响 hub
```
1. cc2im web 运行中
2. Ctrl+C 停止 web
3. 微信发消息
4. 验证：hub 正常工作
```

---

### Phase W3: 前端页面

**实现内容**：
- React + Vite + TypeScript 项目初始化
- TopBar 组件（hub 运行时长、今日消息数、总 token、输入/输出 token、TPD 折线图）
- AgentList 组件（agent 卡片列表，状态灯，运行时长）
- MessageFlow 组件（选中 agent 的消息收发流水）
- LogViewer 组件（选中 agent 的 spoke.log 实时滚动）
- WebSocket hook + Stats polling hook

**验收标准**：

AC-W3.1: 页面加载
```
1. hub 运行中，brain 在线
2. 浏览器打开 http://127.0.0.1:3721
3. 验证：页面渲染完成，无白屏，无控制台报错
```

AC-W3.2: 顶栏指标
```
1. 页面加载后
2. 验证：显示 hub 运行时长（递增计时）
3. 验证：显示今日消息数（与 stats-cache.json 一致）
4. 验证：显示总 token / 输入 token / 输出 token
5. 验证：TPD 折线图显示近 30 天数据
```

AC-W3.3: Agent 列表
```
1. agents.json 有 brain（connected）和 demo（stopped）
2. 验证：左侧显示两张卡片
3. 验证：brain 卡片绿色状态灯 + 运行时长
4. 验证：demo 卡片灰色状态灯
5. 验证：brain 卡片有 ★ 标记（默认 agent）
```

AC-W3.4: 实时状态更新
```
1. 页面打开中
2. 微信发"启动 demo"
3. 验证：demo 卡片从灰色变绿色，无需刷新页面
4. 微信发"停止 demo"
5. 验证：demo 卡片从绿色变灰色
```

AC-W3.5: 消息流
```
1. 点击 brain 卡片
2. 右侧显示"消息流"tab
3. 微信发消息
4. 验证：消息流实时出现新条目（输入 + 输出）
5. 验证：区分输入（用户消息）和输出（agent 回复）样式
6. 验证：自动滚动到最新消息
```

AC-W3.6: 日志查看
```
1. 点击 brain 卡片，切换到"日志"tab
2. 验证：显示 spoke.log 内容
3. 产生新日志
4. 验证：新日志实时追加
5. 验证：等宽字体，可滚动
```

AC-W3.7: Permission 事件展示
```
1. brain 关闭 auto-mode
2. 微信发需要权限的消息
3. 验证：消息流中出现 permission 请求卡片（区别于普通消息）
4. 微信回复 yes
5. 验证：出现 permission 审批卡片
```

AC-W3.8: 切换 agent
```
1. 点击 brain 卡片，查看消息流
2. 点击 demo 卡片
3. 验证：右侧切换为 demo 的消息流和日志
4. 点回 brain
5. 验证：brain 的消息流仍保留（未丢失）
```

---

### Phase W4: 集成测试 + 打包

**实现内容**：
- Vite 构建 React 产物为静态文件
- web server 直接 serve 构建产物（开发模式用 Vite dev server）
- `cc2im web` 命令集成到 CLI
- `npm pack` 包含构建产物

**验收标准**：

AC-W4.1: 开发模式
```
1. 运行 cc2im web --dev
2. 验证：Vite dev server 启动，支持热更新
3. 修改 React 组件
4. 验证：浏览器自动刷新
```

AC-W4.2: 生产构建
```
1. 构建前端：npm run build:web（或类似命令）
2. 运行 cc2im web（非 --dev）
3. 验证：serve 构建后的静态文件，页面功能与开发模式一致
```

AC-W4.3: 包完整性
```
npm pack --dry-run
验证：包含 dist/web/ 目录（构建产物）
验证：不包含 src/web/frontend/node_modules 或源码（如果单独构建）
```

AC-W4.4: 端到端冒烟测试
```
1. cc2im install（hub 后台运行，brain 自动启动）
2. cc2im web
3. 浏览器打开 http://127.0.0.1:3721
4. 验证：顶栏指标正常显示
5. 验证：brain 显示为 connected
6. 微信发消息
7. 验证：消息流实时更新
8. 验证：顶栏今日消息数递增
9. Ctrl+C 停 web
10. 微信再发消息
11. 验证：hub 正常工作不受影响
```

---

## 验收流程

每个 Phase 完成后：

1. **自验**：按上述 AC 逐条执行，记录通过/失败
2. **代码审查**：提交前用 Codex 或人工 review
3. **提交**：通过后提交到 feature branch
4. **合并**：Phase 全部 AC 通过后合并到 main
5. **重装服务**：`cc2im uninstall && cc2im install` 确保生产环境可用

Phase 之间的依赖：W1 → W2 → W3 → W4（严格顺序，后一个依赖前一个的产出）。
