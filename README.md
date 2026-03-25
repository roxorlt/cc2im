# cc2im

IM gateway for multiple local Claude Code instances. Route WeChat messages to different Claude Code workspaces via @mention.

## Architecture

```
WeChat (phone)
  ↓ iLink Bot API (long-poll)
┌──────────────────────────────────┐
│  cc2im-hub (launchd daemon)      │
│  · WeixinBot (single connection) │
│  · Agent Router (@mention)       │
│  · Agent Manager (lifecycle)     │
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

## Install

```bash
npm install -g cc2im
```

## Quick Start

```bash
# 1. Login to WeChat
cc2im login

# 2. Register your first agent
cc2im agent register brain ~/brain

# 3. Install as background service (macOS)
cc2im install

# Done! Send messages via WeChat.
# Use @brain to target specific agents.
```

## Usage

```
cc2im login              WeChat QR code login
cc2im hub                Start hub (foreground, for debugging)
cc2im start              Start hub + all autoStart agents
cc2im agent start <name> Start agent in foreground (debugging)
cc2im agent list         List all agents and their config

cc2im install            Install launchd background service
cc2im uninstall          Uninstall launchd service
cc2im status             Show running status
cc2im logs               Tail hub logs
```

## WeChat Commands

Once running, control agents via WeChat messages:

- `@agent 消息` — Route message to specific agent
- `消息` (no @) — Route to default agent
- `@agent 重启` — Restart an agent (clears context)

Management commands are handled by the default agent (brain) via natural language:

- `启动 demo` — Start an agent
- `停止 demo` — Stop an agent
- `状态` — List all agents and their status
- `注册 agent 叫 X，目录是 /path` — Register new agent
- `注销 X` — Deregister an agent

## Config

All state is stored in `~/.cc2im/`:

```
~/.cc2im/
├── hub.sock           Unix socket
├── agents.json        Agent registry
├── credentials.json   WeChat login token
├── hub.log            Hub stdout log
├── hub.error.log      Hub stderr log
└── agents/
    └── <name>/
        ├── claude.log     CC output (via expect pty)
        ├── spoke.log      Spoke debug log
        └── always-allow.json  Permission cache
```

## Requirements

- macOS (launchd integration)
- Node.js 22+
- Claude Code CLI (`claude`)
