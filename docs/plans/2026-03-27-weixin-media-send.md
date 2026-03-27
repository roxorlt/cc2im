# WeChat 媒体发送 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 CC agent 能通过微信发送图片和文件给用户（目前只能发文本）。

**Architecture:** 在 spoke 新增 `weixin_send_file` MCP 工具，CC 调用时传文件路径。Spoke 通过 hub 转发给 weixin 插件，weixin 插件实现 AES 加密 → CDN 上传 → 构造 media message → sendMessage API。复用已有的 `@pinixai/weixin-bot` SDK 的 `sendMessage()` 和类型定义。

**Tech Stack:** Node.js, AES-128-ECB (node:crypto), WeChat iLink Bot API, MCP protocol

---

## 背景知识

### 协议流程（发送媒体到微信）

```
CC agent 生成文件 → weixin_send_file MCP 工具
  → spoke 发 send_file 消息到 hub
  → hub weixin 插件:
    1. 读取文件 → AES-128-ECB 加密
    2. POST /ilink/bot/getuploadurl → 获取 CDN 上传地址
    3. POST CDN upload URL → 上传加密文件 → 拿到 encrypt_query_param
    4. 构造 image_item/file_item → sendMessage API → 微信
```

### 关键 SDK 引用

- `sendMessage(baseUrl, token, msg)` — `node_modules/@pinixai/weixin-bot/src/api.ts:141`
- `buildHeaders(token)` — `api.ts:83`，返回 Auth + X-WECHAT-UIN headers
- `apiFetch(baseUrl, endpoint, body, token)` — `api.ts:92`，通用 API 调用
- `MessageItemType.IMAGE = 2, FILE = 4` — `types.ts:16-22`
- `CDNMedia`, `ImageItem`, `FileItem` — `types.ts:24-57`
- `SendMessageReq['msg']` — `types.ts:107-118`
- `buildTextMessage()` — `api.ts:208`，参考其结构构造媒体消息
- `WeixinBot.contextTokens` — `client.ts:26`，Map<userId, contextToken>

### 已有代码可复用

- `parseAesKey(aesKeyB64)` — `src/plugins/weixin/media.ts:35`（下载时解密用，上传时加密是反向操作）
- `WeixinConnection.recentMessages` — 存有 contextToken（发送需要）
- `WeixinConnection.bot` — WeixinBot 实例，可访问 `credentials`（需 private→protected 或加 getter）

---

## Task 1: media-upload.ts — CDN 上传模块

**Files:**
- Create: `src/plugins/weixin/media-upload.ts`

### Step 1: 实现 `uploadMedia()`

```typescript
// src/plugins/weixin/media-upload.ts
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes, randomUUID, createCipheriv } from 'node:crypto'
import { apiFetch, buildHeaders } from '@pinixai/weixin-bot/api'
import type { CDNMedia } from '@pinixai/weixin-bot/types'

const CDN_UPLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/upload'

/** 媒体类型映射（getuploadurl 的 media_type 参数） */
const UPLOAD_MEDIA_TYPE = { image: 1, video: 2, file: 3 } as const

interface UploadResult {
  cdnMedia: CDNMedia
  rawSize: number
  encryptedSize: number
}

/**
 * 加密文件并上传到微信 CDN，返回 CDNMedia 信息用于构造 sendMessage。
 */
export async function uploadMedia(
  filePath: string,
  mediaType: 'image' | 'video' | 'file',
  baseUrl: string,
  token: string,
): Promise<UploadResult> {
  const raw = readFileSync(filePath)
  const rawSize = raw.length

  // 1. 生成随机 AES key
  const aesKeyBuf = randomBytes(16)
  const aesKeyHex = aesKeyBuf.toString('hex')
  // SDK 约定 aes_key = base64(hex_string)
  const aesKeyB64 = Buffer.from(aesKeyHex, 'utf8').toString('base64')

  // 2. AES-128-ECB 加密（PKCS7 padding 由 Node crypto 自动处理）
  const cipher = createCipheriv('aes-128-ecb', aesKeyBuf, Buffer.alloc(0))
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()])

  // 3. 获取上传地址
  const filekey = randomBytes(16).toString('hex')
  const uploadInfo = await apiFetch<{ upload_param: string; upload_url?: string }>(
    baseUrl,
    '/ilink/bot/getuploadurl',
    {
      filekey,
      media_type: UPLOAD_MEDIA_TYPE[mediaType],
      rawsize: rawSize,
      filesize: encrypted.length,
      aeskey: aesKeyHex,
      no_need_thumb: true,
    },
    token,
    15_000,
  )

  const uploadUrl = uploadInfo.upload_url || CDN_UPLOAD_URL
  const uploadParam = uploadInfo.upload_param

  // 4. 上传到 CDN
  const headers = buildHeaders(token)
  headers['Content-Type'] = 'application/octet-stream'

  const cdnResp = await fetch(
    `${uploadUrl}?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${filekey}`,
    { method: 'POST', headers, body: encrypted },
  )

  if (!cdnResp.ok) {
    throw new Error(`CDN upload failed: HTTP ${cdnResp.status}`)
  }

  // CDN 返回的 encrypt_query_param 在响应头或 body
  const respBody = await cdnResp.text()
  let encryptQueryParam = cdnResp.headers.get('x-encrypted-param') || ''
  if (!encryptQueryParam && respBody) {
    try {
      const parsed = JSON.parse(respBody)
      encryptQueryParam = parsed.encrypt_query_param || parsed.encrypted_query_param || ''
    } catch {}
  }

  if (!encryptQueryParam) {
    throw new Error('CDN upload succeeded but no encrypt_query_param returned')
  }

  return {
    cdnMedia: {
      encrypt_query_param: encryptQueryParam,
      aes_key: aesKeyB64,
      encrypt_type: 1,
    },
    rawSize,
    encryptedSize: encrypted.length,
  }
}
```

### Step 2: TypeScript 检查

Run: `npx tsc --noEmit`
Expected: PASS（可能需要调整 import 路径，SDK 不一定导出 subpath）

> **注意**：如果 `@pinixai/weixin-bot/api` subpath import 不可用，改为从 SDK 源码直接 copy `apiFetch` 和 `buildHeaders`，或者在 `media-upload.ts` 中自己实现轻量版的 fetch 调用。重点是不要破坏 SDK 的 node_modules。

### Step 3: Commit

```bash
git add src/plugins/weixin/media-upload.ts
git commit -m "feat: media upload module — AES encrypt + CDN upload"
```

---

## Task 2: WeixinConnection 增加 sendImage / sendFile 方法

**Files:**
- Modify: `src/plugins/weixin/connection.ts`

### Step 1: 暴露 SDK credentials

WeixinConnection 需要访问 `bot` 的 `baseUrl` 和 `token`（目前是 private）。

在 `connection.ts` 里给 WeixinConnection 加 helper 方法获取 credentials：

```typescript
// 在 WeixinConnection class 内部，send() 方法之后新增：

/** 获取当前 bot 的 API credentials（baseUrl + token） */
private async getBotCredentials(): Promise<{ baseUrl: string; token: string }> {
  const creds = await (this.bot as any).ensureCredentials()
  return { baseUrl: (this.bot as any).baseUrl, token: creds.token }
}

/** 获取用户的 contextToken */
private getContextToken(userId: string): string | undefined {
  const cached = this.recentMessages.get(userId)
  return cached?._contextToken || (this.bot as any).contextTokens?.get(userId)
}
```

### Step 2: 实现 sendImage

```typescript
// 在 WeixinConnection class 内新增

async sendImage(userId: string, filePath: string): Promise<void> {
  const { baseUrl, token } = await this.getBotCredentials()
  const contextToken = this.getContextToken(userId)
  if (!contextToken) {
    throw new Error(`No context token for user ${userId}. User must send a message first.`)
  }

  const { cdnMedia, rawSize } = await uploadMedia(filePath, 'image', baseUrl, token)

  const { sendMessage } = await import('@pinixai/weixin-bot/api')
  // 或直接 import { sendMessage } from '@pinixai/weixin-bot/api' 在文件顶部

  const msg: SendMessageReq['msg'] = {
    from_user_id: '',
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{
      type: MessageItemType.IMAGE,
      image_item: {
        media: cdnMedia,
        mid_size: rawSize,
      },
    }],
  }

  await sendMessage(baseUrl, token, msg)
  console.log(`[weixin] Image sent to ${userId}: ${filePath}`)
}
```

### Step 3: 实现 sendFile

```typescript
async sendFile(userId: string, filePath: string): Promise<void> {
  const { baseUrl, token } = await this.getBotCredentials()
  const contextToken = this.getContextToken(userId)
  if (!contextToken) {
    throw new Error(`No context token for user ${userId}. User must send a message first.`)
  }

  const { cdnMedia, rawSize } = await uploadMedia(filePath, 'file', baseUrl, token)
  const fileName = basename(filePath)

  const msg: SendMessageReq['msg'] = {
    from_user_id: '',
    to_user_id: userId,
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{
      type: MessageItemType.FILE,
      file_item: {
        media: cdnMedia,
        file_name: fileName,
        len: String(rawSize),
      },
    }],
  }

  await sendMessage(baseUrl, token, msg)
  console.log(`[weixin] File sent to ${userId}: ${filePath} (${fileName})`)
}
```

### Step 4: 需要的 import

在 `connection.ts` 顶部补充：

```typescript
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { uploadMedia } from './media-upload.js'
// SDK types — 根据实际 import 路径调整
import { MessageType, MessageState, MessageItemType } from '@pinixai/weixin-bot/types'
import type { SendMessageReq } from '@pinixai/weixin-bot/types'
import { sendMessage } from '@pinixai/weixin-bot/api'
```

> **注意**：SDK 的 subpath export 可能不可用。如果 `@pinixai/weixin-bot/api` 报错，需要检查 SDK 的 `package.json` exports 字段。备选方案是直接 copy `sendMessage` 和 `buildTextMessage` 的实现逻辑。

### Step 5: TypeScript 检查 + Commit

Run: `npx tsc --noEmit`

```bash
git add src/plugins/weixin/connection.ts
git commit -m "feat: WeixinConnection.sendImage() + sendFile()"
```

---

## Task 3: Spoke 协议 + MCP 工具

**Files:**
- Modify: `src/shared/types.ts` — 新增 `SpokeToHubSendFile` 消息类型
- Modify: `src/spoke/channel-server.ts` — 新增 `weixin_send_file` MCP 工具
- Modify: `src/plugins/weixin/index.ts` — 处理 `send_file` 消息

### Step 1: 协议扩展

在 `src/shared/types.ts` 中新增：

```typescript
// Spoke → Hub: 发送文件/图片到微信
export interface SpokeToHubSendFile {
  type: 'send_file'
  agentId: string
  userId: string
  filePath: string
}
```

把 `SpokeToHubSendFile` 加入 `SpokeToHub` union type。

### Step 2: MCP 工具定义

在 `src/spoke/channel-server.ts` 的 tools 数组中新增：

```typescript
{
  name: 'weixin_send_file',
  description: '发送图片或文件到微信用户。支持 jpg/png/gif/pdf 等常见格式。图片会以图片消息显示，其他格式以文件消息显示。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      file_path: { type: 'string', description: '本地文件的绝对路径' },
      user_id: {
        type: 'string',
        description: '目标用户 ID — 从 channel notification 的 meta.userId 提取',
      },
    },
    required: ['file_path'],
  },
},
```

### Step 3: MCP 工具处理

在 `channel-server.ts` 的 `CallToolRequestSchema` handler 中新增 case：

```typescript
case 'weixin_send_file': {
  const { file_path, user_id } = args as { file_path: string; user_id?: string }
  const targetId = user_id || lastUserId

  if (!targetId) {
    return {
      content: [{ type: 'text' as const, text: '没有可回复的用户，等待微信消息...' }],
      isError: true,
    }
  }

  // 验证文件存在
  const { existsSync } = await import('node:fs')
  if (!existsSync(file_path)) {
    return {
      content: [{ type: 'text' as const, text: `文件不存在: ${file_path}` }],
      isError: true,
    }
  }

  const sent = socketClient.send({
    type: 'send_file',
    agentId,
    userId: targetId,
    filePath: file_path,
  })

  if (!sent) {
    return {
      content: [{ type: 'text' as const, text: 'Hub 未连接，文件未送达。' }],
      isError: true,
    }
  }

  return {
    content: [{ type: 'text' as const, text: `文件已发送到微信用户 ${targetId}: ${file_path}` }],
  }
}
```

### Step 4: weixin 插件处理 send_file

在 `src/plugins/weixin/index.ts` 的 `spoke:message` handler 中新增 case：

```typescript
case 'send_file': {
  const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'])
  const ext = msg.filePath.split('.').pop()?.toLowerCase() || ''
  const isImage = IMAGE_EXTS.has(ext)

  try {
    if (isImage) {
      await weixin.sendImage(msg.userId, msg.filePath)
    } else {
      await weixin.sendFile(msg.userId, msg.filePath)
    }
    console.log(`[hub] File sent from ${agentId} to ${msg.userId}: ${msg.filePath}`)
    ctx.broadcastMonitor({
      kind: 'message_out', agentId, userId: msg.userId,
      text: isImage ? '[图片]' : `[文件] ${msg.filePath.split('/').pop()}`,
      timestamp: new Date().toISOString(),
      msgType: isImage ? 'image' : 'file',
      mediaUrl: `/media/${msg.filePath.split('/').pop()}`,
    })
  } catch (err: any) {
    console.error(`[hub] Failed to send file from ${agentId}: ${err.message}`)
    // 可选：通过 spoke 告知 CC 发送失败
  }
  break
}
```

### Step 5: TypeScript 检查 + Commit

Run: `npx tsc --noEmit`

```bash
git add src/shared/types.ts src/spoke/channel-server.ts src/plugins/weixin/index.ts
git commit -m "feat: weixin_send_file MCP tool — spoke → hub → CDN → WeChat"
```

---

## Task 4: 端到端测试

### Step 1: 编译 + 重启

```bash
npx tsc --noEmit  # 类型检查
npx vite build    # 前端（dashboard 显示发送的媒体消息）
```

重启 hub + agents：
```bash
pkill -f "cc2im" 2>/dev/null
sleep 2 && rm -f ~/.cc2im/hub.sock
npx tsx src/cli.ts start &>~/.cc2im/hub.log &
```

### Step 2: 测试发送图片

在微信给 agent 发一条消息（激活 contextToken），然后让 CC 生成一张图并调用 `weixin_send_file`。

或者用已有的测试图片手动测试：
```bash
# 模拟 spoke 发送 — 可在 hub 日志中确认流程
curl -s http://127.0.0.1:3721/api/health  # 确认 hub 在线
```

通过微信对话触发：给 agent 发 "生成一张测试图片发给我"，CC 应该：
1. 用 Bash 或其他工具生成图片
2. 调用 `weixin_send_file({ file_path: "/path/to/image.png" })`
3. Hub 走上传流程
4. 微信收到图片

### Step 3: 测试发送文件

给 agent 发 "把 XXX 文件发给我"，CC 调用 `weixin_send_file({ file_path: "/path/to/file.pdf" })`。

### Step 4: 验证 Dashboard

在 dashboard 消息流中确认：
- 发送的图片显示为图片预览（复用已有的 MediaContent 组件）
- 发送的文件显示为文件卡片

### Step 5: Commit 最终验证通过

```bash
git add -A
git commit -m "test: verify media send end-to-end"
```

---

## 验收标准

| # | 验收项 | 验证方式 |
|---|--------|---------|
| 1 | CC 可通过 `weixin_send_file` MCP 工具发送图片到微信 | 微信收到图片消息（非文件） |
| 2 | CC 可通过 `weixin_send_file` MCP 工具发送 PDF/文件到微信 | 微信收到文件消息 |
| 3 | 自动区分图片/文件：jpg/png/gif/webp → 图片消息，其他 → 文件消息 | 发送 .png 显示为图片，发送 .pdf 显示为文件 |
| 4 | 文件不存在时 MCP 工具返回错误 | CC 收到 isError 响应 |
| 5 | 无 contextToken 时报错（用户未先发消息） | CC 收到错误提示 |
| 6 | AES 加密正确，微信能解密显示 | 图片在微信中正常显示，不是乱码 |
| 7 | Dashboard 消息流显示发出的媒体 | 图片 → 图片预览，文件 → 文件卡片 |
| 8 | TypeScript 编译无报错 | `npx tsc --noEmit` 通过 |

## 风险与注意事项

1. **SDK subpath import**：`@pinixai/weixin-bot` 可能不支持 `@pinixai/weixin-bot/api` 这种 subpath import。需要检查 `package.json` 的 `exports` 字段。如果不支持，从 SDK 源码 copy 需要的函数。
2. **CDN 响应格式不确定**：`getuploadurl` 和 CDN upload 的响应格式需要实际调用才能确认。Plan 中的字段名基于社区文档和协议逆向分析，可能需要微调。
3. **大文件**：当前方案一次性读入内存。对于正常图片/文件（<50MB）没问题，但要注意不要发超大文件。
4. **文件路径安全**：spoke 传来的 `filePath` 需确保在 agent 的工作目录内，防止读取敏感文件。当前信任 CC agent 的判断（CC 本身就有文件系统权限）。
