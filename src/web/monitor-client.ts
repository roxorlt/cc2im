/**
 * Hub Monitor Client — connects to hub.sock as read-only observer
 */

import { createConnection, Socket } from 'node:net'
import { HUB_SOCKET_PATH, encodeFrame, createFrameParser } from '../shared/socket.js'
import type { HubEvent } from '../shared/types.js'

const RECONNECT_INTERVAL = 3000
const MAX_RECONNECT_INTERVAL = 30000

export class MonitorClient {
  private socket: Socket | null = null
  private connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = RECONNECT_INTERVAL
  private onEvent: (event: HubEvent) => void

  constructor(onEvent: (event: HubEvent) => void) {
    this.onEvent = onEvent
  }

  connect() {
    this.doConnect()
  }

  private doConnect() {
    const socket = createConnection(HUB_SOCKET_PATH, () => {
      this.socket = socket
      this.connected = true
      this.reconnectDelay = RECONNECT_INTERVAL
      socket.write(encodeFrame({ type: 'register_monitor' }))
      console.log('[web] Connected to hub as monitor')
    })

    const parser = createFrameParser((frame: any) => {
      if (frame.type === 'hub_event') {
        this.onEvent(frame as HubEvent)
      }
    })

    socket.on('data', parser)

    socket.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        console.error(`[web] Monitor socket error: ${err.message}`)
      }
    })

    socket.on('close', () => {
      const wasConnected = this.connected
      this.connected = false
      this.socket = null
      if (wasConnected) {
        console.log('[web] Disconnected from hub')
      }
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.doConnect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_INTERVAL)
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
