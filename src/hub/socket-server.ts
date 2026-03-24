import { createServer, Socket } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'
import {
  HUB_SOCKET_PATH, ensureSocketDir, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { SpokeToHub, HubToSpoke } from '../shared/types.js'

interface ConnectedSpoke {
  agentId: string
  socket: Socket
}

export class HubSocketServer {
  private spokes = new Map<string, ConnectedSpoke>()
  private server = createServer()
  private onMessage: (agentId: string, msg: SpokeToHub) => void

  constructor(onMessage: (agentId: string, msg: SpokeToHub) => void) {
    this.onMessage = onMessage
  }

  start() {
    ensureSocketDir()
    if (existsSync(HUB_SOCKET_PATH)) unlinkSync(HUB_SOCKET_PATH)

    this.server.on('connection', (socket) => {
      let agentId: string | null = null

      const parser = createFrameParser((frame: any) => {
        // 第一条消息必须是注册
        if (!agentId && frame.type === 'register') {
          agentId = frame.agentId as string
          this.spokes.set(agentId!, { agentId: agentId!, socket })
          console.log(`[hub] Spoke registered: ${agentId}`)
          return
        }
        if (agentId) {
          this.onMessage(agentId, frame as SpokeToHub)
        }
      })

      socket.on('data', parser)
      socket.on('close', () => {
        if (agentId) {
          this.spokes.delete(agentId)
          console.log(`[hub] Spoke disconnected: ${agentId}`)
        }
      })
      socket.on('error', (err) => {
        console.error(`[hub] Socket error (${agentId}):`, err.message)
      })
    })

    this.server.listen(HUB_SOCKET_PATH, () => {
      console.log(`[hub] Listening on ${HUB_SOCKET_PATH}`)
    })
  }

  send(agentId: string, msg: HubToSpoke): boolean {
    const spoke = this.spokes.get(agentId)
    if (!spoke) return false
    spoke.socket.write(encodeFrame(msg))
    return true
  }

  getConnectedAgents(): string[] {
    return [...this.spokes.keys()]
  }

  stop() {
    this.server.close()
    if (existsSync(HUB_SOCKET_PATH)) unlinkSync(HUB_SOCKET_PATH)
  }
}
