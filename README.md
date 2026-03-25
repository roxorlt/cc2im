# cc2im

微信 IM 网关，连接多个本地 Claude Code 实例。通过 @mention 将微信消息路由到不同的 CC workspace。

## 架构

```
手机微信
  ↓ iLink Bot API (long-poll)
┌──────────────────────────────────┐
│  cc2im-hub (launchd daemon)      │
│  · WeixinBot（唯一微信连接）       │
│  · Agent Router（@mention 路由）  │
│  · Agent Manager（生命周期管理）   │
└──────────┬───────────────────────┘
           │ Unix socket
    ┌──────┴──────┐
    ↓             ↓
┌─────────┐  ┌─────────┐
│ Spoke 1 │  │ Spoke N │
│ (MCP)   │  │ (MCP)   │
│         │  │         │
│ CC #1   │  │ CC #N   │
│ ~/brain │  │ ~/proj  │
└─────────┘  └─────────┘
```

## 安装

```bash
npm install -g cc2im
```

## 快速开始

```bash
# 1. 微信扫码登录
cc2im login

# 2. 注册第一个 agent
cc2im agent register brain ~/brain

# 3. 安装为后台服务（macOS）
cc2im install

# 完成！通过微信发消息即可。
# 用 @brain 指定目标 agent。
```

## 命令

```
cc2im login              微信扫码登录
cc2im hub                启动 hub（前台调试，不启动 agent）
cc2im start              启动 hub + 所有 autoStart agent
cc2im agent start <name> 前台启动指定 agent（调试用）
cc2im agent list         列出所有 agent 配置

cc2im install            安装 launchd 后台服务
cc2im uninstall          卸载 launchd 服务
cc2im status             查看运行状态
cc2im logs               查看实时日志
```

## 微信指令

运行后，通过微信消息控制 agent：

- `@agent 消息` — 路由到指定 agent
- `消息`（无 @）— 路由到默认 agent
- `@agent 重启` — 重启 agent（清空上下文）

管理指令由默认 agent（brain）通过自然语言处理：

- `启动 demo` — 启动 agent
- `停止 demo` — 停止 agent
- `状态` — 列出所有 agent 及状态
- `注册 agent 叫 X，目录是 /path` — 注册新 agent
- `注销 X` — 注销 agent

## 配置

所有状态存储在 `~/.cc2im/`：

```
~/.cc2im/
├── hub.sock           Unix socket
├── agents.json        Agent 注册表
├── credentials.json   微信登录凭证
├── hub.log            Hub 标准输出日志
├── hub.error.log      Hub 错误日志
└── agents/
    └── <name>/
        ├── claude.log       CC 输出（通过 expect pty）
        ├── spoke.log        Spoke 调试日志
        └── always-allow.json  权限缓存
```

## 环境要求

- macOS（launchd 集成）
- Node.js 22+
- Claude Code CLI (`claude`)
