/**
 * Media upload — AES-128-ECB encrypt + CDN upload
 *
 * Reverse of media.ts (download + decrypt).
 * Encrypts a local file and uploads it to the WeChat CDN,
 * returning CDNMedia metadata for use in sendMessage.
 */

import { readFileSync } from 'node:fs'
import { randomBytes, createCipheriv, createHash } from 'node:crypto'
import type { CDNMedia } from '@pinixai/weixin-bot'

// ── helpers (not re-exported by the SDK's main entry) ────────────

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(value), 'utf8').toString('base64')
}

function buildHeaders(token: string): Record<string, string> {
  return {
    AuthorizationType: 'ilink_bot_token',
    Authorization: `Bearer ${token}`,
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

// ── types ────────────────────────────────────────────────────────

interface GetUploadUrlReq {
  filekey: string
  media_type: number // 1=image 2=video 3=file
  rawsize: number
  filesize: number
  aeskey: string
  no_need_thumb: boolean
}

interface GetUploadUrlResp {
  ret?: number
  upload_param: string
  upload_url: string
}

export interface UploadResult {
  cdnMedia: CDNMedia
  rawSize: number
}

// ── media-type mapping ───────────────────────────────────────────

const MEDIA_TYPE_MAP: Record<string, number> = {
  image: 1,
  video: 2,
  file: 3,
}

// ── core ─────────────────────────────────────────────────────────

/**
 * Generate a random 16-byte hex string for use as AES key.
 * The WeChat protocol stores this as a hex string (not raw bytes).
 */
function generateAesKeyHex(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Encrypt plaintext buffer with AES-128-ECB + PKCS7 padding.
 * Key is a 16-byte hex string → parse to 16-byte Buffer.
 */
function encryptAes128Ecb(plain: Buffer, aesKeyHex: string): Buffer {
  const key = Buffer.from(aesKeyHex, 'hex')
  const cipher = createCipheriv('aes-128-ecb', key, Buffer.alloc(0))
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

/**
 * Encode the hex AES key as base64 (matches download-side parseAesKey expectation).
 *
 * Download does:  base64 → utf8 hex string → Buffer.from(hex)
 * So upload must: hex string → utf8 bytes → base64
 */
function aesKeyToBase64(aesKeyHex: string): string {
  return Buffer.from(aesKeyHex, 'utf8').toString('base64')
}

/**
 * Upload a local file to the WeChat CDN.
 *
 * 1. Read file & generate AES key
 * 2. Encrypt with AES-128-ECB
 * 3. POST /ilink/bot/getuploadurl to obtain CDN endpoint
 * 4. PUT encrypted payload to CDN
 * 5. Return CDNMedia for embedding in sendMessage
 */
export async function uploadMedia(
  filePath: string,
  mediaType: 'image' | 'video' | 'file',
  baseUrl: string,
  token: string,
  toUserId: string,
): Promise<UploadResult> {
  // 1. Read & encrypt
  const plain = readFileSync(filePath)
  const aesKeyHex = generateAesKeyHex()
  const encrypted = encryptAes128Ecb(plain, aesKeyHex)
  const filekey = randomBytes(16).toString('hex')
  const rawfilemd5 = createHash('md5').update(plain).digest('hex')

  // 2. Get upload URL
  const body = {
    filekey,
    media_type: MEDIA_TYPE_MAP[mediaType],
    to_user_id: toUserId,
    rawsize: plain.length,
    rawfilemd5,
    filesize: encrypted.length,
    aeskey: aesKeyHex,
    no_need_thumb: true,
    base_info: { channel_version: '1.0.0' },
  }

  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const uploadUrlResp = await fetch(
    new URL('/ilink/bot/getuploadurl', `${normalizedBase}/`),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildHeaders(token),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
  )

  if (!uploadUrlResp.ok) {
    const text = await uploadUrlResp.text()
    throw new Error(`getuploadurl failed: HTTP ${uploadUrlResp.status} — ${text}`)
  }

  const uploadInfo = (await uploadUrlResp.json()) as GetUploadUrlResp
  if (uploadInfo.ret && uploadInfo.ret !== 0) {
    throw new Error(`getuploadurl returned ret=${uploadInfo.ret}`)
  }

  // 3. Upload encrypted payload to CDN
  const cdnBase = uploadInfo.upload_url || 'https://novac2c.cdn.weixin.qq.com/c2c/upload'
  const cdnUrl =
    `${cdnBase}?encrypted_query_param=${encodeURIComponent(uploadInfo.upload_param)}&filekey=${filekey}`

  const cdnResp = await fetch(cdnUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      ...buildHeaders(token),
    },
    body: new Uint8Array(encrypted),
    signal: AbortSignal.timeout(60_000),
  })

  if (!cdnResp.ok) {
    const text = await cdnResp.text()
    throw new Error(`CDN upload failed: HTTP ${cdnResp.status} — ${text}`)
  }

  // 4. Extract encrypt_query_param from response
  //    Prefer header, fall back to JSON body
  let encryptQueryParam = cdnResp.headers.get('x-encrypted-param') ?? ''
  if (!encryptQueryParam) {
    const cdnBody = (await cdnResp.json()) as { encrypt_query_param?: string }
    encryptQueryParam = cdnBody.encrypt_query_param ?? ''
  }

  if (!encryptQueryParam) {
    throw new Error('CDN upload succeeded but no encrypt_query_param returned')
  }

  return {
    cdnMedia: {
      encrypt_query_param: encryptQueryParam,
      aes_key: aesKeyToBase64(aesKeyHex),
      encrypt_type: 1,
    },
    rawSize: plain.length,
  }
}
