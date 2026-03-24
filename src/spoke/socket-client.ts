import { createConnection, Socket } from 'node:net'
import {
  HUB_SOCKET_PATH, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { HubToSpoke, SpokeToHub } from '../shared/types.js'

const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000

export class SpokeSocketClient {
  private socket: Socket | null = null
  private agentId: string
  private onMessage: (msg: HubToSpoke) => void
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_INTERVAL
  private connected = false

  constructor(agentId: string, onMessage: (msg: HubToSpoke) => void) {
    this.agentId = agentId
    this.onMessage = onMessage
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.doConnect(resolve, reject)
    })
  }

  private doConnect(onFirstConnect?: () => void, onFirstError?: (err: Error) => void) {
    const socket = createConnection(HUB_SOCKET_PATH, () => {
      this.socket = socket
      this.connected = true
      this.reconnectDelay = RECONNECT_INTERVAL
      socket.write(encodeFrame({ type: 'register', agentId: this.agentId }))
      console.log(`[spoke:${this.agentId}] Connected to hub`)
      onFirstConnect?.()
      onFirstConnect = undefined
      onFirstError = undefined
    })

    const parser = createFrameParser((frame) => {
      this.onMessage(frame as HubToSpoke)
    })

    socket.on('data', parser)

    socket.on('error', (err) => {
      if (onFirstError) {
        // 首次连接失败也走重连，不直接 reject
        console.log(`[spoke:${this.agentId}] Hub not available, retrying...`)
        onFirstError = undefined
        onFirstConnect = undefined
      }
    })

    socket.on('close', () => {
      const wasConnected = this.connected
      this.connected = false
      this.socket = null
      if (wasConnected) {
        console.log(`[spoke:${this.agentId}] Disconnected from hub`)
      }
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    console.log(`[spoke:${this.agentId}] Reconnecting in ${this.reconnectDelay / 1000}s...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, this.reconnectDelay)
    // 指数退避，上限 30s
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_INTERVAL)
  }

  send(msg: SpokeToHub) {
    if (this.socket && this.connected) {
      this.socket.write(encodeFrame(msg))
    } else {
      console.log(`[spoke:${this.agentId}] Not connected, dropping message`)
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.end()
  }
}
