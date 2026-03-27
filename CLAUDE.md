# cc2im — 微信 IM 网关

微信消息 → Hub 路由 → Claude Code 实例（Spoke）→ 回复到微信。

## 架构总览

```
手机微信
  ↓ iLink Bot API (long-poll)
┌─────────────────────────────────────────┐
│  Hub (常驻 daemon，macOS launchd)        │
│                                         │
│  ┌─ Plugin: weixin ──────────────────┐  │
│  │  WeixinChannel (Cc2imChannel 实现) │  │
│  │  连接 iLink Bot ↔ 收发微信消息     │  │
│  └───────────────────────────────────┘  │
│  ┌─ Plugin: persistence ─┐              │
│  │  SQLite WAL 消息持久化  │              │
│  └───────────────────────┘              │
│  ┌─ Plugin: cron-scheduler ┐            │
│  │  定时任务调度 (Croner)    │            │
│  └─────────────────────────┘            │
│  ┌─ Plugin: channel-manager ┐           │
│  │  Channel CRUD + 持久化    │           │
│  └──────────────────────────┘           │
│  ┌─ Plugin: web-monitor ────────────┐   │
│  │  HTTP API + WebSocket + React UI  │   │
│  │  Dashboard (port 3721)            │   │
│  └───────────────────────────────────┘   │
│                                         │
│  Router (@mention → agentId)            │
│  AgentManager (进程生命周期)              │
│  HubContext (EventEmitter, 插件共享上下文)│
└──────────┬──────────────────────────────┘
           │ Unix socket (ndjson 帧协议)
    ┌──────┴──────┐
    ↓             ↓
┌─────────┐  ┌─────────┐
│ Spoke 1 │  │ Spoke N │
│ (MCP    │  │ (MCP    │
│ channel)│  │ channel)│
│ CC #1   │  │ CC #N   │
│ ~/brain │  │ ~/proj  │
└─────────┘  └─────────┘
```

## 核心概念

| 概念 | 说明 |
|------|------|
| **Hub** | 常驻进程，加载插件、路由消息、管理 agent 进程 |
| **Spoke** | 每个 CC 实例内的 MCP channel server，桥接 CC ↔ Hub |
| **Channel** | IM 平台实例（如 `weixin-roxor`），实现 `Cc2imChannel` 接口 |
| **Plugin** | 实现 `Cc2imPlugin` 接口（`init` + `destroy`），通过 HubContext 交互 |
| **Router** | 解析 `@agent 消息` 格式，路由到对应 agent；无 @mention 时走默认 agent |
| **AgentManager** | 管理 agent 注册/启停/重启，含退避重启策略 |

## 消息流

```
微信用户发 "@brain 你好"
  → iLink Bot API 收到
  → WeixinChannel.onMessage()
  → Router.route("@brain 你好") → { agentId: "brain", text: "你好" }
  → HubContext.deliverToAgent("brain", msg)
    → emit('deliver:before')  ← persistence 插件拦截存库
    → socketServer.send() via Unix socket (ndjson)
    → emit('deliver:after')
  → Spoke 收到 → MCP channel notification → CC 处理
  → CC 调用 weixin_reply() tool
  → Spoke → Hub → WeixinChannel.sendText() → 微信
```

## 目录结构

```
src/
├── cli.ts                    # CLI 入口（login/hub/start/agent/install）
├── hub/
│   ├── index.ts              # Hub 主流程：加载配置 → 创建组件 → 启动插件
│   ├── socket-server.ts      # Unix socket server，管理 spoke/monitor 连接
│   ├── router.ts             # @mention 路由 + 拦截命令（重启/effort）
│   ├── agent-manager.ts      # Agent 进程管理（spawn expect+claude, 退避重启）
│   ├── hub-context.ts        # HubContext 实现（EventEmitter + channel 注册）
│   ├── plugin-manager.ts     # 插件加载/销毁生命周期
│   └── launchd.ts            # macOS launchd plist 生成
├── spoke/
│   ├── index.ts              # Spoke 主流程：连 hub → 启 MCP server → 心跳
│   ├── channel-server.ts     # MCP channel server + tool 注册
│   ├── socket-client.ts      # Hub socket 客户端
│   └── permission.ts         # 权限请求中继（CC ↔ 微信审批）
├── plugins/
│   ├── weixin/               # 微信 channel 插件
│   │   ├── index.ts          # 插件入口：连接 channel → 监听消息 → 路由
│   │   ├── weixin-channel.ts # Cc2imChannel 实现
│   │   ├── connection.ts     # iLink Bot 连接管理
│   │   ├── media.ts          # 媒体下载
│   │   ├── media-upload.ts   # 媒体上传
│   │   ├── permission.ts     # 微信侧权限审批 UI
│   │   └── chunker.ts        # 结构感知的消息分段（代码/表格不切割）
│   ├── persistence/          # 消息持久化（SQLite WAL）
│   ├── cron-scheduler/       # 定时任务（Croner）
│   ├── channel-manager/      # Channel CRUD + channels.json
│   └── web-monitor/          # Dashboard（HTTP + WebSocket + React）
│       ├── server.ts         # HTTP API 10+ 端点 + WebSocket 推送
│       └── frontend-v2/      # React SPA（Vite 构建）
└── shared/
    ├── types.ts              # 所有 Hub↔Spoke 协议类型
    ├── channel.ts            # Cc2imChannel 接口定义
    ├── plugin.ts             # Cc2imPlugin + HubContext 接口定义
    ├── socket.ts             # ndjson 帧编码 + Unix socket 路径
    ├── channel-config.ts     # channels.json 读写
    └── mcp-config.ts         # .mcp.json 写入（agent cwd 下）
```

## 运行时数据

所有状态在 `~/.cc2im/`：

| 文件 | 用途 |
|------|------|
| `agents.json` | Agent 注册表（name/cwd/autoStart/claudeArgs） |
| `channels.json` | Channel 配置（id/type/accountName） |
| `cc2im.db` | SQLite 数据库（消息、cron 任务） |
| `hub.sock` | Hub ↔ Spoke Unix socket |
| `hub.log` / `hub.error.log` | Hub 日志 |
| `agents/<name>/claude.log` | CC 输出日志 |
| `agents/<name>/spoke.log` | Spoke 调试日志 |

## 通信协议

Hub ↔ Spoke 使用 **ndjson**（每行一个 JSON + `\n`），通过 Unix socket 传输。

关键消息类型见 `src/shared/types.ts`：
- **Spoke → Hub**: `register`, `reply`, `send_file`, `permission_request`, `status`, `heartbeat`, `management`
- **Hub → Spoke**: `message`, `permission_verdict`, `management_result`

## 插件事件

HubContext 是 EventEmitter，插件通过事件交互：

| 事件 | 触发时机 |
|------|---------|
| `spoke:message` | Spoke 发来非 management 消息 |
| `deliver:before` / `deliver:after` | 消息投递前后（persistence 用） |
| `agent:online` / `agent:offline` | Agent 连接/断开 |
| `agent:evicted` | 心跳超时被踢 |
| `channel:add` / `channel:remove` | Channel 动态增删 |
| `hub:ready` / `hub:shutdown` | Hub 生命周期 |

## 开发

```bash
npm install
npm run build          # TypeScript 编译
npm run dev:hub        # 前台启动 hub（调试用）
npm test               # 运行测试（vitest）
```

Dashboard 前端在 `src/plugins/web-monitor/frontend-v2/`，通过 Vite 构建，访问 `http://localhost:3721`。

## 测试

使用 vitest。测试文件放在 `src/__tests__/` 目录：

```bash
npm test               # 运行全部测试
npm run test:watch     # watch 模式
```

当前覆盖的纯逻辑模块：
- `router.test.ts` — @mention 路由、默认 agent、拦截命令、channel 默认
- `chunker.test.ts` — 消息分段（代码块/表格不切割、超长兜底）
- `frame-parser.test.ts` — ndjson 帧解析（分片、多帧、异常处理）

## 关键设计决策

1. **单用户设计**：`lastUserId` 跟踪最近消息发送者。多用户并发时回复可能路由错误（TODO: 消息级关联 ID）
2. **expect + pty**：AgentManager 用 `expect` 脚本分配伪终端启动 CC，自动确认 workspace trust
3. **caffeinate**：macOS 上用 `caffeinate -i` 防止系统休眠杀进程
4. **退避重启**：5min 内崩溃 5 次放弃重启，延迟递增 5s/10s/15s/20s/25s
5. **Channel 抽象**：`Cc2imChannel` 接口支持多平台扩展（当前仅 weixin）

## 注意事项

- 改动 Hub↔Spoke 协议时，`src/shared/types.ts` 是唯一真相源，两端必须同步更新
- 改动插件接口时检查 `src/shared/plugin.ts`（HubContext + Cc2imPlugin）
- `server.ts`（web-monitor）是最大文件，HTTP API + WebSocket 都在里面
- 前端组件在 `frontend-v2/components/`，hooks 在 `frontend-v2/hooks/`
- 涉及可运行服务的改动，完成后必须实际运行验证
