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

  /**
   * Start connecting to hub. Resolves immediately — connection happens
   * in the background with auto-reconnect. This ensures the spoke
   * process doesn't hang if the hub is unavailable at startup.
   */
  connect(): Promise<void> {
    this.doConnect()
    return Promise.resolve()
  }

  private doConnect() {
    const socket = createConnection(HUB_SOCKET_PATH, () => {
      this.socket = socket
      this.connected = true
      this.reconnectDelay = RECONNECT_INTERVAL
      socket.write(encodeFrame({ type: 'register', agentId: this.agentId }))
      console.log(`[spoke:${this.agentId}] Connected to hub`)
    })

    const parser = createFrameParser((frame) => {
      this.onMessage(frame as HubToSpoke)
    })

    socket.on('data', parser)

    socket.on('error', (err) => {
      // Suppress ECONNREFUSED noise — reconnect handles it
      if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        console.error(`[spoke:${this.agentId}] Socket error: ${err.message}`)
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

  /** Send a message. Returns false if not connected (message dropped). */
  send(msg: SpokeToHub): boolean {
    if (this.socket && this.connected) {
      this.socket.write(encodeFrame(msg))
      return true
    }
    console.log(`[spoke:${this.agentId}] Not connected, dropping message`)
    return false
  }

  isConnected(): boolean {
    return this.connected
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.end()
  }
}
