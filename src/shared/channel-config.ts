import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SOCKET_DIR } from './socket.js'
import type { ChannelType } from './channel.js'

export interface ChannelConfig {
  id: string           // "weixin-alice"
  type: ChannelType    // "weixin"
  accountName: string  // "alice"
}

const CHANNELS_JSON_PATH = join(SOCKET_DIR, 'channels.json')

export function loadChannelConfigs(): ChannelConfig[] {
  if (!existsSync(CHANNELS_JSON_PATH)) {
    // Backwards-compatible default: single weixin channel
    return [{ id: 'weixin', type: 'weixin', accountName: '微信' }]
  }
  return JSON.parse(readFileSync(CHANNELS_JSON_PATH, 'utf8'))
}

export function saveChannelConfigs(configs: ChannelConfig[]): void {
  writeFileSync(CHANNELS_JSON_PATH, JSON.stringify(configs, null, 2))
}
