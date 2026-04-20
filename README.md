# cc2im

[English](./README.en.md) | 中文

微信 IM 网关，连接多个本地 Claude Code 实例。通过微信消息远程控制你的 AI agent。

## 架构

```
手机微信
  ↓ iLink Bot API (long-poll)
┌──────────────────────────────────┐
│  cc2im hub (launchd daemon)      │
│  · WeChat 连接（多账号支持）       │
│  · @mention 路由                  │
│  · Agent 生命周期管理              │
│  · Web Dashboard (:3721)         │
│  · Cron 定时任务调度               │
└──────────┬───────────────────────┘
           │ Unix socket
    ┌──────┴──────┐
    ↓             ↓
┌─────────┐  ┌─────────┐
│ Spoke 1 │  │ Spoke N │
│ (MCP)   │  │ (MCP)   │
│ CC #1   │  │ CC #N   │
│ ~/brain │  │ ~/proj  │
└─────────┘  └─────────┘
```

## 安装

```bash
npm install -g cc2im
```

**环境要求：** macOS, Node.js 22+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## 快速开始

```bash
# 1. 微信扫码登录
cc2im login

# 2. 注册第一个 agent
cc2im agent register brain ~/brain

# 3. 安装为后台服务
cc2im install

# 完成！在微信里发消息即可。
```

## 命令

| 命令 | 说明 |
|------|------|
| `cc2im login` | 微信扫码登录 |
| `cc2im start` | 启动 hub + 所有 autoStart agent |
| `cc2im hub` | 仅启动 hub（调试用） |
| `cc2im web` | 仅启动 Web Dashboard |
| `cc2im agent register <name> <dir>` | 注册 agent |
| `cc2im agent list` | 列出 agent 配置 |
| `cc2im agent start <name>` | 前台启动 agent（调试用） |
| `cc2im install` | 安装 launchd 后台服务 |
| `cc2im uninstall` | 卸载 launchd 服务 |
| `cc2im status` | 查看运行状态 |
| `cc2im logs` | 查看实时日志 |

## 微信指令

- `消息` — 发送到默认 agent
- `@agent 消息` — 路由到指定 agent
- `@agent 重启` — 重启 agent（清空上下文）

管理指令由默认 agent 的 Claude 通过自然语言处理：

- `启动/停止 <agent>` — 管理 agent 生命周期
- `状态` — 列出所有 agent 及状态
- `注册 agent 叫 X，目录是 /path` — 注册新 agent

## Web Dashboard

启动后访问 `http://127.0.0.1:3721`，可查看：

- 实时消息流和 agent 状态
- Token 用量和费用统计
- 多微信账号管理（扫码登录/断开）
- Cron 定时任务管理
- 实时日志

## 多微信账号

支持同时登录多个微信账号。在 Dashboard 的 Channels 页面添加新 channel，扫码登录即可。每个 channel 可以绑定默认 agent，消息会根据来源 channel 路由。

## 配置

所有状态存储在 `~/.cc2im/`：

```
~/.cc2im/
├── hub.sock           Unix socket
├── agents.json        Agent 注册表
├── channels.json      Channel 配置
├── cc2im.db           消息持久化 + Cron 数据（SQLite）
├── hub.log            Hub 日志
└── agents/
    └── <name>/
        └── spoke.log  Spoke 日志
```

微信凭证存储在 `~/.weixin-bot/`（每个 channel 独立文件）。

## 已知限制

cc2im 为**单用户场景**设计（一个人通过微信控制自己的多个 agent）。多用户并发时，权限审批和回复路由可能出现竞争。

## 更新日志

### v0.2.2 (2026-04-20)

- **fix**: CC 启动时若 `--continue` 触发 "Resume from summary" 会话选择器，expect 脚本现在会自动选第一项；新增 60s 连接超时兜底，卡住时自动 kill 并用新会话重试
- **fix**: 每个微信 channel 使用独立凭证文件（`credentials-{channelId}.json`），不再互相覆盖，解决新增第二个账号导致第一个掉线的问题

### v0.2.1 (2026-04-07)

- 新用户首次启动引导文案优化
- 休眠/唤醒后自动重连微信，连续 poll 超时时触发重连
- Hub 启动时清理孤儿 agent 进程
- 重启后通过 `--continue` 恢复 agent 的最近 session

## License

[MIT](./LICENSE)
