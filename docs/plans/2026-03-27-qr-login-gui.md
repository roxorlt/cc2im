# QR 码 GUI 登录 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将微信扫码登录从终端搬到 Dashboard GUI，新增频道后弹窗展示二维码，session 过期时也可重新扫码。

**Architecture:** 后端新增 `POST /api/channels/:id/login` 端点，调用 iLink API 获取 QR 码，后台轮询扫码状态，通过 WebSocket 广播 `qr_status` 事件。前端 AddChannelDialog 创建后下展显示 QR，ChannelCard 过期时弹出同样的 QR 弹窗。QR 逻辑从 cli.ts 抽取为可复用模块。

**Tech Stack:** TypeScript, React, node:http, WebSocket, iLink API

---

## Task 1: 抽取 QR 登录模块

**Files:**
- Create: `src/plugins/weixin/qr-login.ts`

**Step 1: 创建 qr-login.ts**

从 `src/cli.ts:75-137` 抽取 iLink QR API 调用为无副作用的异步函数：

```typescript
// src/plugins/weixin/qr-login.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const CRED_DIR = join(homedir(), '.weixin-bot')
const CRED_PATH = join(CRED_DIR, 'credentials.json')
const POLL_INTERVAL = 2000

export interface QrCode {
  qrUrl: string   // QR 码图片 URL（可直接 <img src> 显示）
  qrToken: string // 轮询用 token
}

export interface QrCredentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
}

export type QrStatus = 'pending' | 'scanned' | 'confirmed' | 'expired'

/** 从 iLink 获取新的 QR 码 */
export async function fetchQrCode(): Promise<QrCode> {
  const resp = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`)
  if (!resp.ok) throw new Error(`iLink QR API error: ${resp.status}`)
  const data: any = await resp.json()
  if (!data.qrcode_img_content || !data.qrcode) {
    throw new Error('iLink 返回的 QR 数据不完整')
  }
  return { qrUrl: data.qrcode_img_content, qrToken: data.qrcode }
}

/** 查询一次 QR 扫码状态 */
export async function checkQrStatus(qrToken: string): Promise<{ status: QrStatus; credentials?: QrCredentials }> {
  const resp = await fetch(
    `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrToken)}`,
    { headers: { 'iLink-App-ClientVersion': '1' } },
  )
  if (!resp.ok) throw new Error(`iLink status API error: ${resp.status}`)
  const data: any = await resp.json()

  if (data.status === 'scaned') return { status: 'scanned' }
  if (data.status === 'expired') return { status: 'expired' }
  if (data.status === 'confirmed') {
    if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
      throw new Error('授权成功但未返回凭证')
    }
    return {
      status: 'confirmed',
      credentials: {
        token: data.bot_token,
        baseUrl: data.baseurl || ILINK_BASE,
        accountId: data.ilink_bot_id,
        userId: data.ilink_user_id,
      },
    }
  }
  return { status: 'pending' }
}

/** 保存凭证到 ~/.weixin-bot/credentials.json */
export function saveCredentials(creds: QrCredentials): void {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 })
}

export { POLL_INTERVAL }
```

**Step 2: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/plugins/weixin/qr-login.ts
git commit -m "feat: extract QR login module from CLI"
```

---

## Task 2: HubContext 增加 reconnectChannel 方法

**Files:**
- Modify: `src/shared/plugin.ts:24-26`
- Modify: `src/hub/hub-context.ts:62-69`
- Modify: `src/plugins/channel-manager/index.ts` (新增 channel:reconnect 监听)

**Step 1: 扩展 HubContext 接口**

在 `src/shared/plugin.ts:26` 后追加：

```typescript
  /** Reconnect a channel (disconnect + connect with fresh credentials) */
  reconnectChannel(channelId: string): Promise<void>
```

**Step 2: 实现 reconnectChannel**

在 `src/hub/hub-context.ts:66-69` 后追加：

```typescript
  async reconnectChannel(channelId: string): Promise<void> {
    this.emit('channel:reconnect', channelId)
  }
```

**Step 3: channel-manager 监听 channel:reconnect**

在 `src/plugins/channel-manager/index.ts` 的 `ctx.on('channel:remove', ...)` 后追加：

```typescript
    ctx.on('channel:reconnect', async (channelId: string) => {
      const ch = channelMap.get(channelId)
      if (!ch) {
        console.warn(`[channel-manager] reconnect: channel "${channelId}" not found`)
        return
      }
      console.log(`[channel-manager] Reconnecting "${channelId}"...`)
      try {
        await ch.disconnect()
      } catch (err: any) {
        console.warn(`[channel-manager] disconnect before reconnect failed: ${err.message}`)
      }
      try {
        await ch.connect()
        console.log(`[channel-manager] "${channelId}" reconnected`)
      } catch (err: any) {
        console.error(`[channel-manager] "${channelId}" reconnect failed: ${err.message}`)
      }
    })
```

**Step 4: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/shared/plugin.ts src/hub/hub-context.ts src/plugins/channel-manager/index.ts
git commit -m "feat: add reconnectChannel to HubContext"
```

---

## Task 3: POST /api/channels/:id/login 端点

**Files:**
- Modify: `src/plugins/web-monitor/server.ts:278` (在 probe 端点之后、DELETE 之前插入)

**Step 1: 在 server.ts 顶部追加 import**

在 `src/plugins/web-monitor/server.ts:20` 后追加：

```typescript
import { fetchQrCode, checkQrStatus, saveCredentials, POLL_INTERVAL, type QrStatus } from '../weixin/qr-login.js'
```

**Step 2: 在 server.ts 的路由区域（约 L278，probe 端点之后）插入 login 端点**

```typescript
    // --- QR Login ---
    // Track active QR polling sessions (one per channelId, prevent duplicate)
    // (Declare activeQrPolls at module level inside startWeb, alongside other state like messageHistory)

    if (url.pathname.match(/^\/api\/channels\/[^/]+\/login$/) && req.method === 'POST') {
      const channelId = decodeURIComponent(url.pathname.split('/')[3])
      if (!ctx) { res.writeHead(503, HD); res.end('{"error":"no hub context"}'); return }
      if (!ctx.getChannel(channelId)) { res.writeHead(404, HD); res.end('{"error":"channel not found"}'); return }

      ;(async () => {
        try {
          // Cancel any existing poll for this channel
          if (activeQrPolls.has(channelId)) {
            clearInterval(activeQrPolls.get(channelId)!)
            activeQrPolls.delete(channelId)
          }

          const qr = await fetchQrCode()

          // Respond with QR URL immediately
          res.writeHead(200, HD)
          res.end(JSON.stringify({ qrUrl: qr.qrUrl }))

          // Broadcast initial QR status to browser
          broadcastWs({ type: 'qr_status', channelId, status: 'pending' as QrStatus, qrUrl: qr.qrUrl })

          // Start background polling
          const poll = setInterval(async () => {
            try {
              const result = await checkQrStatus(qr.qrToken)
              broadcastWs({ type: 'qr_status', channelId, status: result.status, qrUrl: qr.qrUrl })

              if (result.status === 'confirmed' && result.credentials) {
                clearInterval(poll)
                activeQrPolls.delete(channelId)
                saveCredentials(result.credentials)
                // Reconnect channel with new credentials
                try {
                  await ctx!.reconnectChannel(channelId)
                } catch (err: any) {
                  console.error(`[web] QR login reconnect failed: ${err.message}`)
                }
              } else if (result.status === 'expired') {
                clearInterval(poll)
                activeQrPolls.delete(channelId)
              }
            } catch (err: any) {
              console.error(`[web] QR poll error: ${err.message}`)
              // Don't stop polling on transient errors
            }
          }, POLL_INTERVAL)
          activeQrPolls.set(channelId, poll)
        } catch (err: any) {
          res.writeHead(500, HD)
          res.end(JSON.stringify({ error: err.message }))
        }
      })()
      return
    }
```

**Step 3: 在 startWeb() 函数内声明 activeQrPolls**

在现有状态变量（如 `messageHistory`）附近添加：

```typescript
const activeQrPolls = new Map<string, ReturnType<typeof setInterval>>()
```

**Step 4: 添加 HD 常量（JSON header 简写）**

在 server.ts 的状态变量区域添加：

```typescript
const HD = { 'Content-Type': 'application/json' }
```

**Step 5: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 6: Commit**

```bash
git add src/plugins/web-monitor/server.ts
git commit -m "feat: POST /api/channels/:id/login — QR code endpoint"
```

---

## Task 4: 前端 — useWebSocket 处理 qr_status 事件

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts`

**Step 1: 新增 QrLoginState 类型和 state**

在 `useWebSocket.ts` 的类型区域新增：

```typescript
export interface QrLoginState {
  channelId: string
  qrUrl: string
  status: 'pending' | 'scanned' | 'confirmed' | 'expired'
}
```

在 `useWebSocket()` 函数内新增 state：

```typescript
const [qrLogin, setQrLogin] = useState<QrLoginState | null>(null)
```

**Step 2: 在 ws.onmessage 中处理 qr_status 消息**

在 `if (msg.type === 'hub_event')` 块之前添加：

```typescript
      if (msg.type === 'qr_status') {
        setQrLogin({
          channelId: msg.channelId,
          qrUrl: msg.qrUrl,
          status: msg.status,
        })
        return
      }
```

**Step 3: return 中暴露 qrLogin 和 setQrLogin**

```typescript
return { agents, hubConnected, wsConnected, messages, logs, channels, setChannels, nicknames, setNicknames, qrLogin, setQrLogin }
```

**Step 4: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 5: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/hooks/useWebSocket.ts
git commit -m "feat: useWebSocket handles qr_status events"
```

---

## Task 5: 前端 — QrLoginOverlay 组件

**Files:**
- Create: `src/plugins/web-monitor/frontend-v2/components/QrLoginOverlay.tsx`

**Step 1: 创建组件**

```tsx
// src/plugins/web-monitor/frontend-v2/components/QrLoginOverlay.tsx
import React, { useEffect } from 'react'

interface QrLoginOverlayProps {
  qrUrl: string
  status: 'pending' | 'scanned' | 'confirmed' | 'expired'
  onClose: () => void
  onRetry: () => void
}

const statusConfig: Record<string, { text: string; color: string }> = {
  pending:   { text: '请用微信扫描二维码', color: 'var(--text-dim)' },
  scanned:   { text: '已扫码，请在微信中确认授权...', color: 'var(--amber)' },
  confirmed: { text: '授权成功，正在连接...', color: 'var(--green)' },
  expired:   { text: '二维码已过期', color: 'var(--red)' },
}

export function QrLoginOverlay({ qrUrl, status, onClose, onRetry }: QrLoginOverlayProps) {
  // Auto-close on confirmed after delay
  useEffect(() => {
    if (status === 'confirmed') {
      const t = setTimeout(onClose, 2000)
      return () => clearTimeout(t)
    }
  }, [status, onClose])

  const cfg = statusConfig[status] || statusConfig.pending

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          padding: '28px 32px', borderRadius: 10,
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          width: 340, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600 }}>微信扫码登录</div>

        {/* QR 码图片 */}
        <div style={{
          width: 220, height: 220, borderRadius: 8,
          background: '#fff', padding: 8,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: status === 'expired' ? 0.3 : 1,
          transition: 'opacity 0.3s',
        }}>
          <img
            src={qrUrl}
            alt="WeChat QR Code"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        </div>

        {/* 状态文字 */}
        <div style={{
          fontSize: 12, color: cfg.color, fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {status === 'scanned' && (
            <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: cfg.color, animation: 'pulse-green 1.5s infinite' }} />
          )}
          {status === 'confirmed' && <span>✓</span>}
          {cfg.text}
        </div>

        {/* 操作按钮 */}
        <div style={{ display: 'flex', gap: 8 }}>
          {status === 'expired' && (
            <button onClick={onRetry} style={{
              padding: '6px 16px', borderRadius: 4,
              border: '1px solid var(--accent)', background: 'none',
              color: 'var(--accent)', fontSize: 11, cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}>
              重新获取
            </button>
          )}
          <button onClick={onClose} style={{
            padding: '6px 16px', borderRadius: 4,
            border: '1px solid var(--border)', background: 'none',
            color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
          }}>
            {status === 'confirmed' ? '完成' : '取消'}
          </button>
        </div>
      </div>
    </div>
  )
}
```

**Step 2: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/components/QrLoginOverlay.tsx
git commit -m "feat: QrLoginOverlay component"
```

---

## Task 6: 前端 — 接入 AddChannelDialog + ChannelCard

**Files:**
- Modify: `src/plugins/web-monitor/frontend-v2/components/ChannelsPage.tsx`
- Modify: `src/plugins/web-monitor/frontend-v2/App.tsx`

**Step 1: ChannelsPage 接收新 props**

ChannelsPageProps 新增：

```typescript
interface ChannelsPageProps {
  channels: ChannelInfo[]
  showAddDialog: boolean
  onCloseAddDialog: () => void
  onRefreshChannels: () => void
  // 新增
  qrLogin: QrLoginState | null
  onTriggerLogin: (channelId: string) => void
  onCloseQr: () => void
}
```

Import QrLoginOverlay 和类型：

```typescript
import { QrLoginOverlay } from './QrLoginOverlay'
import type { QrLoginState } from '../hooks/useWebSocket'
```

**Step 2: AddChannelDialog — 创建后自动触发 login**

修改 `AddChannelDialog`，新增 `onTriggerLogin` prop。在 `handleCreate` 的成功路径中，创建成功后自动触发登录：

```typescript
function AddChannelDialog({ onClose, onTriggerLogin }: { onClose: () => void; onTriggerLogin: (channelId: string) => void }) {
  // ... 现有 state ...

  const handleCreate = async () => {
    if (!accountName.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, accountName: accountName.trim() }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed')
        return
      }
      const data = await res.json()
      onClose()
      // 创建成功后自动触发 QR 登录
      onTriggerLogin(data.id)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setCreating(false)
    }
  }

  // 渲染：去掉 created 阶段（不再显示"请去终端扫码"），只保留表单
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        padding: '24px 28px', borderRadius: 10,
        background: 'var(--bg-panel)', border: '1px solid var(--border)',
        width: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 16 }}>新增频道</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 类型选择 + 账号名输入 — 保持现有 UI 不变 */}
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>频道类型</label>
            <select value={type} onChange={e => setType(e.target.value)}
              style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
              <option value="weixin">微信</option>
              <option value="telegram" disabled>Telegram (TBC)</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>授权账号名</label>
            <input value={accountName} onChange={e => setAccountName(e.target.value)}
              autoFocus placeholder="如 roxor、家人"
              style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-deep)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box', fontFamily: 'var(--font-mono)' }}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
            />
          </div>
          {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} style={btnStyle}>取消</button>
            <button onClick={handleCreate} disabled={creating || !accountName.trim()}
              style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
              {creating ? '创建中...' : '创建'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

**Step 3: ChannelCard — 过期/断开时增加「重新登录」按钮**

在 ChannelCard 的 actions 区域（约 L107-121），为 expired 状态增加登录按钮：

```typescript
{channel.status === 'expired' && (
  <button onClick={() => onTriggerLogin(channel.id)} style={{ ...btnStyle, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
    重新登录
  </button>
)}
```

ChannelCard props 新增 `onTriggerLogin`：

```typescript
function ChannelCard({ channel, isLast, onRefreshChannels, onTriggerLogin }: {
  channel: ChannelInfo; isLast: boolean; onRefreshChannels: () => void; onTriggerLogin: (id: string) => void
})
```

**Step 4: ChannelsPage 渲染 QrLoginOverlay**

在 ChannelsPage 组件末尾，有条件渲染 QR 弹窗：

```tsx
export function ChannelsPage({ channels, showAddDialog, onCloseAddDialog, onRefreshChannels, qrLogin, onTriggerLogin, onCloseQr }: ChannelsPageProps) {
  return (
    <div style={{ flex: 1, padding: '20px 24px', overflowY: 'auto' }}>
      {/* ... 现有 header 和 cards ... */}

      {showAddDialog && (
        <AddChannelDialog onClose={onCloseAddDialog} onTriggerLogin={onTriggerLogin} />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {channels.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 12 }}>
            暂无频道，点击侧栏「+ 新增频道」添加
          </div>
        ) : (
          channels.map(ch => <ChannelCard key={ch.id} channel={ch} isLast={channels.length <= 1} onRefreshChannels={onRefreshChannels} onTriggerLogin={onTriggerLogin} />)
        )}
      </div>

      {/* QR 登录弹窗 */}
      {qrLogin && (
        <QrLoginOverlay
          qrUrl={qrLogin.qrUrl}
          status={qrLogin.status}
          onClose={onCloseQr}
          onRetry={() => onTriggerLogin(qrLogin.channelId)}
        />
      )}
    </div>
  )
}
```

**Step 5: App.tsx — 接入 login 触发逻辑**

在 App.tsx 中新增 login 处理函数，透传 props：

```tsx
// App.tsx 中的 useWebSocket 解构新增 qrLogin, setQrLogin
const { agents, hubConnected, wsConnected, messages, logs, channels, setChannels, nicknames, setNicknames, qrLogin, setQrLogin } = useWebSocket()

const handleTriggerLogin = async (channelId: string) => {
  try {
    const res = await fetch(`/api/channels/${encodeURIComponent(channelId)}/login`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      console.error('Login failed:', data.error)
    }
    // QR status will arrive via WebSocket — no need to handle response qrUrl here
  } catch (err) {
    console.error('Login request failed:', err)
  }
}

const handleCloseQr = () => {
  setQrLogin(null)
}
```

ChannelsPage 组件传入新 props：

```tsx
<ChannelsPage
  channels={channels}
  showAddDialog={showAddChannel}
  onCloseAddDialog={() => setShowAddChannel(false)}
  onRefreshChannels={refreshChannels}
  qrLogin={qrLogin}
  onTriggerLogin={handleTriggerLogin}
  onCloseQr={handleCloseQr}
/>
```

**Step 6: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 7: Commit**

```bash
git add src/plugins/web-monitor/frontend-v2/components/ChannelsPage.tsx src/plugins/web-monitor/frontend-v2/App.tsx
git commit -m "feat: QR login in AddChannelDialog + ChannelCard reconnect"
```

---

## Task 7: 修改 POST /api/channels — 创建时不自动 connect

**Files:**
- Modify: `src/plugins/channel-manager/index.ts` (channel:add handler)

**说明:** 当前 `channel:add` handler 创建频道后立刻调用 `ch.connect()`，如果没有 credentials 会报错。改为创建频道但不自动连接，让 QR 登录完成后通过 `reconnectChannel` 触发连接。

**Step 1: 修改 channel:add handler**

在 channel-manager 的 `channel:add` 事件处理中，将 connect 调用改为仅在有凭证时连接：

```typescript
ctx.on('channel:add', async (type: string, channelId: string, accountName: string) => {
  if (type === 'weixin') {
    const { WeixinChannel } = await import('../weixin/weixin-channel.js')
    const ch = new WeixinChannel(channelId, accountName)
    channelMap.set(channelId, ch)
    ctx.registerChannel(ch)
    wireChannel(ch, ctx)

    // Persist config
    const configs = loadChannelConfigs()
    configs.push({ id: channelId, type: 'weixin', accountName })
    saveChannelConfigs(configs)

    // Don't auto-connect — wait for QR login to provide credentials
    // ch.connect() will be triggered by reconnectChannel after QR confirmed
    console.log(`[channel-manager] Channel "${channelId}" created (awaiting login)`)
  }
})
```

**Step 2: TypeScript 检查**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/plugins/channel-manager/index.ts
git commit -m "fix: channel:add no longer auto-connects — waits for QR login"
```

---

## Task 8: 构建 + 集成验证

**Step 1: TypeScript 全量检查**

Run: `npx tsc --noEmit`

**Step 2: Vite 构建**

Run: `npx vite build`

**Step 3: 验证清单**

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 1 | QR 模块编译 | tsc 无报错 |
| 2 | login 端点 | `curl -X POST http://127.0.0.1:3721/api/channels/weixin/login` 返回 `{ qrUrl }` |
| 3 | QR 状态广播 | 浏览器 WebSocket 收到 `qr_status` 事件 |
| 4 | 新增频道流程 | 创建 → QR 弹窗 → 扫码 → confirmed → channel connected |
| 5 | 过期重登 | expired channel → 点击「重新登录」→ QR 弹窗 → 扫码 → connected |
| 6 | QR 过期 | 不扫码等 5 分钟 → QR expired → 显示「重新获取」按钮 |
| 7 | 重复登录防护 | 连续点击两次 login → 第二次取消第一次轮询 |
| 8 | 弹窗关闭 | 点击外部或「取消」→ 弹窗关闭 |
| 9 | 现有功能不回退 | 消息收发、日志、channel filter 正常 |
| 10 | Vite 构建 | `npx vite build` 无报错 |

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: QR login GUI integration verification"
```
