import { createConnection, Socket } from 'node:net'
import {
  HUB_SOCKET_PATH, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { HubToSpoke, SpokeToHub } from '../shared/types.js'

export class SpokeSocketClient {
  private socket: Socket | null = null
  private agentId: string
  private onMessage: (msg: HubToSpoke) => void

  constructor(agentId: string, onMessage: (msg: HubToSpoke) => void) {
    this.agentId = agentId
    this.onMessage = onMessage
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(HUB_SOCKET_PATH, () => {
        // 注册
        this.socket!.write(encodeFrame({ type: 'register', agentId: this.agentId }))
        console.log(`[spoke:${this.agentId}] Connected to hub`)
        resolve()
      })

      const parser = createFrameParser((frame) => {
        this.onMessage(frame as HubToSpoke)
      })

      this.socket.on('data', parser)
      this.socket.on('error', reject)
      this.socket.on('close', () => {
        console.log(`[spoke:${this.agentId}] Disconnected from hub`)
      })
    })
  }

  send(msg: SpokeToHub) {
    this.socket?.write(encodeFrame(msg))
  }

  disconnect() {
    this.socket?.end()
  }
}
