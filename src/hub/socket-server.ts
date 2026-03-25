import { createServer, createConnection, Socket } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'
import {
  HUB_SOCKET_PATH, ensureSocketDir, encodeFrame, createFrameParser
} from '../shared/socket.js'
import type { SpokeToHub, HubToSpoke, HubEvent, HubEventData } from '../shared/types.js'

/** Check if another hub is already listening on the socket path. */
function probeSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      conn.destroy()
      resolve(false) // Timed out — treat as stale
    }, 1000)

    const conn = createConnection(socketPath, () => {
      // Connection succeeded — another hub is alive
      clearTimeout(timeout)
      conn.destroy()
      resolve(true)
    })
    conn.on('error', () => {
      clearTimeout(timeout)
      resolve(false) // ECONNREFUSED / ENOENT — no hub listening
    })
  })
}

interface ConnectedSpoke {
  agentId: string
  socket: Socket
}

const HEARTBEAT_TIMEOUT_MS = 45_000 // 3 missed heartbeats (15s interval)

export class HubSocketServer {
  private spokes = new Map<string, ConnectedSpoke>()
  private lastHeartbeat = new Map<string, number>()
  private monitors = new Set<Socket>()
  private server = createServer()
  private onMessage: (agentId: string, msg: SpokeToHub) => void
  private heartbeatChecker: ReturnType<typeof setInterval> | null = null

  constructor(onMessage: (agentId: string, msg: SpokeToHub) => void) {
    this.onMessage = onMessage
  }

  async start() {
    ensureSocketDir()

    // Probe existing socket — refuse to start if another hub is alive
    if (existsSync(HUB_SOCKET_PATH)) {
      const alive = await probeSocket(HUB_SOCKET_PATH)
      if (alive) {
        console.error(`[hub] ✗ Another hub is already running on ${HUB_SOCKET_PATH}. Stop it first.`)
        process.exit(1)
      }
      // Stale socket from a crash — safe to clean up
      unlinkSync(HUB_SOCKET_PATH)
    }

    this.server.on('connection', (socket) => {
      let agentId: string | null = null
      let isMonitor = false

      const parser = createFrameParser((frame: any) => {
        // First message must be registration (spoke or monitor)
        if (!agentId && !isMonitor) {
          if (frame.type === 'register_monitor') {
            isMonitor = true
            this.monitors.add(socket)
            console.log(`[hub] Monitor connected (${this.monitors.size} total)`)
            return
          }
          if (frame.type === 'register') {
            agentId = frame.agentId as string
            const existing = this.spokes.get(agentId!)
            if (existing && existing.socket !== socket) {
              console.log(`[hub] Replacing stale connection for ${agentId}`)
            }
            this.spokes.set(agentId!, { agentId: agentId!, socket })
            this.lastHeartbeat.set(agentId!, Date.now())
            console.log(`[hub] Spoke registered: ${agentId}`)
            this.broadcast({ kind: 'agent_online', agentId: agentId!, timestamp: new Date().toISOString() })
            return
          }
        }
        // Monitor is read-only, ignore any further messages
        if (isMonitor) return
        if (agentId) {
          // Track heartbeats silently
          if (frame.type === 'heartbeat') {
            this.lastHeartbeat.set(agentId, Date.now())
            return
          }
          this.onMessage(agentId, frame as SpokeToHub)
        }
      })

      socket.on('data', parser)
      socket.on('close', () => {
        if (isMonitor) {
          this.monitors.delete(socket)
          console.log(`[hub] Monitor disconnected (${this.monitors.size} total)`)
          return
        }
        if (agentId) {
          const current = this.spokes.get(agentId)
          if (current && current.socket === socket) {
            this.spokes.delete(agentId)
            this.lastHeartbeat.delete(agentId)
            console.log(`[hub] Spoke disconnected: ${agentId}`)
            this.broadcast({ kind: 'agent_offline', agentId, timestamp: new Date().toISOString() })
          }
        }
      })
      socket.on('error', (err) => {
        console.error(`[hub] Socket error (${agentId || 'monitor'}):`, err.message)
      })
    })

    this.server.listen(HUB_SOCKET_PATH, () => {
      console.log(`[hub] Listening on ${HUB_SOCKET_PATH}`)
    })

    // Periodically evict spokes that missed heartbeats
    this.heartbeatChecker = setInterval(() => {
      const now = Date.now()
      for (const [agentId, lastSeen] of this.lastHeartbeat) {
        if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
          const spoke = this.spokes.get(agentId)
          if (spoke) {
            console.log(`[hub] Evicting stale spoke "${agentId}" (no heartbeat for ${Math.round((now - lastSeen) / 1000)}s)`)
            spoke.socket.destroy()
            this.spokes.delete(agentId)
            this.lastHeartbeat.delete(agentId)
            this.broadcast({ kind: 'agent_offline', agentId, timestamp: new Date().toISOString() })
          }
        }
      }
    }, 15_000)
  }

  send(agentId: string, msg: HubToSpoke): boolean {
    const spoke = this.spokes.get(agentId)
    if (!spoke) return false
    const ok = spoke.socket.write(encodeFrame(msg))
    if (!ok) console.log(`[hub] ⚠ Back-pressure on socket to ${agentId}`)
    if (spoke.socket.destroyed) console.log(`[hub] ⚠ Socket to ${agentId} is destroyed!`)
    return true
  }

  /** Broadcast an event to all connected monitors. No-op if none connected. */
  broadcast(event: HubEventData) {
    if (this.monitors.size === 0) return
    const frame = encodeFrame({ type: 'hub_event', event } as HubEvent)
    for (const socket of this.monitors) {
      socket.write(frame)
    }
  }

  getConnectedAgents(): string[] {
    return [...this.spokes.keys()]
  }

  stop() {
    if (this.heartbeatChecker) clearInterval(this.heartbeatChecker)
    this.server.close()
    if (existsSync(HUB_SOCKET_PATH)) unlinkSync(HUB_SOCKET_PATH)
  }
}
