/**
 * cc2im Spoke — MCP channel server，桥接 CC ↔ Hub
 *
 * 启动流程：
 * 1. 从参数读取 agentId
 * 2. 连接 hub Unix socket，注册
 * 3. 启动 MCP channel server（stdio transport，给 CC 用）
 * 4. hub 消息 → MCP channel notification → CC
 * 5. CC weixin_reply → spoke → hub → 微信
 * 6. CC permission_request → spoke → hub → 微信
 * 7. 微信 verdict → hub → spoke → CC
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { SOCKET_DIR } from '../shared/socket.js'
import { SpokeSocketClient } from './socket-client.js'
import { createChannelServer, setupTools, connectTransport } from './channel-server.js'
import { PermissionRelay } from './permission.js'
import type { HubToSpoke } from '../shared/types.js'

// --- Parse args ---
const args = process.argv.slice(2)
const agentIdIdx = args.indexOf('--agent-id')
const agentId = agentIdIdx >= 0 ? args[agentIdIdx + 1] : 'default'

if (!agentId) {
  console.error('Usage: cc2im-spoke --agent-id <name>')
  process.exit(1)
}

// --- Redirect stdout/stderr to log file (stdio is reserved for MCP) ---
const LOG_FILE = join(SOCKET_DIR, 'agents', agentId, 'spoke.log')
function log(...msgArgs: unknown[]) {
  const line = `[${new Date().toISOString()}] ${msgArgs.join(' ')}\n`
  process.stderr.write(line)
  try { appendFileSync(LOG_FILE, line) } catch {}
}
console.log = log
console.error = (...msgArgs: unknown[]) => log('[ERROR]', ...msgArgs)

// --- Setup ---
const server = createChannelServer(agentId)

const socketClient = new SpokeSocketClient(agentId, (msg: HubToSpoke) => {
  switch (msg.type) {
    case 'message': {
      // Forward to CC as channel notification
      tools.setLastUserId(msg.userId)

      let content: string
      if (msg.msgType === 'voice') {
        content = msg.text
      } else if (msg.mediaPath) {
        content = msg.text
      } else {
        content = msg.text
      }

      server.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            userId: msg.userId,
            type: msg.msgType,
            source: 'weixin',
            timestamp: msg.timestamp,
          },
        },
      }).catch((err) => {
        console.error(`[spoke:${agentId}] Failed to push channel notification: ${err.message}`)
      })
      break
    }
    case 'permission_verdict': {
      permissionRelay.handleVerdict(msg.requestId, msg.behavior)
      break
    }
  }
})

const tools = setupTools(server, agentId, socketClient)
const permissionRelay = new PermissionRelay(agentId, server, socketClient)
permissionRelay.setup()

// --- Start ---
async function main() {
  // Connect MCP stdio first (CC is waiting for it)
  await connectTransport(server)

  // Then connect to hub
  await socketClient.connect()

  // Report ready
  socketClient.send({ type: 'status', agentId, status: 'ready' })
  console.log(`[spoke:${agentId}] Ready`)
}

main().catch((err) => {
  console.error(`[spoke:${agentId}] Fatal: ${err.message}`)
  process.exit(1)
})
