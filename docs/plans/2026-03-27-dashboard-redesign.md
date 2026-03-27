# Dashboard 改版 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 cc2im Dashboard 从单页面升级为多页面架构，支持 Channel 管理（CRUD + 状态监控）、消息流 channel/用户标注、用户昵称编辑。

**Architecture:** 左侧折叠式导航栏（Linear/Notion 风格）承载一级 + 二级导航。"对话" section 包含 Agent 列表（二级）；"Channels" section 包含 Channel 列表（二级）。右侧主内容区根据当前 section + 选中项渲染对应页面。服务端新增 channel CRUD API、昵称存储、HubEventData channelId 字段。

**Tech Stack:** TypeScript, React, Vite, better-sqlite3, WebSocket, node:http

---

## 零、服务端能力差距总览

开始前端改造前，需要先补齐以下服务端能力：

| 缺失能力 | 影响的前端功能 | 对应 Task |
|----------|--------------|-----------|
| HubEventData 无 `channelId` 字段 | 消息气泡无法标注 channel 来源 | Task 1 |
| messages 表无 `channel_id` 列 | 无法按 channel 过滤历史消息 | Task 2 |
| 无 nicknames 表 | 用户昵称编辑无持久化 | Task 2 |
| 无 `/api/channels` 端点 | Channels 管理页无数据源 | Task 3 |
| 无 `/api/nicknames` 端点 | 昵称 CRUD 无 API | Task 3 |
| Channel 无运行时增删 | 新增/删除 Channel 不可用 | Task 4 |
| Channel 配置无持久化 | 重启后丢失新增的 channel | Task 4 |
| WebSocket snapshot 无 channels/nicknames | 前端刷新后无初始数据 | Task 5 |

---

## Task 1: HubEventData 增加 channelId 字段

**Files:**
- Modify: `src/shared/types.ts:115-128`
- Modify: `src/plugins/channel-manager/index.ts:225` (broadcastMonitor message_in)
- Modify: `src/plugins/channel-manager/index.ts:98` (broadcastMonitor message_out)
- Modify: `src/plugins/channel-manager/index.ts:157` (broadcastMonitor send_file)

**Step 1: 扩展 HubEventData 类型**

```typescript
// src/shared/types.ts — HubEventData 新增字段
export interface HubEventData {
  kind: 'agent_online' | 'agent_offline' | 'message_in' | 'message_out'
    | 'permission_request' | 'permission_verdict' | 'agent_started' | 'agent_stopped'
    | 'config_changed' | 'channel_status'
  agentId: string
  timestamp: string
  userId?: string
  text?: string
  toolName?: string
  behavior?: string
  code?: number
  msgType?: string
  mediaUrl?: string
  channelId?: string    // 新增：消息来源 channel 实例 ID
  channelType?: string  // 新增：channel 平台类型 (weixin, telegram, ...)
}
```

**Step 2: channel-manager broadcastMonitor 调用补充 channelId**

在 `src/plugins/channel-manager/index.ts` 中所有 `ctx.broadcastMonitor` 调用增加 `channelId` 和 `channelType` 字段：

message_in（约 L225）：
```typescript
ctx.broadcastMonitor({
  kind: 'message_in', agentId: routed.agentId, userId, text: routed.text,
  timestamp: new Date().toISOString(), msgType: incomingMsg.type, mediaUrl,
  channelId: incomingMsg.channelId,       // 新增
  channelType: incomingMsg.channelType,   // 新增
})
```

message_out reply（约 L98）：
```typescript
ctx.broadcastMonitor({
  kind: 'message_out', agentId, userId: msg.userId, text: msg.text,
  timestamp: new Date().toISOString(),
  channelId: ref.channelId,  // 新增：从 resolveUserRef 得到
})
```

message_out send_file（约 L157）：
```typescript
ctx.broadcastMonitor({
  kind: 'message_out', agentId, userId: msg.userId,
  text: isImage ? '[图片]' : `[${msgType}] ${basename(msg.filePath)}`,
  timestamp: new Date().toISOString(), msgType, mediaUrl: `/media/${mediaName}`,
  channelId: ref.channelId,  // 新增
})
```

**Step 3: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```bash
git add src/shared/types.ts src/plugins/channel-manager/index.ts
git commit -m "feat: add channelId/channelType to HubEventData"
```

---

## Task 2: DB schema — messages 表加 channel_id + 新建 nicknames 表

**Files:**
- Modify: `src/plugins/persistence/db.ts:13-36` (schema)
- Modify: `src/plugins/persistence/db.ts:46-51` (storeInbound)
- Modify: `src/plugins/persistence/db.ts:55-63` (storeOutbound)
- Modify: `src/plugins/persistence/index.ts:57-58` (storeInbound 调用)
- Modify: `src/plugins/persistence/index.ts:74-76` (storeOutbound 调用)

**Step 1: 扩展 DB schema**

```typescript
// src/plugins/persistence/db.ts — openDb() 中追加
db.exec(`
  -- 给 messages 表加 channel_id 列（向后兼容，允许 NULL）
  -- SQLite 不支持 IF NOT EXISTS 对列，用 try/catch 包裹
  ALTER TABLE messages ADD COLUMN channel_id TEXT;
`)
// ↑ 如果列已存在会报错，需要 try/catch 包裹

db.exec(`
  CREATE TABLE IF NOT EXISTS nicknames (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
`)
```

用 try/catch 包裹 ALTER TABLE 以实现幂等：

```typescript
// 在 openDb() 中现有 CREATE TABLE 之后添加：
try {
  db.exec(`ALTER TABLE messages ADD COLUMN channel_id TEXT`)
} catch {
  // 列已存在，忽略
}

db.exec(`
  CREATE TABLE IF NOT EXISTS nicknames (
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
`)
```

**Step 2: storeInbound / storeOutbound 增加 channelId 参数**

```typescript
// db.ts
export function storeInbound(
  agentId: string, userId: string, text: string, msgType: string,
  mediaPath?: string, channelId?: string,  // 新增
): string {
  const id = randomUUID()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, msg_type, media_path, channel_id, created_at)
    VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, msgType, mediaPath ?? null, channelId ?? null, new Date().toISOString())
  return id
}

export function storeOutbound(
  agentId: string, userId: string, text: string,
  channelId?: string,  // 新增
): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, channel_id, created_at, delivered_at)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, channelId ?? null, now, now)
  return id
}
```

**Step 3: 新增 nickname CRUD 函数**

```typescript
// db.ts — 追加
export function getNicknames(): Array<{ channelId: string; userId: string; nickname: string }> {
  return openDb().prepare(
    `SELECT channel_id AS channelId, user_id AS userId, nickname FROM nicknames`
  ).all() as any[]
}

export function setNickname(channelId: string, userId: string, nickname: string): void {
  openDb().prepare(`
    INSERT INTO nicknames (channel_id, user_id, nickname, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET nickname = ?, updated_at = ?
  `).run(channelId, userId, nickname, new Date().toISOString(), nickname, new Date().toISOString())
}
```

**Step 4: persistence plugin 传递 channelId**

在 `src/plugins/persistence/index.ts` 的 `deliver:before` 和 `spoke:message` handler 中，需要从消息中提取 channelId。但 `HubToSpokeMessage` 当前没有 channelId。

方案：persistence plugin 监听 `deliver:before` 时从事件参数中拿不到 channelId（因为 HubToSpokeMessage 不含该字段）。改为：让 channel-manager 在 broadcastMonitor 之外，也 emit 一个带 channelId 的事件供 persistence 使用。

更简单的方案：**在 persistence plugin 的 storeInbound 调用点传入 channelId**。但 `deliver:before` 事件中的 msg 是 `HubToSpokeMessage` 类型，不含 channelId。

**最简方案：给 HubToSpokeMessage 加可选 channelId 字段**（仅用于内部传递，不影响 spoke）：

```typescript
// src/shared/types.ts — HubToSpokeMessage 新增
export interface HubToSpokeMessage {
  type: 'message'
  userId: string
  text: string
  msgType: string
  mediaPath?: string
  timestamp: string
  channelId?: string  // 新增：内部使用，不发给 spoke
}
```

在 channel-manager 的 `ctx.deliverToAgent()` 调用处加上 channelId：

```typescript
// channel-manager/index.ts 约 L226
const sent = ctx.deliverToAgent(routed.agentId, {
  type: 'message',
  userId,
  text,
  msgType: incomingMsg.type,
  mediaPath: incomingMsg.mediaPath ?? undefined,
  timestamp: incomingMsg.timestamp?.toISOString() ?? new Date().toISOString(),
  channelId: incomingMsg.channelId,  // 新增
})
```

persistence plugin 的 `deliver:before` handler：

```typescript
// persistence/index.ts
ctx.on('deliver:before', (agentId: string, msg: any, deliveryId: string) => {
  if (msg.type !== 'message') return
  if (msg.userId === 'system') return
  const m = msg as HubToSpokeMessage
  const dbId = storeInbound(agentId, m.userId, m.text, m.msgType, m.mediaPath, m.channelId)
  pendingDeliveries.set(deliveryId, { agentId, messageId: dbId })
})
```

**Step 5: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 6: Commit**

```bash
git add src/plugins/persistence/db.ts src/plugins/persistence/index.ts src/shared/types.ts src/plugins/channel-manager/index.ts
git commit -m "feat: DB schema — channel_id on messages + nicknames table"
```

---

## Task 3: Server API — /api/channels + /api/nicknames

**Files:**
- Modify: `src/plugins/web-monitor/server.ts:110-193` (新增路由)
- Modify: `src/plugins/web-monitor/index.ts` (传递 HubContext 引用给 server)

**Step 1: web-monitor server 获取 HubContext 引用**

当前 `startWeb()` 是独立进程，通过 MonitorClient WebSocket 连接 hub。它无法直接调用 `ctx.getChannels()`。

两个方案：
- **A: hub 进程内启动 web server**（需要重构启动流程）
- **B: 新增 HTTP API 代理**（web-monitor 通过 MonitorClient 请求 hub 的 channel 数据）

**选方案 B**：在 MonitorClient 协议中增加 request/response 能力。但这改动较大。

**更简单的方案 C**：web-monitor 作为 plugin 运行在 hub 进程内（查看现有代码确认）。

查看 `src/plugins/web-monitor/index.ts`：

```typescript
// 当前的 createWebMonitorPlugin 启动方式是 fork 独立进程还是 in-process？
```

需要确认。如果 web-monitor 是 in-process plugin，它可以直接通过 HubContext 访问 channel 数据。

**实际情况**：`web-monitor/index.ts` 的 plugin `init(ctx)` 会启动 HTTP server（通过 `startWeb()`），但 `startWeb()` 接收的是 `{ port }` 选项，不接收 ctx。

**方案**：修改 `createWebMonitorPlugin` 和 `startWeb()`，让 server 可以访问 ctx。

```typescript
// src/plugins/web-monitor/index.ts — 修改 init
export function createWebMonitorPlugin(): Cc2imPlugin {
  return {
    name: 'web-monitor',
    async init(ctx: HubContext) {
      await startWeb({ port: 3721, ctx })  // 传入 ctx
    },
    destroy() { /* shutdown server */ },
  }
}
```

如果 web-monitor 当前是独立进程模式（fork），需要改为 in-process 模式或增加 IPC。先看 `index.ts` 确认。

**假设 web-monitor 可获取 ctx**（具体实现方式在编码时确定），新增以下 API 路由：

**Step 2: GET /api/channels — 返回 channel 列表**

```typescript
// server.ts — 新增路由
if (url.pathname === '/api/channels') {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const channels = ctx.getChannels().map(ch => ({
    id: ch.id,
    type: ch.type,
    label: ch.label,
    status: ch.getStatus(),
  }))
  res.end(JSON.stringify(channels))
  return
}
```

**Step 3: GET /api/nicknames — 返回所有昵称映射**

```typescript
if (url.pathname === '/api/nicknames') {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  const { getNicknames } = await import('../persistence/db.js')
  res.end(JSON.stringify(getNicknames()))
  return
}
```

**Step 4: PATCH /api/nicknames/:channelId/:userId — 设置昵称**

```typescript
if (url.pathname.startsWith('/api/nicknames/') && req.method === 'PATCH') {
  const parts = url.pathname.slice('/api/nicknames/'.length).split('/')
  if (parts.length !== 2) {
    res.writeHead(400)
    res.end('Bad request: expected /api/nicknames/:channelId/:userId')
    return
  }
  const [channelId, userId] = parts.map(decodeURIComponent)
  let body = ''
  for await (const chunk of req) body += chunk
  const { nickname } = JSON.parse(body)
  if (!nickname || typeof nickname !== 'string') {
    res.writeHead(400)
    res.end('Bad request: { "nickname": "..." } required')
    return
  }
  const { setNickname } = await import('../persistence/db.js')
  setNickname(channelId, userId, nickname.trim())
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true }))
  return
}
```

**Step 5: POST /api/channels — 新增 channel**

```typescript
if (url.pathname === '/api/channels' && req.method === 'POST') {
  let body = ''
  for await (const chunk of req) body += chunk
  const { type, accountName } = JSON.parse(body)
  // 验证
  if (!type || !accountName) {
    res.writeHead(400)
    res.end('Bad request: { "type": "weixin", "accountName": "roxor" } required')
    return
  }
  const channelId = `${type}-${accountName}`
  // 检查重复
  if (ctx.getChannel(channelId)) {
    res.writeHead(409)
    res.end(JSON.stringify({ error: `Channel "${channelId}" already exists` }))
    return
  }
  // 创建 channel — 通过 ctx 方法（Task 4 实现）
  try {
    await ctx.addChannel(type, channelId, accountName)
    res.writeHead(201, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: channelId, type, label: `${accountName}`, status: 'connecting' }))
  } catch (err: any) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: err.message }))
  }
  return
}
```

**Step 6: DELETE /api/channels/:id — 删除 channel**

```typescript
if (url.pathname.startsWith('/api/channels/') && req.method === 'DELETE') {
  const channelId = decodeURIComponent(url.pathname.slice('/api/channels/'.length))
  if (!ctx.getChannel(channelId)) {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Channel not found' }))
    return
  }
  try {
    await ctx.removeChannel(channelId)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (err: any) {
    res.writeHead(500)
    res.end(JSON.stringify({ error: err.message }))
  }
  return
}
```

**Step 7: POST /api/channels/:id/probe — 手动检查连接（借鉴 OpenClaw）**

```typescript
if (url.pathname.match(/^\/api\/channels\/[^/]+\/probe$/) && req.method === 'POST') {
  const channelId = decodeURIComponent(url.pathname.split('/')[3])
  const ch = ctx.getChannel(channelId)
  if (!ch) {
    res.writeHead(404)
    res.end(JSON.stringify({ error: 'Channel not found' }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ id: channelId, status: ch.getStatus() }))
  return
}
```

**Step 8: TypeScript 检查 + Commit**

Run: `npx tsc --noEmit`

```bash
git add src/plugins/web-monitor/
git commit -m "feat: server API — /api/channels + /api/nicknames endpoints"
```

---

## Task 4: Channel 配置持久化 + 运行时增删

**Files:**
- Create: `src/shared/channel-config.ts`
- Modify: `src/hub/hub-context.ts` — 新增 `addChannel()` / `removeChannel()` 方法
- Modify: `src/plugins/channel-manager/index.ts` — 支持运行时增删 channel
- Modify: `src/hub/index.ts:68` — 从 channels.json 加载 channel 配置

**Step 1: Channel 配置文件格式**

```typescript
// src/shared/channel-config.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SOCKET_DIR } from './socket.js'
import type { ChannelType } from './channel.js'

export interface ChannelConfig {
  id: string           // "weixin-roxor"
  type: ChannelType    // "weixin"
  accountName: string  // "roxor"
}

const CHANNELS_JSON_PATH = join(SOCKET_DIR, 'channels.json')

export function loadChannelConfigs(): ChannelConfig[] {
  if (!existsSync(CHANNELS_JSON_PATH)) {
    // 默认配置：向后兼容，保留原始 weixin channel
    return [{ id: 'weixin', type: 'weixin', accountName: '微信' }]
  }
  return JSON.parse(readFileSync(CHANNELS_JSON_PATH, 'utf8'))
}

export function saveChannelConfigs(configs: ChannelConfig[]): void {
  writeFileSync(CHANNELS_JSON_PATH, JSON.stringify(configs, null, 2))
}
```

**Step 2: HubContext 新增 channel CRUD 方法**

```typescript
// src/shared/plugin.ts — HubContext 接口新增
export interface HubContext extends EventEmitter {
  // ... 现有方法不变 ...
  addChannel(type: string, channelId: string, accountName: string): Promise<void>
  removeChannel(channelId: string): Promise<void>
}
```

```typescript
// src/hub/hub-context.ts — 实现
async addChannel(type: string, channelId: string, accountName: string): Promise<void> {
  this.emit('channel:add', type, channelId, accountName)
  // 实际创建由 channel-manager plugin 监听此事件处理
}

async removeChannel(channelId: string): Promise<void> {
  const ch = this.channels.get(channelId)
  if (ch) {
    await ch.disconnect()
    this.channels.delete(channelId)
  }
  this.emit('channel:remove', channelId)
}
```

**Step 3: channel-manager 监听 channel:add / channel:remove**

```typescript
// channel-manager/index.ts — init() 中添加
ctx.on('channel:add', async (type: string, channelId: string, accountName: string) => {
  // 目前只支持 weixin 类型
  if (type === 'weixin') {
    const { WeixinChannel } = await import('../weixin/weixin-channel.js')
    const ch = new WeixinChannel(channelId, accountName)
    channelMap.set(channelId, ch)
    ctx.registerChannel(ch)

    // 注册 message + status handlers（同 init 中的逻辑，抽取为函数）
    wireChannel(ch, ctx)

    // 持久化
    const configs = loadChannelConfigs()
    configs.push({ id: channelId, type: 'weixin', accountName })
    saveChannelConfigs(configs)

    // 连接
    try {
      await ch.connect()
      console.log(`[channel-manager] ${ch.label} connected (runtime add)`)
    } catch (err: any) {
      console.error(`[channel-manager] ${ch.label} connect failed: ${err.message}`)
    }
  }
})

ctx.on('channel:remove', (channelId: string) => {
  channelMap.delete(channelId)
  // 更新持久化
  const configs = loadChannelConfigs().filter(c => c.id !== channelId)
  saveChannelConfigs(configs)
  console.log(`[channel-manager] Channel "${channelId}" removed`)
})
```

需要将 `ch.onMessage` 和 `ch.onStatusChange` 的注册逻辑抽取为 `wireChannel()` 函数，避免代码重复。

**Step 4: hub/index.ts 从 channels.json 加载**

```typescript
// src/hub/index.ts — 替换硬编码的 channels
import { loadChannelConfigs } from '../shared/channel-config.js'

// 旧: const channels = [new WeixinChannel()]
// 新:
const channelConfigs = loadChannelConfigs()
const channels: Cc2imChannel[] = channelConfigs.map(cfg => {
  switch (cfg.type) {
    case 'weixin':
      return new WeixinChannel(cfg.id, cfg.accountName)
    default:
      console.warn(`[hub] Unknown channel type: ${cfg.type}, skipping`)
      return null
  }
}).filter(Boolean) as Cc2imChannel[]
```

**Step 5: TypeScript 检查 + Commit**

Run: `npx tsc --noEmit`

```bash
git add src/shared/channel-config.ts src/shared/plugin.ts src/hub/hub-context.ts src/hub/index.ts src/plugins/channel-manager/index.ts
git commit -m "feat: channel config persistence + runtime add/remove"
```

---

## Task 5: WebSocket snapshot 增加 channels + nicknames

**Files:**
- Modify: `src/plugins/web-monitor/server.ts:248-272` (getSnapshot)
- Modify: `src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts` (解析 snapshot)

**Step 1: snapshot 增加 channels 和 nicknames 数据**

```typescript
// server.ts — getSnapshot() 修改
function getSnapshot() {
  // ... 现有 agents 逻辑不变 ...

  // 新增: channel 列表
  let channelList: Array<{ id: string; type: string; label: string; status: string }> = []
  try {
    channelList = ctx.getChannels().map(ch => ({
      id: ch.id,
      type: ch.type,
      label: ch.label,
      status: ch.getStatus(),
    }))
  } catch {}

  // 新增: 昵称映射
  let nicknames: Array<{ channelId: string; userId: string; nickname: string }> = []
  try {
    const { getNicknames } = await import('../persistence/db.js')
    nicknames = getNicknames()
  } catch {}

  return {
    agents,
    hubConnected: monitor.isConnected(),
    recentMessages: messageHistory.slice(-50),
    recentLogs: logBuffer.slice(-100),
    channels: channelList,    // 新增
    nicknames,                // 新增
  }
}
```

注意：`getSnapshot` 当前是同步函数，引入 `getNicknames` (同步 SQLite 调用) 无需改为 async。但如果 web-monitor 是独立进程，需要通过 API 获取。

**如果 web-monitor 是独立进程**（通过 MonitorClient 连接 hub），则 snapshot 数据来自 hub 侧。需要：
- hub 侧 socket-server 在发送 snapshot 时包含 channels + nicknames
- 或 web-monitor 在 snapshot 后立即 fetch `/api/channels` 和 `/api/nicknames`

**最简方案**：web-monitor 的 `getSnapshot()` 中调用自己的 API（localhost）获取 channels 和 nicknames。但这是循环调用。

**推荐方案**：直接在 `getSnapshot()` 中读取 channels.json 和 SQLite（web-monitor 和 hub 共用同一个 `~/.cc2im/` 目录，文件可直接读取）。

```typescript
// server.ts — getSnapshot() 中直接读文件
import { loadChannelConfigs } from '../../shared/channel-config.js'

// channels: 从 channels.json 读配置，状态从 channel_status 事件缓存中取
const channelConfigs = loadChannelConfigs()
const channelList = channelConfigs.map(cfg => ({
  id: cfg.id,
  type: cfg.type,
  label: cfg.accountName,
  status: channelStatusCache.get(cfg.id) || 'disconnected',
}))

// nicknames: 直接读 SQLite
import { openDb, getNicknames } from '../persistence/db.js'
// 确保 DB 已打开
try { openDb() } catch {}
const nicknames = getNicknames()
```

增加 `channelStatusCache`（从 channel_status 事件更新）：

```typescript
// server.ts — 在 monitor callback 中缓存 channel 状态
const channelStatusCache = new Map<string, string>()

// 在 monitor callback 中:
if (ev.kind === 'channel_status') {
  // 解析状态（同 useWebSocket.ts 的逻辑）
  const text = ev.text || ''
  const colonIdx = text.indexOf(':')
  const afterColon = colonIdx > 0 ? text.slice(colonIdx + 1).trim() : ''
  const statusWord = afterColon.split(/\s/)[0]
  channelStatusCache.set(ev.agentId, statusWord)
}
```

**Step 2: 前端 useWebSocket 解析 channels + nicknames**

```typescript
// useWebSocket.ts — 新增 state
const [nicknames, setNicknames] = useState<Map<string, string>>(new Map())
// key: "channelId:userId", value: nickname

// snapshot 处理中新增：
if (snap.channels) {
  setChannels(snap.channels)
}
if (snap.nicknames) {
  const map = new Map<string, string>()
  for (const n of snap.nicknames) {
    map.set(`${n.channelId}:${n.userId}`, n.nickname)
  }
  setNicknames(map)
}
```

return 中增加 `nicknames` 和 `setNicknames`。

**Step 3: TypeScript 检查 + Commit**

Run: `npx tsc --noEmit`

```bash
git add src/plugins/web-monitor/server.ts src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts
git commit -m "feat: WebSocket snapshot includes channels + nicknames"
```

---

## Task 6: 前端 — 折叠式侧栏导航布局

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/App.tsx` (整体布局重构)
- Create: `src/plugins/web-monitor/frontend-v2/components/Sidebar.tsx`
- Modify: `src/plugins/web-monitor/frontend-v2/components/AgentList.tsx` (改为 section 内容)

**Step 1: 创建 Sidebar 组件**

```tsx
// src/plugins/web-monitor/frontend-v2/components/Sidebar.tsx
import React, { useState } from 'react'
import type { AgentStatus, ChannelInfo } from '../hooks/useWebSocket'

type Page = 'chat' | 'channels'

interface SidebarProps {
  page: Page
  onPageChange: (page: Page) => void
  // Chat section
  agents: AgentStatus[]
  selectedAgent: string | null
  onSelectAgent: (name: string) => void
  // Channels section
  channels: ChannelInfo[]
  selectedChannel: string | null
  onSelectChannel: (id: string | null) => void
  onAddChannel: () => void
}

function SectionHeader({ label, count, expanded, onToggle, onClick }: {
  label: string; count: number; expanded: boolean
  onToggle: () => void; onClick: () => void
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '10px 14px 6px',
        cursor: 'pointer', userSelect: 'none',
      }}
      onClick={onClick}
    >
      <span
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        style={{
          fontSize: 10, color: 'var(--text-dim)',
          transition: 'transform 0.15s',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
      >▶</span>
      <span style={{
        fontSize: 9, color: 'var(--text-dim)',
        textTransform: 'uppercase', letterSpacing: '0.15em', fontWeight: 600,
        flex: 1,
      }}>{label}</span>
      <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>{count}</span>
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  const [chatExpanded, setChatExpanded] = useState(true)
  const [channelsExpanded, setChannelsExpanded] = useState(true)

  const statusConfig: Record<string, { color: string }> = {
    connected: { color: 'var(--green)' },
    starting: { color: 'var(--amber)' },
    stopped: { color: 'var(--text-muted)' },
    connecting: { color: 'var(--amber)' },
    disconnected: { color: 'var(--text-muted)' },
    expired: { color: 'var(--red)' },
  }

  return (
    <div style={{
      width: 220, borderRight: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Chat section */}
      <SectionHeader
        label="对话" count={props.agents.length}
        expanded={chatExpanded}
        onToggle={() => setChatExpanded(!chatExpanded)}
        onClick={() => props.onPageChange('chat')}
      />
      {chatExpanded && (
        <div style={{ padding: '0 8px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {props.agents.map(a => {
            const cfg = statusConfig[a.status] || statusConfig.stopped
            const active = props.page === 'chat' && props.selectedAgent === a.name
            return (
              <div
                key={a.name}
                onClick={() => { props.onPageChange('chat'); props.onSelectAgent(a.name) }}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: active ? 'var(--bg-card-active)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border-bright)' : 'transparent'}`,
                  transition: 'all 0.12s ease',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{
                  width: 6, height: 6, borderRadius: '50%', background: cfg.color, flexShrink: 0,
                  boxShadow: a.status === 'connected' ? `0 0 6px ${cfg.color}` : 'none',
                }} />
                <span style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Channels section */}
      <SectionHeader
        label="Channels" count={props.channels.length}
        expanded={channelsExpanded}
        onToggle={() => setChannelsExpanded(!channelsExpanded)}
        onClick={() => props.onPageChange('channels')}
      />
      {channelsExpanded && (
        <div style={{ padding: '0 8px 4px', display: 'flex', flexDirection: 'column', gap: 1 }}>
          {props.channels.map(ch => {
            const cfg = statusConfig[ch.status] || statusConfig.disconnected
            const active = props.page === 'channels' && props.selectedChannel === ch.id
            return (
              <div
                key={ch.id}
                onClick={() => { props.onPageChange('channels'); props.onSelectChannel(ch.id) }}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: active ? 'var(--bg-card-active)' : 'transparent',
                  border: `1px solid ${active ? 'var(--border-bright)' : 'transparent'}`,
                  transition: 'all 0.12s ease',
                }}
                onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-card-hover)' }}
                onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{
                  width: 6, height: 6, borderRadius: '50%', background: cfg.color, flexShrink: 0,
                }} />
                <span style={{ fontSize: 12, fontWeight: 500 }}>{ch.label}</span>
              </div>
            )
          })}
          {/* + 新增 */}
          <div
            onClick={props.onAddChannel}
            style={{
              padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
              fontSize: 11, color: 'var(--text-dim)',
              transition: 'color 0.12s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--accent)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-dim)'}
          >
            + 新增频道
          </div>
        </div>
      )}

      {/* 底部留白，未来放更多 section */}
      <div style={{ flex: 1 }} />
    </div>
  )
}
```

**Step 2: App.tsx 布局重构**

```tsx
// App.tsx — 核心结构变化
import { Sidebar } from './components/Sidebar'
import { ChannelsPage } from './components/ChannelsPage'
// ... 现有 imports ...

type Page = 'chat' | 'channels'

export function App() {
  const { agents, hubConnected, wsConnected, messages, logs, channels, nicknames, setNicknames } = useWebSocket()
  const tokenStats = useTokens()
  const usageStats = useUsage()

  const [page, setPage] = useState<Page>('chat')
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null)
  const [tab, setTab] = useState<'messages' | 'logs'>('messages')
  const [showAddChannel, setShowAddChannel] = useState(false)
  const [channelFilter, setChannelFilter] = useState<string | null>(null) // null = 全部

  const activeAgent = selectedAgent || agents[0]?.name || null

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
      <TopBar tokenStats={tokenStats} hubConnected={hubConnected} />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Sidebar
          page={page} onPageChange={setPage}
          agents={agents} selectedAgent={activeAgent} onSelectAgent={setSelectedAgent}
          channels={channels} selectedChannel={selectedChannel} onSelectChannel={setSelectedChannel}
          onAddChannel={() => { setPage('channels'); setShowAddChannel(true) }}
        />

        {/* 主内容区 */}
        {page === 'chat' ? (
          /* 对话页 — 现有布局（tab bar + MessageFlow/LogViewer） */
          activeAgent ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'var(--bg-deep)' }}>
              {/* Tab bar + channel filter */}
              <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--border)', background: 'var(--bg-panel)' }}>
                {/* 消息流/日志 tab（保留现有） */}
                {/* ... tabs ... */}

                {/* Channel filter 下拉 */}
                <select
                  value={channelFilter || ''}
                  onChange={e => setChannelFilter(e.target.value || null)}
                  style={{ /* ... 样式 ... */ }}
                >
                  <option value="">全部频道</option>
                  {channels.map(ch => (
                    <option key={ch.id} value={ch.id}>{ch.label}</option>
                  ))}
                </select>

                {/* viewing agent indicator */}
              </div>

              {tab === 'messages'
                ? <MessageFlow messages={messages} agentId={activeAgent}
                    channelFilter={channelFilter} nicknames={nicknames}
                    onSetNickname={...} />
                : <LogViewer logs={logs} source={activeAgent} />
              }
            </div>
          ) : (/* 无选中 agent 时的空状态 */)
        ) : (
          /* Channels 管理页 */
          <ChannelsPage
            channels={channels}
            selectedChannel={selectedChannel}
            showAddDialog={showAddChannel}
            onCloseAddDialog={() => setShowAddChannel(false)}
          />
        )}
      </div>

      {/* Footer（保持现有） */}
    </div>
  )
}
```

**Step 3: 删除旧的 AgentList.tsx（其功能已合并到 Sidebar）**

AgentList.tsx 的 AgentCard 组件逻辑已简化后嵌入 Sidebar。旧文件可删除或保留 import 兼容。

**Step 4: TypeScript 检查 + Vite dev 验证**

Run: `npx tsc --noEmit`
Run: `npx vite dev` — 打开 http://127.0.0.1:5173 确认布局正确

**Step 5: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/
git commit -m "feat: sidebar navigation layout — chat + channels sections"
```

---

## Task 7: 前端 — Chat 页消息气泡改版

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/components/MessageFlow.tsx`
- Modify: `src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts` (nicknames state)

**Step 1: MessageFlow 接收新 props**

```tsx
interface MessageFlowProps {
  messages: MessageEntry[]
  agentId: string
  channelFilter: string | null   // 新增
  nicknames: Map<string, string>  // 新增: "channelId:userId" → nickname
  onSetNickname: (channelId: string, userId: string, nickname: string) => void  // 新增
}
```

**Step 2: 过滤逻辑增加 channel filter**

```tsx
const filtered = messages.filter(m => {
  if (m.event.agentId !== agentId) return false
  if (channelFilter && m.event.channelId !== channelFilter) return false
  return true
})
```

**Step 3: MsgBubble 增加 header（入站消息）**

```tsx
function MsgHeader({ event, nicknames, onSetNickname }: {
  event: HubEventData
  nicknames: Map<string, string>
  onSetNickname: (channelId: string, userId: string, nickname: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!event.channelId || !event.userId) return null

  const key = `${event.channelId}:${event.userId}`
  const nickname = nicknames.get(key)
  const displayName = nickname || (event.userId.length > 8 ? event.userId.slice(-8) : event.userId)

  // channelId 格式: "weixin-roxor" → type="微信", account="roxor"
  const channelLabel = event.channelId // 简化：直接用 channelId，后续可从 channels 数据优化

  if (editing) {
    return (
      <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span>{channelLabel} |</span>
        <input
          autoFocus
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && draft.trim()) {
              onSetNickname(event.channelId!, event.userId!, draft.trim())
              setEditing(false)
            }
            if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={() => setEditing(false)}
          style={{
            background: 'var(--bg-deep)', border: '1px solid var(--border)',
            borderRadius: 3, padding: '1px 6px',
            fontSize: 10, color: 'var(--text)', outline: 'none',
            width: 80,
          }}
          placeholder={displayName}
        />
      </div>
    )
  }

  return (
    <div
      style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}
    >
      <span>{channelLabel}</span>
      <span style={{ color: 'var(--text-muted)' }}>|</span>
      <span>{displayName}</span>
      <span
        onClick={() => { setDraft(nickname || ''); setEditing(true) }}
        style={{ cursor: 'pointer', opacity: 0, transition: 'opacity 0.15s', fontSize: 9 }}
        className="edit-pencil"
      >✏️</span>
    </div>
  )
}
```

在 MsgBubble 中，入站消息（非 isOut）渲染 MsgHeader：

```tsx
// MsgBubble 内部
{!isOut && !isPerm && (
  <MsgHeader event={ev} nicknames={nicknames} onSetNickname={onSetNickname} />
)}
```

**Step 4: 连续消息省略 header**

同一用户连续消息只有首条显示 header：

```tsx
// MessageFlow 中传递 showHeader prop
{filtered.map((m, i) => {
  const prev = i > 0 ? filtered[i - 1] : null
  const showHeader = !prev
    || prev.event.userId !== m.event.userId
    || prev.event.channelId !== m.event.channelId
    || prev.event.kind !== m.event.kind
  return <MsgBubble key={i} entry={m} index={i} showHeader={showHeader}
    nicknames={nicknames} onSetNickname={onSetNickname} animate={...} />
})}
```

**Step 5: hover 显示铅笔的 CSS**

在 `index.html` 的 `<style>` 中添加：

```css
.msg-header:hover .edit-pencil { opacity: 1 !important; }
```

给 MsgHeader 外层 div 加 `className="msg-header"`。

**Step 6: onSetNickname 调用 API**

```tsx
// App.tsx 中
const handleSetNickname = async (channelId: string, userId: string, nickname: string) => {
  await fetch(`/api/nicknames/${encodeURIComponent(channelId)}/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname }),
  })
  setNicknames(prev => {
    const next = new Map(prev)
    next.set(`${channelId}:${userId}`, nickname)
    return next
  })
}
```

**Step 7: TypeScript 检查 + Vite dev 验证**

Run: `npx tsc --noEmit`
Run: `npx vite dev` — 验证消息气泡显示 header、铅笔编辑、channel 筛选

**Step 8: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/
git commit -m "feat: message bubbles — channel label + nickname editing + channel filter"
```

---

## Task 8: 前端 — Channels 管理页

**Files:**
- Create: `src/plugins/web-monitor/frontend-v2/components/ChannelsPage.tsx`

**Step 1: ChannelsPage 组件**

```tsx
// src/plugins/web-monitor/frontend-v2/components/ChannelsPage.tsx
import React, { useState } from 'react'
import type { ChannelInfo } from '../hooks/useWebSocket'

interface ChannelsPageProps {
  channels: ChannelInfo[]
  selectedChannel: string | null
  showAddDialog: boolean
  onCloseAddDialog: () => void
}

const statusLabels: Record<string, { label: string; color: string }> = {
  connected: { label: 'connected', color: 'var(--green)' },
  connecting: { label: 'connecting...', color: 'var(--amber)' },
  disconnected: { label: 'disconnected', color: 'var(--text-muted)' },
  expired: { label: 'session 已过期', color: 'var(--red)' },
}

function ChannelCard({ channel }: { channel: ChannelInfo }) {
  const status = statusLabels[channel.status] || statusLabels.disconnected

  const handleDisconnect = async () => {
    await fetch(`/api/channels/${encodeURIComponent(channel.id)}`, { method: 'DELETE' })
  }

  const handleProbe = async () => {
    await fetch(`/api/channels/${encodeURIComponent(channel.id)}/probe`, { method: 'POST' })
  }

  // channelId 格式: "weixin-roxor" → type="微信", name="roxor"
  const dashIdx = channel.id.indexOf('-')
  const channelType = dashIdx > 0 ? channel.id.slice(0, dashIdx) : channel.id
  const typeLabel = channelType === 'weixin' ? '微信' : channelType

  return (
    <div style={{
      padding: '16px 20px', borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {/* Row 1: type icon + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--text-dim)', fontWeight: 500 }}>{typeLabel}</span>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{channel.label}</span>
      </div>

      {/* Row 2: status */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: status.color }} />
        <span style={{ fontSize: 11, color: status.color }}>{status.label}</span>
      </div>

      {/* Row 3: expired warning + QR area */}
      {channel.status === 'expired' && (
        <div style={{
          padding: '10px 14px', borderRadius: 6,
          background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
          fontSize: 11, color: 'var(--red)',
        }}>
          ⚠ Session 已过期，需要重新扫码登录
          {/* QR 码区域 — 调用 /api/channels/:id/qr 获取（微信特有，后续实现） */}
        </div>
      )}

      {/* Row 4: actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button onClick={handleProbe} style={btnStyle}>检查连接</button>
        {channel.status === 'connected' && (
          <button onClick={handleDisconnect} style={{ ...btnStyle, color: 'var(--red)' }}>断开</button>
        )}
        {channel.status === 'disconnected' && (
          <>
            <button onClick={() => { /* reconnect API */ }} style={btnStyle}>连接</button>
            <button onClick={handleDisconnect} style={{ ...btnStyle, color: 'var(--red)' }}>删除</button>
          </>
        )}
      </div>
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)',
  background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)',
  fontFamily: 'var(--font-mono)',
}

function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const [type, setType] = useState('weixin')
  const [accountName, setAccountName] = useState('')
  const [creating, setCreating] = useState(false)

  const handleCreate = async () => {
    if (!accountName.trim()) return
    setCreating(true)
    try {
      await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, accountName: accountName.trim() }),
      })
      onClose()
    } catch (err) {
      console.error('Failed to create channel:', err)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{
      padding: '20px 24px', borderRadius: 8,
      background: 'var(--bg-card)', border: '1px solid var(--border)',
      maxWidth: 400,
    }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>新增频道</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>频道类型</label>
          <select value={type} onChange={e => setType(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12 }}>
            <option value="weixin">微信</option>
            <option value="telegram" disabled>Telegram (TBC)</option>
          </select>
        </div>

        <div>
          <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>授权账号名</label>
          <input value={accountName} onChange={e => setAccountName(e.target.value)}
            placeholder="如 roxor、家人"
            style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
          <button onClick={onClose} style={btnStyle}>取消</button>
          <button onClick={handleCreate} disabled={creating || !accountName.trim()}
            style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
            {creating ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ChannelsPage(props: ChannelsPageProps) {
  return (
    <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>Channels</span>
      </div>

      {/* Add dialog */}
      {props.showAddDialog && (
        <div style={{ marginBottom: 16 }}>
          <AddChannelDialog onClose={props.onCloseAddDialog} />
        </div>
      )}

      {/* Channel cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {props.channels.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 12 }}>
            暂无频道，点击「+ 新增频道」添加
          </div>
        ) : (
          props.channels.map(ch => <ChannelCard key={ch.id} channel={ch} />)
        )}
      </div>
    </div>
  )
}
```

**Step 2: App.tsx 引入 ChannelsPage**

在 Task 6 的 App.tsx 布局中已预留 `<ChannelsPage>` 位置，确保 import 正确。

**Step 3: TypeScript 检查 + Vite dev 验证**

Run: `npx tsc --noEmit`
Run: `npx vite dev` — 验证 Channels 页面渲染、新增对话框、操作按钮

**Step 4: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/components/ChannelsPage.tsx
git commit -m "feat: Channels management page — card list + add dialog"
```

---

## Task 9: 前端构建 + 集成验证

**Step 1: Vite 构建**

Run: `npx vite build`
Expected: 编译成功，输出到 `dist/web-frontend/`

**Step 2: 启动 hub 验证**

```bash
# 编译 TypeScript
npx tsc --noEmit

# 构建前端
npx vite build

# 重启 hub（确保用新代码）
pkill -f "cc2im" || true
sleep 2
rm -f ~/.cc2im/hub.sock
npx tsx src/cli.ts start &>~/.cc2im/hub.log &

# 等待启动
sleep 5
curl -s http://127.0.0.1:3721/api/health
```

**Step 3: 验证清单**

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 1 | 侧栏导航 | 打开 dashboard，左侧显示 "对话" 和 "Channels" 两个折叠组 |
| 2 | 对话组展开 | 点击 "对话"，展开 agent 列表，状态灯正常 |
| 3 | Channels 组展开 | 点击 "Channels"，展开 channel 列表 + "新增频道" 链接 |
| 4 | 页面切换 | 点击侧栏 section 标题，右侧内容区切换 |
| 5 | Agent 选中 | 点击 agent 名，右侧显示该 agent 的消息流 |
| 6 | 消息气泡 header | 入站消息显示 "频道类型-账号名 \| 用户名" 格式 |
| 7 | 昵称编辑 | hover 消息 header 出现 ✏️，点击编辑，回车保存 |
| 8 | 昵称持久化 | 刷新页面后昵称保持 |
| 9 | Channel 筛选 | tab 栏下拉选择 channel，消息流只显示该 channel 消息 |
| 10 | Channels 管理页 | 显示 channel 卡片列表，状态灯和操作按钮正常 |
| 11 | 新增 Channel | 点击"新增频道" → 填写类型+账号名 → 创建成功 |
| 12 | Channel 检查连接 | 点击"检查连接"按钮，返回当前状态 |
| 13 | Channel 删除 | disconnected 状态下可删除，列表更新 |
| 14 | 消息收发正常 | 微信发消息 → 路由到 agent → 回复 → 微信收到 |
| 15 | 日志页正常 | 切到日志 tab，日志正常显示 |
| 16 | Footer 正常 | 版本 + Usage + channel 状态灯 + ws 状态 |
| 17 | Channel 配置持久化 | 重启 hub 后，新增的 channel 仍在列表中（channels.json） |
| 18 | TypeScript 编译 | `npx tsc --noEmit` 通过 |
| 19 | Vite 构建 | `npx vite build` 通过 |

**Step 4: Commit**

```bash
git add -A
git commit -m "test: dashboard redesign integration verification"
```

---

## 验收标准汇总

### 功能验收

| # | 验收项 | 通过条件 |
|---|--------|---------|
| 1 | 折叠式侧栏导航 | 左侧 220px 侧栏，"对话" + "Channels" 两个可折叠 section |
| 2 | 页面路由 | 点击 section 标题切换右侧页面，点击子项选中具体 agent/channel |
| 3 | 消息 channel 标注 | 入站消息气泡显示 `{类型}-{账号} | {昵称或userId}` |
| 4 | 连续消息 header 省略 | 同用户连续消息只有首条显示 header |
| 5 | 昵称编辑 | hover 显示铅笔 → 点击 inline 编辑 → 回车保存 → 全局更新 |
| 6 | 昵称持久化 | 昵称存 SQLite，刷新/重启后保持 |
| 7 | Channel 筛选下拉 | 选择 channel 后消息流只显示该 channel 的消息 |
| 8 | Channels 管理页 | 卡片列表展示每个 channel 状态 + 操作按钮 |
| 9 | 新增 Channel | 选类型 + 填账号名 → 创建 → 微信自动进入连接流程 |
| 10 | 删除 Channel | disconnected 状态下可删除 + 配置文件同步更新 |
| 11 | 检查连接按钮 | 点击返回当前 channel 真实状态（借鉴 OpenClaw 健康探测） |
| 12 | Session 过期告警 | channel expired 时卡片显示红色警告 |
| 13 | Channel 配置持久化 | `~/.cc2im/channels.json` 存储，重启后 channel 列表恢复 |

### 服务端验收

| # | 验收项 | 通过条件 |
|---|--------|---------|
| 14 | HubEventData.channelId | message_in/message_out 事件包含 channelId 字段 |
| 15 | messages 表 channel_id 列 | 新消息带 channel_id，历史消息兼容（NULL） |
| 16 | nicknames 表 | `(channel_id, user_id)` 主键，CRUD 正常 |
| 17 | GET /api/channels | 返回 channel 列表 + 状态 |
| 18 | PATCH /api/nicknames | 设置昵称，返回 200 |
| 19 | POST /api/channels | 创建 channel，持久化到 channels.json |
| 20 | DELETE /api/channels/:id | 断开 + 删除 channel |
| 21 | WebSocket snapshot | 包含 channels + nicknames 初始数据 |

### 兼容性验收（不可回退）

| # | 验收项 | 通过条件 |
|---|--------|---------|
| 22 | 微信消息收发 | 发消息 → agent 回复 → 微信收到 |
| 23 | @mention 路由 | @geo xxx → 路由到 geo agent |
| 24 | 权限审批 | permission_request → 微信审批 → verdict 正常 |
| 25 | 媒体收发 | 图片/文件/语音双向正常 |
| 26 | Typing + ack | 10s 内无回复自动发"收到，正在处理..." |
| 27 | 离线投递 | agent 离线 → 消息排队 → 上线重放 |
| 28 | TypeScript 编译 | `npx tsc --noEmit` 无报错 |
| 29 | Vite 构建 | `npx vite build` 无报错 |

---

## 未纳入本次的内容（留后续迭代）

| 功能 | 原因 |
|------|------|
| QR 码重登 | 需要 WeixinConnection 暴露 QR 码获取接口，当前不支持 |
| 会话按联系人分组 | 改动大，当前按 agent+channel 筛选已够用 |
| 权限管理页 | TODO #4，独立功能 |
| 定时任务页 | TODO #1，独立功能 |
| Telegram channel | 接口已预留，待实现 TelegramChannel |
