/**
 * 微信连接 + 收发
 * 从 cc2wx 搬迁，适配 hub 架构
 */

import { WeixinBot } from '@pinixai/weixin-bot'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { downloadMedia, cleanupMedia } from './media.js'
import { loadCredentials, CRED_PATH } from './qr-login.js'
import { splitIntoChunks, formatChunks } from './chunker.js'
import { uploadMedia } from './media-upload.js'
import { SOCKET_DIR } from '../../shared/socket.js'

export type IncomingMessage = {
  userId: string
  type: string
  text?: string
  raw?: any
  timestamp?: Date
}

export type OnMessageCallback = (msg: IncomingMessage & {
  mediaPath?: string | null
  voiceText?: string | null
}) => void

const ALLOWED_USERS = process.env.CC2IM_ALLOWED_USERS
  ? process.env.CC2IM_ALLOWED_USERS.split(',').map(s => s.trim())
  : []

const CONTEXT_CACHE_PATH = join(SOCKET_DIR, 'weixin-context.json')

export class WeixinConnection {
  private bot = new WeixinBot()
  private recentMessages = new Map<string, any>() // userId -> raw msg for reply
  private onIncoming: OnMessageCallback | null = null

  setMessageHandler(handler: OnMessageCallback) {
    this.onIncoming = handler
  }

  /** Persist context tokens to disk so replies work after hub restart */
  saveContextCache() {
    const cache: Record<string, { userId: string; _contextToken: string }> = {}
    for (const [userId, msg] of this.recentMessages) {
      if (msg._contextToken) {
        cache[userId] = { userId, _contextToken: msg._contextToken }
      }
    }
    try {
      writeFileSync(CONTEXT_CACHE_PATH, JSON.stringify(cache) + '\n')
      console.log(`[weixin] Saved context cache (${Object.keys(cache).length} users)`)
    } catch {}
  }

  /** Restore context tokens from disk. Call after login, before startListening. */
  restoreContextCache() {
    try {
      if (!existsSync(CONTEXT_CACHE_PATH)) return
      const cache = JSON.parse(readFileSync(CONTEXT_CACHE_PATH, 'utf8'))
      let restored = 0
      for (const [userId, entry] of Object.entries(cache) as [string, any][]) {
        if (entry._contextToken) {
          // Restore minimal msg object with _contextToken for bot.reply()
          this.recentMessages.set(userId, { userId, _contextToken: entry._contextToken })
          // Also restore into SDK's internal contextTokens map
          ;(this.bot as any).contextTokens?.set(userId, entry._contextToken)
          restored++
        }
      }
      if (restored > 0) {
        console.log(`[weixin] Restored context cache (${restored} users)`)
      }
    } catch {}
  }

  async login(channelId?: string): Promise<string> {
    // Load per-channel credentials (falls back to global file)
    const channelCreds = loadCredentials(channelId)
    if (!channelCreds) {
      throw new Error('未找到微信登录凭证! 请先运行: cc2im login')
    }

    // Write per-channel creds to the global path so the SDK picks them up
    writeFileSync(CRED_PATH, JSON.stringify(channelCreds, null, 2) + '\n', { mode: 0o600 })

    console.log('[hub] 使用已保存的凭证登录微信...')
    const creds = await this.bot.login()
    console.log(`[hub] 微信连接成功! accountId=${creds.accountId}`)

    if (ALLOWED_USERS.length === 0) {
      console.log('[hub] ⚠ 白名单为空，将接受所有用户消息')
      console.log('[hub] 设置 CC2IM_ALLOWED_USERS 环境变量限制用户')
    }

    return creds.accountId
  }

  startListening() {
    // Clean up expired media on startup + every 6 hours
    cleanupMedia()
    setInterval(cleanupMedia, 6 * 60 * 60 * 1000)

    this.bot.onMessage(async (msg: any) => {
      // Allowlist check
      if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(msg.userId)) {
        console.log(`[hub] Blocked message from unlisted user: ${msg.userId}`)
        return
      }

      console.log(`[hub] 收到微信消息 from=${msg.userId} type=${msg.type}: ${msg.text?.slice(0, 100)}`)

      // Cache for reply + persist context token to disk
      this.recentMessages.set(msg.userId, msg)
      if (this.recentMessages.size > 50) {
        const oldest = this.recentMessages.keys().next().value
        if (oldest) this.recentMessages.delete(oldest)
      }
      this.saveContextCache()

      // Handle media
      let mediaPath: string | null = null
      let voiceText: string | null = null

      if (msg.type !== 'text' && msg.raw?.item_list?.[0]) {
        if (msg.type === 'voice') {
          voiceText = msg.text || msg.raw?.item_list?.[0]?.voice_item?.text || null
        } else {
          mediaPath = await downloadMedia(msg.raw.item_list[0])
        }
      }

      if (this.onIncoming) {
        Promise.resolve(this.onIncoming({ ...msg, mediaPath, voiceText })).catch((err) => {
          console.error(`[weixin-bot] Message handler error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    })
  }

  async startPolling() {
    console.log('[hub] 开始监听微信消息...')
    await this.bot.run()
  }

  async startTyping(userId: string) {
    try { await this.bot.sendTyping(userId) } catch {}
  }

  async stopTyping(userId: string) {
    try { await this.bot.stopTyping(userId) } catch {}
  }

  async send(userId: string, text: string) {
    const chunks = formatChunks(splitIntoChunks(text))
    const cachedMsg = this.recentMessages.get(userId)

    for (let i = 0; i < chunks.length; i++) {
      try {
        if (cachedMsg) {
          await this.bot.reply(cachedMsg, chunks[i])
        } else {
          await this.bot.send(userId, chunks[i])
        }
      } catch (err: any) {
        // WeChat SDK needs a cached context token to send.
        // After hub restart, cache is empty until user sends a new message.
        console.error(`[weixin] Failed to send to ${userId}: ${err.message}`)
        return
      }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500))
    }
  }

  /** Upload a local image and send it as an image message. */
  async sendImage(userId: string, filePath: string): Promise<void> {
    const { baseUrl, token, contextToken } = await this.getBotCredentials(userId)
    const { cdnMedia, rawSize } = await uploadMedia(filePath, 'image', baseUrl, token, userId)

    const msg = {
      from_user_id: '',
      to_user_id: userId,
      client_id: randomUUID(),
      message_type: 2,    // MessageType.BOT
      message_state: 2,   // MessageState.FINISH
      context_token: contextToken,
      item_list: [{
        type: 2,           // MessageItemType.IMAGE
        image_item: {
          media: cdnMedia,
          mid_size: rawSize,
        },
      }],
    }

    await this.callSendMessage(baseUrl, token, msg)
    console.log(`[weixin] Image sent to ${userId}: ${filePath}`)
  }

  /** Upload a local file and send it as a file message. */
  async sendFile(userId: string, filePath: string): Promise<void> {
    const { baseUrl, token, contextToken } = await this.getBotCredentials(userId)
    const { cdnMedia, rawSize } = await uploadMedia(filePath, 'file', baseUrl, token, userId)

    const msg = {
      from_user_id: '',
      to_user_id: userId,
      client_id: randomUUID(),
      message_type: 2,    // MessageType.BOT
      message_state: 2,   // MessageState.FINISH
      context_token: contextToken,
      item_list: [{
        type: 4,           // MessageItemType.FILE
        file_item: {
          media: cdnMedia,
          file_name: basename(filePath),
          len: String(rawSize),
        },
      }],
    }

    await this.callSendMessage(baseUrl, token, msg)
    console.log(`[weixin] File sent to ${userId}: ${basename(filePath)}`)
  }

  // ── private helpers for media send ────────────────────────────────

  /** Extract baseUrl, token, and contextToken from the SDK internals. */
  private async getBotCredentials(userId: string): Promise<{
    baseUrl: string
    token: string
    contextToken: string
  }> {
    const bot = this.bot as any
    const baseUrl: string = bot.baseUrl
    const creds = await bot.ensureCredentials()
    const token: string = creds.token

    // contextToken: prefer SDK's internal map, fall back to our cache
    const contextToken: string | undefined =
      bot.contextTokens?.get(userId) ??
      this.recentMessages.get(userId)?._contextToken

    if (!contextToken) {
      throw new Error(
        `No context token for user ${userId}. The user must send a message first.`,
      )
    }

    return { baseUrl, token, contextToken }
  }

  /**
   * POST /ilink/bot/sendmessage — mirrors the SDK's sendMessage()
   * which is not re-exported from the package's main entry.
   */
  private async callSendMessage(
    baseUrl: string,
    token: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const url = new URL('/ilink/bot/sendmessage', `${baseUrl.replace(/\/+$/, '')}/`)
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        msg,
        base_info: { channel_version: '1.0.0' },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`sendMessage failed: HTTP ${resp.status} — ${text}`)
    }

    const body = (await resp.json()) as { ret?: number; errmsg?: string }
    if (body.ret && body.ret !== 0) {
      throw new Error(`sendMessage returned ret=${body.ret}: ${body.errmsg ?? ''}`)
    }
  }
}
