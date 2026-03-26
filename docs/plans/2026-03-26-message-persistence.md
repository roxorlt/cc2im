# Message Persistence + Offline Delivery — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 消息持久化——所有 WeChat↔Agent 消息存 SQLite，spoke 离线期间消息入队，重连后自动回放。

**Architecture:** persistence 插件通过 HubContext 事件 hook 透明拦截消息流。`deliverToAgent()` 内部发射 `deliver:before`/`deliver:after` 事件，persistence 监听并存储。Agent 上线时自动回放积压消息。全量存储 30 天，未投递消息 24h TTL。

**Tech Stack:** better-sqlite3（同步 SQLite，Node.js 最快的 SQLite 绑定）、HubContext EventEmitter

---

## 消息流（改后）

```
入站（WeChat → Agent）:
  weixin plugin → ctx.deliverToAgent(agentId, msg)
    → HubContextImpl 发射 'deliver:before' → persistence 存入 SQLite
    → socketServer.send() → 成功/失败
    → HubContextImpl 发射 'deliver:after' { delivered: true/false }
    → persistence 标记 delivered_at（如成功）
    → 如失败：weixin 告诉用户 "消息已排队"（不再说"不在线"）

出站（Agent → WeChat）:
  spoke 发 reply → ctx.emit('spoke:message') → weixin 发微信
  persistence 监听 'spoke:message' type='reply' → 存入 SQLite（历史）

Agent 上线:
  hub 发射 'agent:online' → persistence 查 pending → 逐条回放
```

---

## 任务列表

### Task 1: 安装 better-sqlite3 + 创建 DB 模块

**Files:**
- Modify: `package.json`（添加依赖）
- Create: `src/plugins/persistence/db.ts`

**安装依赖**：

```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

**db.ts**：

```typescript
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { SOCKET_DIR } from '../../shared/socket.js'
import { randomUUID } from 'node:crypto'

const DB_PATH = join(SOCKET_DIR, 'cc2im.db')
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000    // 24h: 未投递超时
const HISTORY_TTL_DAYS = 30                      // 30d: 历史保留
const MAX_ROWS = 100_000                         // 硬上限

let db: Database.Database | null = null

export function openDb(): Database.Database {
  if (db) return db
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      msg_type TEXT DEFAULT 'text',
      media_path TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      expired INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending
      ON messages(agent_id, delivered_at) WHERE delivered_at IS NULL AND expired = 0;
    CREATE INDEX IF NOT EXISTS idx_created
      ON messages(created_at);
  `)

  return db
}

export function closeDb() {
  db?.close()
  db = null
}

/** Store an inbound message (WeChat → Agent) */
export function storeInbound(agentId: string, userId: string, text: string, msgType: string, mediaPath?: string): string {
  const id = randomUUID()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, msg_type, media_path, created_at)
    VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, msgType, mediaPath ?? null, new Date().toISOString())
  return id
}

/** Store an outbound message (Agent → WeChat) for history */
export function storeOutbound(agentId: string, userId: string, text: string): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, created_at, delivered_at)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, now, now)
  return id
}

/** Mark a message as delivered */
export function markDelivered(messageId: string) {
  openDb().prepare(`UPDATE messages SET delivered_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), messageId)
}

/** Get pending (undelivered, not expired) inbound messages for an agent */
export function getPending(agentId: string): Array<{
  id: string; userId: string; text: string; msgType: string; mediaPath: string | null; createdAt: string
}> {
  return openDb().prepare(`
    SELECT id, user_id as userId, text, msg_type as msgType, media_path as mediaPath, created_at as createdAt
    FROM messages
    WHERE agent_id = ? AND direction = 'inbound' AND delivered_at IS NULL AND expired = 0
    ORDER BY created_at ASC
  `).all(agentId) as any[]
}

/** Expire old undelivered messages (>24h) and clean up old history (>30d). Returns counts. */
export function cleanup(): { expired: number; deleted: number } {
  const d = openDb()
  const cutoff = new Date(Date.now() - DELIVERY_TTL_MS).toISOString()
  const expired = d.prepare(`
    UPDATE messages SET expired = 1
    WHERE delivered_at IS NULL AND expired = 0 AND created_at < ?
  `).run(cutoff).changes

  const histCutoff = new Date()
  histCutoff.setDate(histCutoff.getDate() - HISTORY_TTL_DAYS)
  const deleted = d.prepare(`DELETE FROM messages WHERE created_at < ?`)
    .run(histCutoff.toISOString()).changes

  // Hard limit safety net
  const count = (d.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c
  let extraDeleted = 0
  if (count > MAX_ROWS) {
    extraDeleted = d.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY created_at ASC LIMIT ?
      )
    `).run(count - MAX_ROWS).changes
  }

  if (expired > 0 || deleted > 0 || extraDeleted > 0) {
    d.exec('VACUUM')
  }
  return { expired, deleted: deleted + extraDeleted }
}
```

**验证**：`npx tsc --noEmit`

**Commit**: `feat: persistence db module — SQLite schema + CRUD`

---

### Task 2: HubContext 发射 delivery 事件

**Files:**
- Modify: `src/hub/hub-context.ts`

**改动**：在 `deliverToAgent()` 内发射事件，让 persistence 可以 hook 进来。

```typescript
import { randomUUID } from 'node:crypto'

// 在 deliverToAgent 方法中：
deliverToAgent(agentId: string, msg: HubToSpoke): boolean {
  const messageId = randomUUID()
  this.emit('deliver:before', agentId, msg, messageId)
  const ok = this.socketServer.send(agentId, msg)
  this.emit('deliver:after', messageId, ok)
  return ok
}
```

**注意**：HubToSpoke 目前是 `HubToSpokeMessage | HubToSpokePermission | HubToSpokeManagementResult`。persistence 只关心 `type: 'message'`，其他类型（permission_verdict 等）不存。这在 persistence 插件内过滤。

**验证**：`npx tsc --noEmit` + 重启验证微信消息正常（事件 emit 不影响现有行为）

**Commit**: `feat: emit deliver:before/after events in HubContext`

---

### Task 3: 创建 persistence 插件

**Files:**
- Create: `src/plugins/persistence/index.ts`

```typescript
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { openDb, closeDb, storeInbound, storeOutbound, markDelivered, getPending, cleanup } from './db.js'
import type { HubToSpokeMessage } from '../../shared/types.js'

const REPLAY_DELAY_MS = 500    // 回放消息间隔
const CLEANUP_INTERVAL = 60 * 60 * 1000  // 每小时清理一次

export function createPersistencePlugin(): Cc2imPlugin {
  let cleanupTimer: ReturnType<typeof setInterval>
  // Track messageId → { agentId, stored } for delivery correlation
  const pendingDeliveries = new Map<string, { agentId: string; messageId: string }>()

  return {
    name: 'persistence',
    init(ctx: HubContext) {
      openDb()
      console.log('[persistence] SQLite opened')

      // --- Store inbound messages before delivery ---
      ctx.on('deliver:before', (agentId: string, msg: any, messageId: string) => {
        if (msg.type !== 'message') return  // only persist user messages, not permission verdicts
        const m = msg as HubToSpokeMessage
        const dbId = storeInbound(agentId, m.userId, m.text, m.msgType, m.mediaPath)
        pendingDeliveries.set(messageId, { agentId, messageId: dbId })
      })

      // --- Mark delivered after successful send ---
      ctx.on('deliver:after', (messageId: string, delivered: boolean) => {
        const entry = pendingDeliveries.get(messageId)
        if (!entry) return
        pendingDeliveries.delete(messageId)
        if (delivered) {
          markDelivered(entry.messageId)
        }
      })

      // --- Store outbound replies for history ---
      ctx.on('spoke:message', (_agentId: string, msg: any) => {
        if (msg.type === 'reply') {
          storeOutbound(msg.agentId, msg.userId, msg.text)
        }
      })

      // --- Replay pending messages when agent comes online ---
      ctx.on('agent:online', async (agentId: string) => {
        const pending = getPending(agentId)
        if (pending.length === 0) return

        console.log(`[persistence] Replaying ${pending.length} queued message(s) to "${agentId}"`)

        // Send a heads-up first
        ctx.deliverToAgent(agentId, {
          type: 'message',
          userId: 'system',
          text: `[系统] 你离线期间收到 ${pending.length} 条消息，正在回放：`,
          msgType: 'text',
          timestamp: new Date().toISOString(),
        })

        for (const msg of pending) {
          await new Promise(r => setTimeout(r, REPLAY_DELAY_MS))
          const ok = ctx.deliverToAgent(agentId, {
            type: 'message',
            userId: msg.userId,
            text: msg.text,
            msgType: msg.msgType,
            mediaPath: msg.mediaPath ?? undefined,
            timestamp: msg.createdAt,
          })
          if (ok) markDelivered(msg.id)
        }

        console.log(`[persistence] Replay complete for "${agentId}"`)
      })

      // --- Periodic cleanup ---
      cleanupTimer = setInterval(() => {
        const { expired, deleted } = cleanup()
        if (expired > 0 || deleted > 0) {
          console.log(`[persistence] Cleanup: ${expired} expired, ${deleted} deleted`)
        }
      }, CLEANUP_INTERVAL)

      // Run cleanup once on startup
      cleanup()
    },

    destroy() {
      if (cleanupTimer) clearInterval(cleanupTimer)
      closeDb()
      console.log('[persistence] SQLite closed')
    },
  }
}
```

**验证**：`npx tsc --noEmit`

**Commit**: `feat: persistence plugin — store, replay, cleanup`

---

### Task 4: 注册 persistence 插件 + weixin 离线处理

**Files:**
- Modify: `src/hub/index.ts`（注册插件，必须在 weixin 之前）
- Modify: `src/plugins/weixin/index.ts`（离线时说"已排队"而非"不在线"）

**hub/index.ts 改动**：

```typescript
import { createPersistencePlugin } from '../plugins/persistence/index.js'

// 在 pluginManager.register 处，persistence 必须在 weixin 之前注册
// （这样 deliver:before 事件 persistence 先收到）
pluginManager.register(createPersistencePlugin())
pluginManager.register(createWeixinPlugin())
pluginManager.register(createWebMonitorPlugin())
```

**weixin/index.ts 改动**：

找到 "Check if agent is connected" 那段代码（约第 90-96 行），改为：

```typescript
// Forward to spoke — persistence plugin will queue if offline
const text = buildMessageContent(incomingMsg, routed.text)
console.log(`[hub] Forwarding to ${routed.agentId}: ${text.substring(0, 80)}`)
ctx.broadcastMonitor({ kind: 'message_in', agentId: routed.agentId, userId, text: routed.text, timestamp: new Date().toISOString() })
const sent = ctx.deliverToAgent(routed.agentId, {
  type: 'message',
  userId,
  text,
  msgType: incomingMsg.type,
  mediaPath: incomingMsg.mediaPath ?? undefined,
  timestamp: incomingMsg.timestamp?.toISOString() ?? new Date().toISOString(),
})
if (!sent) {
  console.log(`[hub] Message queued for offline agent "${routed.agentId}"`)
  await weixin.send(userId, `📬 ${routed.agentId} 暂时离线，消息已排队，上线后自动投递。`)
}
```

即：删掉 online check 的 early return，总是尝试投递，失败则告知用户已排队。

**验证**：
1. `npx tsc --noEmit`
2. 重启 hub
3. 验证正常消息收发
4. 检查 `~/.cc2im/cc2im.db` 文件存在

**Commit**: `feat: register persistence plugin, handle offline queuing`

---

### Task 5: 集成测试

**不写代码，只做验证。**

**基本功能**：
```bash
# 1. 重启 hub
npx tsx src/cli.ts uninstall && npx tsx src/cli.ts install

# 2. 等待启动
sleep 12

# 3. 检查插件加载
grep 'persistence\|Initialized' ~/.cc2im/hub.log | tail -5

# 4. 检查 SQLite 文件
ls -la ~/.cc2im/cc2im.db

# 5. 发一条微信消息，确认收到回复

# 6. 检查消息是否入库
sqlite3 ~/.cc2im/cc2im.db "SELECT id, direction, agent_id, substr(text,1,50), delivered_at FROM messages ORDER BY created_at DESC LIMIT 5;"
```

**离线回放测试**：
```bash
# 1. 记录当前 spoke PID
SPOKE_PID=$(ps aux | grep 'spoke/index.*brain' | grep -v grep | head -1 | awk '{print $2}')

# 2. 停掉 brain agent（模拟离线）
# 通过微信发送: @brain /restart 命令，或手动 kill
kill $SPOKE_PID

# 3. 在 brain 离线期间，从微信发几条消息给 brain
# 应收到 "📬 brain 暂时离线，消息已排队..."

# 4. 检查消息是否入库且未投递
sqlite3 ~/.cc2im/cc2im.db "SELECT id, substr(text,1,50), delivered_at FROM messages WHERE agent_id='brain' AND delivered_at IS NULL;"

# 5. 等 agent 自动重启（autoStart），或手动重启
# hub 的 auto-restart 会在约 10 秒后重启

# 6. 检查 hub 日志，应看到回放
grep 'Replaying\|Replay complete' ~/.cc2im/hub.log | tail -5

# 7. 确认 brain 收到了排队的消息（回复应到达微信）
```

---

## 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | `~/.cc2im/cc2im.db` 文件存在，含 messages 表 | `sqlite3 ... ".tables"` |
| 2 | 正常消息收发不受影响 | 微信发消息验证 |
| 3 | 每条消息（入站+出站）都存入 SQLite | `sqlite3 ... "SELECT COUNT(*) ..."` |
| 4 | Agent 离线时用户收到"已排队"提示 | 微信验证 |
| 5 | Agent 重新上线后积压消息自动回放 | hub.log 检查 + 微信收到回复 |
| 6 | 回放前有"离线期间收到 N 条消息"提示 | CC 对话检查 |
| 7 | `npx tsc --noEmit` 无报错 | 编译检查 |
| 8 | 定期清理正常运行（hub.log 无报错） | 日志检查 |
| 9 | Dashboard 和微信消息流正常 | 浏览器 + 微信验证 |

---

## 注意事项

- **插件注册顺序**：persistence 必须在 weixin 之前注册，确保 `deliver:before` 事件 persistence 先收到
- **better-sqlite3 是 native 模块**：需要 npm install 编译。如果编译失败，备选方案是用 `sql.js`（纯 JS 实现的 SQLite）
- **回放不会触发二次存储**：回放消息也经过 `deliverToAgent()`，会触发 `deliver:before`。persistence 需要在回放时跳过二次存储。在 replay 函数中设一个 `replaying` flag 即可
- **system 消息不存**：回放提示消息的 userId='system'，persistence 应跳过 userId='system' 的消息
