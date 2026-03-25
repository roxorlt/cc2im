/**
 * 微信连接 + 收发
 * 从 cc2wx 搬迁，适配 hub 架构
 */

import { WeixinBot } from '@pinixai/weixin-bot'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { downloadMedia, cleanupMedia } from './media.js'
import { splitIntoChunks, formatChunks } from './chunker.js'

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

export class WeixinConnection {
  private bot = new WeixinBot()
  private recentMessages = new Map<string, any>() // userId -> raw msg for reply
  private onIncoming: OnMessageCallback | null = null

  setMessageHandler(handler: OnMessageCallback) {
    this.onIncoming = handler
  }

  async login(): Promise<string> {
    const credPath = join(homedir(), '.weixin-bot', 'credentials.json')
    if (!existsSync(credPath)) {
      throw new Error('未找到微信登录凭证! 请先运行: cc2im login')
    }

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

      // Cache for reply
      this.recentMessages.set(msg.userId, msg)
      if (this.recentMessages.size > 50) {
        const oldest = this.recentMessages.keys().next().value
        if (oldest) this.recentMessages.delete(oldest)
      }

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

  async send(userId: string, text: string) {
    const chunks = formatChunks(splitIntoChunks(text))
    const cachedMsg = this.recentMessages.get(userId)

    for (let i = 0; i < chunks.length; i++) {
      if (cachedMsg) {
        await this.bot.reply(cachedMsg, chunks[i])
      } else {
        await this.bot.send(userId, chunks[i])
      }
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 500))
    }
  }
}
