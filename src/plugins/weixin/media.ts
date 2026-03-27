/**
 * 媒体下载 + AES 解密
 * 从 cc2wx.ts:31-106 搬迁，逻辑不变
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createDecipheriv } from 'node:crypto'
import { SOCKET_DIR } from '../../shared/socket.js'

const MEDIA_DIR = join(SOCKET_DIR, 'media')
const CDN_DOWNLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download'
const MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24 hours

export function cleanupMedia() {
  try {
    if (!existsSync(MEDIA_DIR)) return
    const now = Date.now()
    let cleaned = 0
    for (const file of readdirSync(MEDIA_DIR)) {
      const filepath = join(MEDIA_DIR, file)
      const age = now - statSync(filepath).mtimeMs
      if (age > MEDIA_MAX_AGE_MS) {
        unlinkSync(filepath)
        cleaned++
      }
    }
    if (cleaned > 0) console.log(`[hub] Cleaned ${cleaned} expired media files`)
  } catch (err) {
    console.error(`[hub] Media cleanup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function parseAesKey(aesKeyB64: string): Buffer {
  const hexStr = Buffer.from(aesKeyB64, 'base64').toString('utf8')
  return Buffer.from(hexStr, 'hex')
}

function detectExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif'
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'webp'
  // MP4/MOV: ftyp box at offset 4
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'mp4'
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'pdf'
  return 'bin'
}

export async function downloadMedia(item: any): Promise<string | null> {
  const mediaItem = item?.image_item || item?.video_item || item?.file_item || item?.voice_item
  if (!mediaItem?.media?.encrypt_query_param) return null

  const { encrypt_query_param, aes_key } = mediaItem.media

  try {
    const cdnUrl = `${CDN_DOWNLOAD_URL}?encrypted_query_param=${encodeURIComponent(encrypt_query_param)}`
    const resp = await fetch(cdnUrl, { method: 'GET' })

    if (!resp.ok) {
      console.log(`[hub] CDN download failed: HTTP ${resp.status}`)
      return null
    }

    let buffer = Buffer.from(await resp.arrayBuffer())

    if (aes_key) {
      const key = parseAesKey(aes_key)
      const decipher = createDecipheriv('aes-128-ecb', key, Buffer.alloc(0))
      buffer = Buffer.concat([decipher.update(buffer), decipher.final()])
    }

    mkdirSync(MEDIA_DIR, { recursive: true })
    const ext = detectExt(buffer)
    const filename = `${Date.now()}.${ext}`
    const filepath = join(MEDIA_DIR, filename)
    writeFileSync(filepath, buffer)
    console.log(`[hub] Media saved: ${filepath} (${buffer.length} bytes, ${ext})`)
    return filepath
  } catch (err) {
    console.error(`[hub] Media download failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
