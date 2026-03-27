# cc2im

English | [中文](./README.md)

WeChat IM gateway for multiple local Claude Code instances. Control your AI agents remotely via WeChat messages.

## Architecture

```
WeChat (mobile)
  ↓ iLink Bot API (long-poll)
┌──────────────────────────────────┐
│  cc2im hub (launchd daemon)      │
│  · WeChat connection (multi-acct)│
│  · @mention routing              │
│  · Agent lifecycle management    │
│  · Web Dashboard (:3721)         │
│  · Cron task scheduler           │
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

## Install

```bash
npm install -g cc2im
```

**Requirements:** macOS, Node.js 22+, [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)

## Quick Start

```bash
# 1. Scan QR code to log in to WeChat
cc2im login

# 2. Register your first agent
cc2im agent register brain ~/brain

# 3. Install as background service
cc2im install

# Done! Send a message via WeChat.
```

## Commands

| Command | Description |
|---------|-------------|
| `cc2im login` | WeChat QR code login |
| `cc2im start` | Start hub + all autoStart agents |
| `cc2im hub` | Start hub only (debug) |
| `cc2im web` | Start Web Dashboard only |
| `cc2im agent register <name> <dir>` | Register an agent |
| `cc2im agent list` | List agent configs |
| `cc2im agent start <name>` | Start agent in foreground (debug) |
| `cc2im install` | Install launchd background service |
| `cc2im uninstall` | Uninstall launchd service |
| `cc2im status` | Check service status |
| `cc2im logs` | Tail live logs |

## WeChat Commands

- `message` — Send to default agent
- `@agent message` — Route to a specific agent
- `@agent restart` — Restart agent (clears context)

Management commands are handled by the default agent's Claude via natural language:

- `start/stop <agent>` — Manage agent lifecycle
- `status` — List all agents and their status
- `register agent named X at /path` — Register a new agent

## Web Dashboard

Visit `http://127.0.0.1:3721` after starting to access:

- Real-time message flow and agent status
- Token usage and cost tracking
- Multi-account WeChat management (QR login/disconnect)
- Cron scheduled task management
- Live log viewer

## Multi-Account WeChat

Supports multiple WeChat accounts simultaneously. Add new channels in the Dashboard's Channels page and scan QR codes to log in. Each channel can have a default agent, and messages are routed based on source channel.

## Configuration

All state is stored in `~/.cc2im/`:

```
~/.cc2im/
├── hub.sock           Unix socket
├── agents.json        Agent registry
├── channels.json      Channel config
├── cc2im.db           Message persistence + cron data (SQLite)
├── hub.log            Hub log
└── agents/
    └── <name>/
        └── spoke.log  Spoke log
```

WeChat credentials are stored in `~/.weixin-bot/` (separate file per channel).

## Known Limitations

cc2im is designed for **single-user scenarios** (one person controlling multiple agents via WeChat). Under multi-user concurrency, permission approvals and reply routing may race.

## License

[MIT](./LICENSE)
