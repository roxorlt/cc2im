# Cost & Usage Metrics — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dashboard TopBar 新增等值 API 成本（当日 + 30 天日均）和订阅用量占比（5h/7d），让用户一目了然消耗情况。

**Architecture:** 新增 `token-stats` 插件（从 web-monitor 拆出独立数据层），提供 `/api/tokens` 含成本计算和 `/api/usage` 从 Keychain 读 OAuth token 调 Anthropic API 获取用量。前端 TopBar 右侧新增 3 个指标区。

**Tech Stack:** Node.js (child_process for security read), Anthropic OAuth API, React, TypeScript

---

## 技术路线（已验证）

| 数据 | 来源 | 验证状态 |
|------|------|---------|
| Token 用量（当日/30 天） | `~/.claude/projects/*.jsonl` 解析 | ✅ 已有 |
| 等值 API 成本 | 本地 pricing.json + token 数据计算 | ✅ 公式确定 |
| 5h/7d 用量占比 | macOS Keychain OAuth token → `GET /api/oauth/usage` | ✅ 已验证返回数据 |

### 定价基准（Opus 4.6, 2026-03-26）

```
input:       $5/M
output:      $25/M
cacheRead:   $0.50/M
cacheCreate: $6.25/M  (1h ephemeral)
```

### OAuth Usage API 响应

```json
{
  "five_hour": { "utilization": 10.0, "resets_at": "2026-03-26T09:00:00Z" },
  "seven_day": { "utilization": 14.0, "resets_at": "2026-03-30T00:00:01Z" }
}
```

---

## UI 布局

```
TopBar 左侧（现有，不变）:
[cc2im 0h5m] | Context In: 1.2B | Generated: 45.3M | Today: 130.7M

TopBar 右侧（新增）:
 ≈$12.50 today | $8.20/day | 5h ██░░░ 10% ↻14:00 | 7d █░░░░ 14% ↻3/30
```

---

## 任务列表

### Task 1: 创建 pricing.json

**Files:**
- Create: `src/plugins/web-monitor/pricing.json`

```json
{
  "lastChecked": "2026-03-26",
  "source": "https://docs.anthropic.com/en/docs/about-claude/models",
  "models": {
    "claude-opus-4-6": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheCreate": 6.25
    },
    "claude-sonnet-4-6": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheCreate": 3.75
    },
    "claude-haiku-4-5": {
      "input": 1,
      "output": 5,
      "cacheRead": 0.1,
      "cacheCreate": 1.25
    }
  }
}
```

**验证**：文件存在，JSON 合法

**Commit**: `feat: add pricing.json for API cost calculation`

---

### Task 2: 后端 — token-stats 加成本计算

**Files:**
- Modify: `src/plugins/web-monitor/token-stats.ts`

**改动**：

1. import pricing.json
2. `DailyTokens` 接口加 `cost?: number`
3. `TokenStats` 接口加 `todayCost?: number` 和 `avgDailyCost?: number`
4. 在 `getTokenStats()` 返回前计算成本

```typescript
import pricing from './pricing.json' with { type: 'json' }

// 在 DailyTokens 接口加:
export interface DailyTokens {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  cost?: number  // 等值 API 成本 (USD)
}

export interface TokenStats {
  daily: DailyTokens[]
  lastUpdated: string
  todayCost?: number
  avgDailyCost?: number
  pricingDate?: string  // pricing.json 的 lastChecked
}
```

计算逻辑（在 `computeTokenStats()` 返回前）：

```typescript
// 默认用 opus 定价（CC 订阅主力模型）
const p = pricing.models['claude-opus-4-6']
for (const d of sorted) {
  d.cost = (d.input * p.input + d.output * p.output + d.cacheRead * p.cacheRead + d.cacheCreate * p.cacheCreate) / 1_000_000
}

const today = new Date().toISOString().split('T')[0]
const todayData = sorted.find(d => d.date === today)
const last30 = sorted.slice(-30)
const totalCost = last30.reduce((s, d) => s + (d.cost || 0), 0)

return {
  daily: sorted,
  lastUpdated: new Date().toISOString(),
  todayCost: todayData?.cost,
  avgDailyCost: last30.length > 0 ? totalCost / last30.length : undefined,
  pricingDate: pricing.lastChecked,
}
```

**验证**：
1. `npx tsc --noEmit`
2. `curl http://127.0.0.1:3721/api/tokens | python3 -m json.tool` — 检查 `todayCost`、`avgDailyCost` 字段存在

**Commit**: `feat: add API cost calculation to token stats`

---

### Task 3: 后端 — 新增 /api/usage 端点

**Files:**
- Create: `src/plugins/web-monitor/usage-stats.ts`
- Modify: `src/plugins/web-monitor/server.ts`

**usage-stats.ts**（从 Keychain 读 OAuth token，调 Anthropic API）：

```typescript
import { execSync } from 'node:child_process'

export interface UsageStats {
  fiveHour?: { utilization: number; resetsAt: string }
  sevenDay?: { utilization: number; resetsAt: string }
  lastUpdated: string
  error?: string
}

let cachedUsage: UsageStats | null = null
let lastFetchTime = 0
const CACHE_TTL_MS = 60_000 // 每 60 秒刷新一次（避免频繁调 API）

export function getUsageStats(): UsageStats {
  const now = Date.now()
  if (cachedUsage && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedUsage
  }

  cachedUsage = fetchUsage()
  lastFetchTime = now
  return cachedUsage
}

function fetchUsage(): UsageStats {
  try {
    // 从 macOS Keychain 读取 OAuth token
    const creds = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
    const { claudeAiOauth } = JSON.parse(creds)
    if (!claudeAiOauth?.accessToken) {
      return { lastUpdated: new Date().toISOString(), error: 'No OAuth token found' }
    }

    // 调 Anthropic usage API
    const res = execSync(
      `curl -s -H "Authorization: Bearer ${claudeAiOauth.accessToken}" -H "anthropic-beta: oauth-2025-04-20" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf8', timeout: 10000 },
    )
    const data = JSON.parse(res)

    return {
      fiveHour: data.five_hour ? {
        utilization: data.five_hour.utilization,
        resetsAt: data.five_hour.resets_at,
      } : undefined,
      sevenDay: data.seven_day ? {
        utilization: data.seven_day.utilization,
        resetsAt: data.seven_day.resets_at,
      } : undefined,
      lastUpdated: new Date().toISOString(),
    }
  } catch (err: any) {
    return { lastUpdated: new Date().toISOString(), error: err.message }
  }
}
```

**server.ts 改动**：在 `/api/tokens` 路由之后加一个 `/api/usage` 路由：

```typescript
import { getUsageStats } from './usage-stats.js'

// 在 /api/tokens 路由之后加
if (url.pathname === '/api/usage') {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(getUsageStats()))
  return
}
```

**验证**：
1. `npx tsc --noEmit`
2. `curl http://127.0.0.1:3721/api/usage | python3 -m json.tool` — 应返回 fiveHour/sevenDay

**Commit**: `feat: add /api/usage endpoint for subscription utilization`

---

### Task 4: 前端 — useUsage hook

**Files:**
- Create: `src/plugins/web-monitor/frontend-v2/hooks/useUsage.ts`

```typescript
import { useState, useEffect } from 'react'

export interface UsageStats {
  fiveHour?: { utilization: number; resetsAt: string }
  sevenDay?: { utilization: number; resetsAt: string }
  lastUpdated: string
  error?: string
}

export function useUsage(intervalMs = 60000) {
  const [usage, setUsage] = useState<UsageStats>({ lastUpdated: '' })

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const res = await fetch('/api/usage')
        if (res.ok) setUsage(await res.json())
      } catch {}
    }

    fetchUsage()
    const timer = setInterval(fetchUsage, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return usage
}
```

**验证**：`npx tsc --noEmit`（前端类型检查可能需要 Vite，确认无语法错误即可）

**Commit**: `feat: add useUsage hook for subscription utilization`

---

### Task 5: 前端 — 更新 TokenStats 类型 + useTokens

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/hooks/useTokens.ts`

**改动**：TokenStats 接口加新字段：

```typescript
export interface TokenStats {
  daily: DailyTokens[]
  lastUpdated: string
  todayCost?: number
  avgDailyCost?: number
  pricingDate?: string
}
```

**验证**：`npx tsc --noEmit`

**Commit**: `feat: extend TokenStats type with cost fields`

---

### Task 6: 前端 — TopBar 右侧新增成本 + 用量指标

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/components/TopBar.tsx`
- Modify: `src/plugins/web-monitor/frontend-v2/App.tsx`

**App.tsx 改动**：传 usage 数据给 TopBar：

```typescript
import { useUsage } from './hooks/useUsage'

// 在 App() 里加
const usageStats = useUsage()

// TopBar 加 usageStats prop
<TopBar tokenStats={tokenStats} usageStats={usageStats} hubConnected={hubConnected} />
```

**TopBar.tsx 改动**：

1. 新增 `UsageProp` 类型和 `UsageBar` 组件
2. TopBar 右侧添加成本 + 用量指标

```typescript
import type { UsageStats } from '../hooks/useUsage'

// 新增：用量进度条组件
function UsageBar({ label, utilization, resetsAt }: {
  label: string
  utilization: number
  resetsAt?: string
}) {
  const pct = Math.round(utilization)
  const resetStr = resetsAt
    ? new Date(resetsAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
  // 5 段进度条
  const filled = Math.round(pct / 20)
  const bar = '█'.repeat(filled) + '░'.repeat(5 - filled)
  const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow, #f0ad4e)' : 'var(--text-dim)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 9, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 500 }}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color, letterSpacing: '0.05em' }}>{bar}</span>
        <span style={{ fontSize: 12, fontWeight: 600, color }}>{pct}%</span>
        {resetStr && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>↻{resetStr}</span>}
      </div>
    </div>
  )
}

// 新增：成本格式化
function formatCost(cost: number | undefined): string {
  if (cost === undefined || cost === null) return '—'
  return '$' + cost.toFixed(2)
}
```

TopBar 函数签名加 `usageStats`:

```typescript
export function TopBar({ tokenStats, usageStats, hubConnected }: {
  tokenStats: TokenStats
  usageStats?: UsageStats
  hubConnected: boolean
})
```

在现有 `<div style={{ flex: 1 }} />` 之后（TPD 之前），插入新指标：

```tsx
{/* 等值成本 */}
<Metric label="≈ Cost Today" value={formatCost(tokenStats.todayCost)} />
<Metric label="≈ Avg/Day" value={formatCost(tokenStats.avgDailyCost)} />

<div style={{ width: 1, height: 28, background: 'var(--border)' }} />

{/* 用量限额 */}
{usageStats?.fiveHour && (
  <UsageBar label="5h" utilization={usageStats.fiveHour.utilization} resetsAt={usageStats.fiveHour.resetsAt} />
)}
{usageStats?.sevenDay && (
  <UsageBar label="7d" utilization={usageStats.sevenDay.utilization} resetsAt={usageStats.sevenDay.resetsAt} />
)}
```

**完整 TopBar 布局（改后）**：

```
[cc2im 0h5m] | Context In | Generated | Today | [flex spacer] | ≈$12.50 today | ≈$8.20/day | | 5h ██░░░ 10% ↻3/26 14:00 | 7d █░░░░ 14% ↻3/30
                                                                                               TPD(30d)
```

注意：TPD (Tokens/Day) 移到成本和用量之间或保留在最右。具体位置在实现时微调。

**验证**：
1. `npx tsc --noEmit`
2. 重启 hub
3. 浏览器打开 dashboard，检查 TopBar 右侧显示成本和用量

**Commit**: `feat: add cost + usage metrics to dashboard TopBar`

---

### Task 7: 集成验证

**不写代码，只做验证。**

```bash
# 1. 编译
npx tsc --noEmit

# 2. 重启 hub
npx tsx src/cli.ts uninstall && npx tsx src/cli.ts install

# 3. 等待启动
sleep 12

# 4. 验证后端 API
curl -s http://127.0.0.1:3721/api/tokens | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('todayCost:', d.get('todayCost'))
print('avgDailyCost:', d.get('avgDailyCost'))
print('pricingDate:', d.get('pricingDate'))
"

curl -s http://127.0.0.1:3721/api/usage | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('5h:', d.get('fiveHour'))
print('7d:', d.get('sevenDay'))
"

# 5. 浏览器验证 Dashboard TopBar
# 打开 http://127.0.0.1:3721，检查右侧显示：
# - ≈$XX.XX today
# - ≈$XX.XX/day
# - 5h ██░░░ XX% ↻时间
# - 7d █░░░░ XX% ↻时间

# 6. 微信消息正常
# 发一条消息确认收发不受影响
```

---

## 验收标准

| # | 标准 | 验证方式 |
|---|------|---------|
| 1 | `/api/tokens` 返回 `todayCost`、`avgDailyCost`、`pricingDate` | curl 检查 |
| 2 | `/api/usage` 返回 `fiveHour.utilization` 和 `sevenDay.utilization` | curl 检查 |
| 3 | `todayCost` 值合理（$10-$500 量级，取决于当日用量） | 人工核对 |
| 4 | Dashboard TopBar 右侧显示等值成本（当日 + 日均） | 浏览器验证 |
| 5 | Dashboard TopBar 右侧显示 5h/7d 用量条 + 百分比 + 恢复时间 | 浏览器验证 |
| 6 | 用量百分比与 CC CLI `/usage` 或 ghostty 状态栏一致 | 人工核对 |
| 7 | `pricing.json` 存在且包含 Opus 4.6 定价 | 文件检查 |
| 8 | `npx tsc --noEmit` 无报错 | 编译检查 |
| 9 | 微信消息收发不受影响 | 手动验证 |
| 10 | 底部状态栏显示定价基准日期 | 浏览器验证（可选，留给后续） |

---

## 注意事项

- **OAuth token 安全**：token 只在 hub 进程内读取，不写入日志或文件。`usage-stats.ts` 用 `execSync` 从 Keychain 读取，不持久化
- **API 频率**：usage API 每 60 秒调一次，避免被限流
- **macOS 特有**：Keychain 读取只在 macOS 上可用。非 macOS 环境 `/api/usage` 优雅降级返回 error
- **pricing.json 更新**：手动维护，版本化提交。定价变更频率极低
