# Hub 定时任务调度 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 hub 层实现持久化定时任务调度，到点给指定 agent 发消息，复用现有离线投递机制。

**Architecture:** 新增 `cron-scheduler` 插件，SQLite 存储任务和执行日志，主循环每 10 秒检查到期任务，通过 `ctx.deliverToAgent()` 投递消息。Spoke 侧新增 MCP 工具让 agent 可以创建/查询/删除定时任务。

**Tech Stack:** better-sqlite3（已有）、croner（新增，cron 表达式解析）、TypeScript

**依赖库安装：** `npm install croner`（轻量 cron 解析器，无依赖，支持 5/6 段表达式 + 时区）

---

## Task 1: 类型定义

**Files:**
- Modify: `src/shared/types.ts`

**Step 1: 扩展 management action 联合类型，新增 cron 管理消息类型**

在 `src/shared/types.ts` 末尾添加 cron 相关类型，并修改 `SpokeToHubManagement.action` 类型：

```typescript
// --- 修改现有 SpokeToHubManagement ---
// action 字段从：
//   'register' | 'deregister' | 'start' | 'stop' | 'list'
// 改为：
//   'register' | 'deregister' | 'start' | 'stop' | 'list'
//   | 'cron_create' | 'cron_list' | 'cron_delete' | 'cron_update'

// --- 新增类型 ---

export interface CronJob {
  id: string
  name: string
  agentId: string
  scheduleType: 'cron' | 'once' | 'interval'
  scheduleValue: string   // cron 表达式 | ISO 时间戳 | 毫秒数
  timezone: string         // IANA 时区，默认系统时区
  message: string          // 发给 agent 的消息内容
  enabled: boolean
  nextRun: string | null   // ISO 时间戳
  createdAt: string
  createdBy: string        // 'dashboard' | agent 名
}

export interface CronRun {
  id: string
  jobId: string
  firedAt: string
  status: 'delivered' | 'queued' | 'failed'
  detail?: string
}
```

**Step 2: 扩展 HubEventData.kind 联合类型**

在 `HubEventData` 的 `kind` 联合类型中新增 `'cron_fired'`，用于 Dashboard 实时推送：

```typescript
kind: '..existing..' | 'cron_fired'
```

**Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(cron): add CronJob/CronRun types and extend management actions"
```

---

## Task 2: 数据库层

**Files:**
- Create: `src/plugins/cron-scheduler/db.ts`

**Step 1: 创建 cron 数据库模块**

遵循 `src/plugins/persistence/db.ts` 的模式（共用同一个 db 文件 `~/.cc2im/cc2im.db`），但 import 已有的 db 实例而非新开连接。

```typescript
// src/plugins/cron-scheduler/db.ts
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { SOCKET_DIR } from '../../shared/socket.js'
import { randomUUID } from 'node:crypto'
import type { CronJob, CronRun } from '../../shared/types.js'

const DB_PATH = join(SOCKET_DIR, 'cc2im.db')
let db: Database.Database | null = null

export function openCronDb(): Database.Database {
  if (db) return db
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'once', 'interval')),
      schedule_value TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      message TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'dashboard'
    );
    CREATE INDEX IF NOT EXISTS idx_cron_next
      ON cron_jobs(next_run) WHERE enabled = 1;

    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('delivered', 'queued', 'failed')),
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_job
      ON cron_runs(job_id, fired_at);
  `)

  return db
}

export function closeCronDb() {
  if (db) { db.close(); db = null }
}
```

**Step 2: 添加 CRUD 函数**

同文件中继续添加：

```typescript
export function createJob(job: Omit<CronJob, 'id' | 'createdAt'>): CronJob {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const d = openCronDb()
  d.prepare(`
    INSERT INTO cron_jobs (id, name, agent_id, schedule_type, schedule_value, timezone, message, enabled, next_run, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, job.name, job.agentId, job.scheduleType, job.scheduleValue, job.timezone, job.message, job.enabled ? 1 : 0, job.nextRun, createdAt, job.createdBy)
  return { id, ...job, createdAt }
}

export function deleteJob(id: string): boolean {
  const d = openCronDb()
  const r = d.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
  return r.changes > 0
}

export function updateJob(id: string, updates: Partial<Pick<CronJob, 'enabled' | 'nextRun' | 'name' | 'message' | 'scheduleValue' | 'scheduleType' | 'timezone'>>): boolean {
  const d = openCronDb()
  const sets: string[] = []
  const vals: any[] = []
  if (updates.enabled !== undefined) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0) }
  if (updates.nextRun !== undefined) { sets.push('next_run = ?'); vals.push(updates.nextRun) }
  if (updates.name !== undefined) { sets.push('name = ?'); vals.push(updates.name) }
  if (updates.message !== undefined) { sets.push('message = ?'); vals.push(updates.message) }
  if (updates.scheduleValue !== undefined) { sets.push('schedule_value = ?'); vals.push(updates.scheduleValue) }
  if (updates.scheduleType !== undefined) { sets.push('schedule_type = ?'); vals.push(updates.scheduleType) }
  if (updates.timezone !== undefined) { sets.push('timezone = ?'); vals.push(updates.timezone) }
  if (sets.length === 0) return false
  vals.push(id)
  const r = d.prepare(`UPDATE cron_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return r.changes > 0
}

export function listJobs(agentId?: string): CronJob[] {
  const d = openCronDb()
  const sql = agentId
    ? 'SELECT * FROM cron_jobs WHERE agent_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM cron_jobs ORDER BY created_at DESC'
  const rows = agentId ? d.prepare(sql).all(agentId) : d.prepare(sql).all()
  return rows.map(rowToJob)
}

export function getEnabledJobs(): CronJob[] {
  const d = openCronDb()
  return d.prepare('SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run ASC').all().map(rowToJob)
}

export function recordRun(jobId: string, status: CronRun['status'], detail?: string): string {
  const d = openCronDb()
  const id = randomUUID()
  const firedAt = new Date().toISOString()
  d.prepare('INSERT INTO cron_runs (id, job_id, fired_at, status, detail) VALUES (?, ?, ?, ?, ?)').run(id, jobId, firedAt, status, detail)
  return id
}

export function getRecentRuns(jobId: string, limit = 20): CronRun[] {
  const d = openCronDb()
  return d.prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY fired_at DESC LIMIT ?').all(jobId, limit) as CronRun[]
}

/** 清理 30 天前的执行日志 */
export function cleanupRuns(): number {
  const d = openCronDb()
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const r = d.prepare('DELETE FROM cron_runs WHERE fired_at < ?').run(cutoff)
  return r.changes
}

function rowToJob(row: any): CronJob {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    timezone: row.timezone,
    message: row.message,
    enabled: !!row.enabled,
    nextRun: row.next_run,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }
}
```

**Step 3: Commit**

```bash
git add src/plugins/cron-scheduler/db.ts
git commit -m "feat(cron): add SQLite schema and CRUD for cron_jobs/cron_runs"
```

---

## Task 3: 调度器核心

**Files:**
- Create: `src/plugins/cron-scheduler/scheduler.ts`

**Step 1: 安装 croner**

```bash
npm install croner
```

**Step 2: 实现调度器类**

```typescript
// src/plugins/cron-scheduler/scheduler.ts
import { Cron } from 'croner'
import type { HubContext } from '../../shared/plugin.js'
import type { HubToSpokeMessage } from '../../shared/types.js'
import { getEnabledJobs, updateJob, recordRun, cleanupRuns } from './db.js'

const TICK_INTERVAL_MS = 10_000  // 每 10 秒检查一次
const CLEANUP_INTERVAL_MS = 60 * 60_000  // 每小时清理一次旧日志

export class CronScheduler {
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private ctx: HubContext

  constructor(ctx: HubContext) {
    this.ctx = ctx
  }

  start() {
    // 启动时计算所有任务的 next_run
    this.recalcAll()
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    this.cleanupTimer = setInterval(() => cleanupRuns(), CLEANUP_INTERVAL_MS)
    console.log('[cron] Scheduler started')
  }

  stop() {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null }
    console.log('[cron] Scheduler stopped')
  }

  /** 主循环：检查到期任务并触发 */
  private tick() {
    const now = new Date()
    const jobs = getEnabledJobs()

    for (const job of jobs) {
      if (!job.nextRun) continue
      const nextRun = new Date(job.nextRun)
      if (nextRun > now) continue

      // 到期 — 投递
      this.fire(job)

      // 计算下一次执行时间
      const next = this.calcNextRun(job.scheduleType, job.scheduleValue, job.timezone)
      if (next) {
        updateJob(job.id, { nextRun: next })
      } else {
        // once 类型或无下一次 → 禁用
        updateJob(job.id, { enabled: false, nextRun: null })
      }
    }
  }

  /** 投递消息到目标 agent */
  private fire(job: { id: string; name: string; agentId: string; message: string }) {
    const msg: HubToSpokeMessage = {
      type: 'message',
      userId: `cron:${job.name}`,
      text: job.message,
      msgType: 'text',
      timestamp: new Date().toISOString(),
    }

    const delivered = this.ctx.deliverToAgent(job.agentId, msg)
    const status = delivered ? 'delivered' : 'queued'
    recordRun(job.id, status, delivered ? undefined : 'agent offline, queued for replay')

    console.log(`[cron] Fired "${job.name}" → ${job.agentId} [${status}]`)

    this.ctx.broadcastMonitor({
      kind: 'cron_fired',
      agentId: job.agentId,
      timestamp: new Date().toISOString(),
      text: `[cron] ${job.name}`,
    })
  }

  /** 计算下一次执行时间 */
  calcNextRun(type: string, value: string, timezone: string): string | null {
    switch (type) {
      case 'cron': {
        const job = new Cron(value, { timezone })
        const next = job.nextRun()
        return next ? next.toISOString() : null
      }
      case 'once': {
        const t = new Date(value)
        // 如果时间已过，返回 null（once 只执行一次）
        return t > new Date() ? t.toISOString() : null
      }
      case 'interval': {
        const ms = parseInt(value, 10)
        if (isNaN(ms) || ms <= 0) return null
        return new Date(Date.now() + ms).toISOString()
      }
      default:
        return null
    }
  }

  /** 重新计算所有 enabled 任务的 next_run */
  recalcAll() {
    const jobs = getEnabledJobs()
    for (const job of jobs) {
      const next = this.calcNextRun(job.scheduleType, job.scheduleValue, job.timezone)
      if (next) {
        updateJob(job.id, { nextRun: next })
      } else if (job.scheduleType === 'once') {
        // once 已过期 → 禁用
        updateJob(job.id, { enabled: false, nextRun: null })
      }
    }
    console.log(`[cron] Recalculated ${jobs.length} jobs`)
  }
}
```

**Step 3: Commit**

```bash
git add src/plugins/cron-scheduler/scheduler.ts package.json package-lock.json
git commit -m "feat(cron): implement CronScheduler with tick loop and delivery"
```

---

## Task 4: 插件封装 + Hub 集成

**Files:**
- Create: `src/plugins/cron-scheduler/index.ts`
- Modify: `src/hub/index.ts:67-71`（插件注册）
- Modify: `src/hub/index.ts:96-174`（handleManagement 增加 cron 分支）

**Step 1: 创建插件入口**

```typescript
// src/plugins/cron-scheduler/index.ts
import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { openCronDb, closeCronDb, createJob, deleteJob, updateJob, listJobs, getRecentRuns } from './db.js'
import { CronScheduler } from './scheduler.js'

export function createCronSchedulerPlugin(): Cc2imPlugin {
  let scheduler: CronScheduler | null = null

  return {
    name: 'cron-scheduler',
    init(ctx: HubContext) {
      openCronDb()
      console.log('[cron-scheduler] SQLite tables ready')

      scheduler = new CronScheduler(ctx)
      scheduler.start()
    },
    destroy() {
      scheduler?.stop()
      closeCronDb()
      console.log('[cron-scheduler] Stopped')
    },
  }
}

// Re-export DB functions for handleManagement to use
export { createJob, deleteJob, updateJob, listJobs, getRecentRuns } from './db.js'
```

**Step 2: 在 hub/index.ts 中注册插件**

在 `src/hub/index.ts` 插件注册区域（约 line 69）添加：

```typescript
import { createCronSchedulerPlugin } from '../plugins/cron-scheduler/index.js'
// ...
pluginManager.register(createCronSchedulerPlugin())
```

放在 `createPersistencePlugin()` 之后（cron 消息需要走 persistence 的离线投递）。

**Step 3: 在 handleManagement 中添加 cron 分支**

在 `src/hub/index.ts` 的 `handleManagement` 函数 switch 语句中，`default` 之前添加：

```typescript
case 'cron_create': {
  const { createJob: dbCreate } = await import('../plugins/cron-scheduler/index.js')
  const { CronScheduler } = await import('../plugins/cron-scheduler/scheduler.js')

  const p = msg.params!
  // 用临时 scheduler 实例算 nextRun（只用 calcNextRun 方法）
  const tmpSched = new CronScheduler(ctx)
  const nextRun = tmpSched.calcNextRun(p.scheduleType!, p.scheduleValue!, p.timezone || 'Asia/Shanghai')

  if (!nextRun && p.scheduleType !== 'once') {
    result = { success: false, error: `Invalid schedule: ${p.scheduleType} "${p.scheduleValue}"` }
    break
  }

  const job = dbCreate({
    name: p.name!,
    agentId: p.agentId || agentId,  // 默认发给自己
    scheduleType: p.scheduleType!,
    scheduleValue: p.scheduleValue!,
    timezone: p.timezone || 'Asia/Shanghai',
    message: p.message!,
    enabled: true,
    nextRun,
    createdBy: agentId,
  })
  result = { success: true, data: job }
  break
}

case 'cron_list': {
  const { listJobs: dbList, getRecentRuns: dbRuns } = await import('../plugins/cron-scheduler/index.js')
  const jobs = dbList(msg.params?.agentId)
  const data = jobs.map(j => ({
    ...j,
    recentRuns: dbRuns(j.id, 5),
  }))
  result = { success: true, data }
  break
}

case 'cron_delete': {
  const { deleteJob: dbDelete } = await import('../plugins/cron-scheduler/index.js')
  const ok = dbDelete(msg.params!.jobId!)
  result = ok ? { success: true } : { success: false, error: 'Job not found' }
  break
}

case 'cron_update': {
  const { updateJob: dbUpdate } = await import('../plugins/cron-scheduler/index.js')
  const { jobId, ...updates } = msg.params as any
  const ok = dbUpdate(jobId, updates)
  result = ok ? { success: true } : { success: false, error: 'Job not found' }
  break
}
```

**Step 4: Commit**

```bash
git add src/plugins/cron-scheduler/index.ts src/hub/index.ts
git commit -m "feat(cron): add cron-scheduler plugin and hub management handlers"
```

---

## Task 5: Spoke MCP 工具

**Files:**
- Modify: `src/spoke/channel-server.ts`（工具定义 + 调用处理）

**Step 1: 添加工具定义**

在 `ListToolsRequestSchema` handler 的工具数组中（`agent_list` 之后）添加：

```typescript
{
  name: 'hub_cron_create',
  description: '创建持久化定时任务（hub 管理，重启不丢失）。到点给指定 agent 发一条消息。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '任务名称（如"每日晨报"）' },
      agent_id: { type: 'string', description: '目标 agent 名称（默认自己）' },
      schedule_type: { type: 'string', enum: ['cron', 'once', 'interval'], description: 'cron=重复(cron表达式) | once=一次性(ISO时间戳) | interval=固定间隔(毫秒)' },
      schedule_value: { type: 'string', description: 'cron: "0 9 * * *" | once: "2026-04-01T09:00:00+08:00" | interval: "3600000"' },
      timezone: { type: 'string', description: 'IANA 时区（默认 Asia/Shanghai）' },
      message: { type: 'string', description: '到点发给 agent 的消息内容' },
    },
    required: ['name', 'schedule_type', 'schedule_value', 'message'],
  },
},
{
  name: 'hub_cron_list',
  description: '列出持久化定时任务（可按 agent 筛选）',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agent_id: { type: 'string', description: '按 agent 筛选（不填则列出所有）' },
    },
  },
},
{
  name: 'hub_cron_delete',
  description: '删除一个持久化定时任务',
  inputSchema: {
    type: 'object' as const,
    properties: {
      job_id: { type: 'string', description: '任务 ID' },
    },
    required: ['job_id'],
  },
},
```

**Step 2: 添加调用处理**

在 `CallToolRequestSchema` handler 的 switch 语句中添加：

```typescript
case 'hub_cron_create': {
  const { name, agent_id, schedule_type, schedule_value, timezone, message } = args as any
  const result = await sendManagement(socketClient, agentId, 'cron_create', {
    name, agentId: agent_id, scheduleType: schedule_type,
    scheduleValue: schedule_value, timezone, message,
  })
  if (!result.success) {
    return { content: [{ type: 'text' as const, text: `创建失败: ${result.error}` }], isError: true }
  }
  const job = result.data
  return {
    content: [{ type: 'text' as const, text:
      `✅ 定时任务已创建\n` +
      `ID: ${job.id}\n` +
      `名称: ${job.name}\n` +
      `目标: ${job.agentId}\n` +
      `调度: ${job.scheduleType} "${job.scheduleValue}"\n` +
      `下次执行: ${job.nextRun}\n` +
      `消息: ${job.message}`
    }],
  }
}

case 'hub_cron_list': {
  const { agent_id } = args as any
  const result = await sendManagement(socketClient, agentId, 'cron_list', { agentId: agent_id })
  if (!result.success) {
    return { content: [{ type: 'text' as const, text: `查询失败: ${result.error}` }], isError: true }
  }
  const jobs = result.data as any[]
  if (jobs.length === 0) {
    return { content: [{ type: 'text' as const, text: '没有定时任务' }] }
  }
  const lines = jobs.map((j: any) => {
    const status = j.enabled ? '🟢' : '⏸️'
    const runs = j.recentRuns?.length ? ` (最近: ${j.recentRuns[0].status} @ ${j.recentRuns[0].firedAt})` : ''
    return `${status} ${j.name} [${j.scheduleType}: ${j.scheduleValue}] → ${j.agentId}\n   下次: ${j.nextRun || '无'}${runs}\n   ID: ${j.id}`
  })
  return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] }
}

case 'hub_cron_delete': {
  const { job_id } = args as any
  const result = await sendManagement(socketClient, agentId, 'cron_delete', { jobId: job_id })
  return {
    content: [{ type: 'text' as const, text: result.success ? '✅ 定时任务已删除' : `删除失败: ${result.error}` }],
    isError: !result.success,
  }
}
```

**Step 3: Commit**

```bash
git add src/spoke/channel-server.ts
git commit -m "feat(cron): add hub_cron_create/list/delete MCP tools"
```

---

## Task 6: 端到端验证

**Step 1: 编译检查**

```bash
cd /Users/roxor/brain/30-projects/cc2im
npx tsc --noEmit
```

Expected: 无类型错误。如有错误，逐个修复。

**Step 2: 启动 hub 验证插件加载**

```bash
npx tsx src/hub/index.ts
```

Expected 日志包含：
```
[cron-scheduler] SQLite tables ready
[cron] Recalculated 0 jobs
[cron] Scheduler started
```

**Step 3: 通过 socket 脚本创建测试任务**

写一个临时 Node.js 脚本连接 hub socket，发送 cron_create management 消息：

```bash
node -e "
const net = require('net');
const path = require('path');
const sock = path.join(require('os').homedir(), '.cc2im', 'hub.sock');
const client = net.createConnection(sock, () => {
  client.write(JSON.stringify({ type: 'register', agentId: '_test', pid: process.pid }) + '\n');
  setTimeout(() => {
    client.write(JSON.stringify({
      type: 'management', action: 'cron_create', requestId: 'test1',
      params: {
        name: '测试任务',
        agentId: 'brain',
        scheduleType: 'once',
        scheduleValue: new Date(Date.now() + 30000).toISOString(),  // 30秒后
        message: '这是一条定时任务测试消息',
      }
    }) + '\n');
  }, 300);
});
let buf = '';
client.on('data', (chunk) => {
  buf += chunk.toString();
  const lines = buf.split('\n'); buf = lines.pop();
  for (const line of lines) {
    if (line.trim()) { console.log(JSON.parse(line)); }
  }
  setTimeout(() => process.exit(0), 1000);
});
setTimeout(() => process.exit(1), 5000);
"
```

Expected: 返回 `{ type: 'management_result', success: true, data: { id: '...', name: '测试任务', ... } }`

**Step 4: 等 30 秒，检查 hub 日志**

Expected 日志：
```
[cron] Fired "测试任务" → brain [delivered]
```

或如果 brain 离线：
```
[cron] Fired "测试任务" → brain [queued]
```

**Step 5: 验证 cron_list**

用同样的 socket 脚本发送 `cron_list`，确认任务在列表中且 `enabled: false`（once 执行后自动禁用）。

**Step 6: 验证 interval 类型**

创建一个 60 秒间隔的任务，观察是否每 60 秒触发一次。验证后通过 `cron_delete` 删除。

**Step 7: 验证 cron 类型**

创建 `*/1 * * * *`（每分钟）任务，观察触发，验证后删除。

**Step 8: Commit 最终修复（如有）**

```bash
git add -A
git commit -m "fix(cron): address issues found during e2e verification"
```

---

## 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | hub 启动时自动加载 cron-scheduler 插件 | hub 日志包含 `[cron-scheduler] SQLite tables ready` |
| 2 | 三种调度类型都能正确计算 next_run | cron_create 返回的 nextRun 值合理 |
| 3 | 到期任务被投递到目标 agent | hub 日志 `[cron] Fired ... [delivered]` |
| 4 | agent 离线时消息进入离线队列 | hub 日志 `[cron] Fired ... [queued]`，agent 上线后收到消息 |
| 5 | once 类型执行后自动禁用 | cron_list 显示 `enabled: false` |
| 6 | interval 类型持续重复执行 | 连续观察 2-3 次触发 |
| 7 | cron 表达式支持时区 | 创建带 timezone 的任务，nextRun 计算正确 |
| 8 | cron_delete 能删除任务 | 删除后 cron_list 不再显示 |
| 9 | 执行日志记录在 cron_runs | cron_list 返回的 recentRuns 不为空 |
| 10 | hub 重启后定时任务恢复 | 重启 hub，已有任务仍在 cron_list 中且继续调度 |
| 11 | MCP 工具可被 agent 调用 | agent 通过 hub_cron_create 成功创建任务 |
| 12 | Dashboard 收到 cron_fired 事件 | WebSocket 推送 `kind: 'cron_fired'` |
| 13 | `npx tsc --noEmit` 无类型错误 | 编译通过 |

## 暂不实现（后续迭代）

- Dashboard GUI（等改版分支合并后再做）
- cron 可视化编辑器
- 任务暂停/恢复 UI
- 批量操作
- 执行超时控制
