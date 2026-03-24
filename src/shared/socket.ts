import { createServer, createConnection, Socket } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

export const SOCKET_DIR = join(homedir(), '.cc2im')
export const HUB_SOCKET_PATH = join(SOCKET_DIR, 'hub.sock')

export function ensureSocketDir() {
  mkdirSync(SOCKET_DIR, { recursive: true })
}

// ndjson 帧编码/解码
export function encodeFrame(data: unknown): Buffer {
  return Buffer.from(JSON.stringify(data) + '\n')
}

export function createFrameParser(onFrame: (data: unknown) => void) {
  let buffer = ''
  return (chunk: Buffer) => {
    buffer += chunk.toString()
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line) {
        try { onFrame(JSON.parse(line)) }
        catch (e) { console.error('[socket] Bad frame:', line) }
      }
    }
  }
}
