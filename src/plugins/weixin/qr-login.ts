import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import QRCode from 'qrcode'

const ILINK_BASE = 'https://ilinkai.weixin.qq.com'
const CRED_DIR = join(homedir(), '.weixin-bot')
const CRED_PATH = join(CRED_DIR, 'credentials.json')
const POLL_INTERVAL = 2000

export interface QrCode {
  qrUrl: string      // WeChat scan URL (for reference)
  qrDataUrl: string  // data:image/png;base64,... (for <img src>)
  qrToken: string
}

export interface QrCredentials {
  token: string
  baseUrl: string
  accountId: string
  userId: string
}

export type QrStatus = 'pending' | 'scanned' | 'confirmed' | 'expired'

export async function fetchQrCode(): Promise<QrCode> {
  const resp = await fetch(`${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`)
  if (!resp.ok) throw new Error(`iLink QR API error: ${resp.status}`)
  const data: any = await resp.json()
  if (!data.qrcode_img_content || !data.qrcode) {
    throw new Error('iLink 返回的 QR 数据不完整')
  }
  const qrUrl = data.qrcode_img_content
  // Generate QR code as data URL (iLink returns a scan URL, not an image)
  const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 220, margin: 1 })
  return { qrUrl, qrDataUrl, qrToken: data.qrcode }
}

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

export function saveCredentials(creds: QrCredentials, channelId?: string): void {
  mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
  const json = JSON.stringify(creds, null, 2) + '\n'
  // Always write global file (backward compat for CLI `cc2im login`)
  writeFileSync(CRED_PATH, json, { mode: 0o600 })
  // Also write per-channel file when channelId is provided
  if (channelId) {
    const channelPath = join(CRED_DIR, `credentials-${channelId}.json`)
    writeFileSync(channelPath, json, { mode: 0o600 })
  }
}

export function loadCredentials(channelId?: string): QrCredentials | null {
  if (channelId) {
    // Try per-channel file first
    const channelPath = join(CRED_DIR, `credentials-${channelId}.json`)
    if (existsSync(channelPath)) {
      return JSON.parse(readFileSync(channelPath, 'utf8'))
    }
  }
  // Fall back to global file
  if (existsSync(CRED_PATH)) {
    return JSON.parse(readFileSync(CRED_PATH, 'utf8'))
  }
  return null
}

export { CRED_DIR, CRED_PATH, POLL_INTERVAL }
