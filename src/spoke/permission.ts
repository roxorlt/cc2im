/**
 * Permission relay — spoke 侧
 * 从 cc2wx.ts:257-425 搬迁，改为走 hub socket
 *
 * 流程：
 * CC permission_request → spoke 转发到 hub → hub 转发到微信
 * 微信 verdict → hub → spoke → CC
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SOCKET_DIR } from '../shared/socket.js'
import type { SpokeSocketClient } from './socket-client.js'

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

export class PermissionRelay {
  private alwaysAllow: Set<string>
  private allowListPath: string
  private pendingVerdicts = new Map<string, { resolve: (behavior: 'allow' | 'deny') => void; toolName: string }>()

  constructor(
    private agentId: string,
    private server: Server,
    private socketClient: SpokeSocketClient,
  ) {
    this.allowListPath = join(SOCKET_DIR, 'agents', agentId, 'always-allow.json')
    this.alwaysAllow = this.loadAllowList()
  }

  private loadAllowList(): Set<string> {
    try {
      if (existsSync(this.allowListPath)) {
        const data = JSON.parse(readFileSync(this.allowListPath, 'utf8'))
        console.log(`[spoke:${this.agentId}] Loaded ${data.length} always-allow patterns`)
        return new Set(data)
      }
    } catch (err) {
      console.error(`[spoke:${this.agentId}] Failed to load allow list: ${err instanceof Error ? err.message : String(err)}`)
    }
    return new Set()
  }

  private saveAllowList() {
    try {
      const dir = join(SOCKET_DIR, 'agents', this.agentId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(this.allowListPath, JSON.stringify([...this.alwaysAllow], null, 2) + '\n')
      console.log(`[spoke:${this.agentId}] Saved ${this.alwaysAllow.size} always-allow patterns`)
    } catch (err) {
      console.error(`[spoke:${this.agentId}] Failed to save allow list: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Register the notification handler on the MCP server */
  setup() {
    this.server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
      console.log(`[spoke:${this.agentId}] Permission request: id=${params.request_id} tool=${params.tool_name}`)

      // Auto-approve if in always-allow list
      if (this.alwaysAllow.has(params.tool_name)) {
        console.log(`[spoke:${this.agentId}] Auto-approved ${params.tool_name} (always allow)`)
        await this.server.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: params.request_id, behavior: 'allow' },
        })
        return
      }

      // Forward to hub via socket
      this.socketClient.send({
        type: 'permission_request',
        agentId: this.agentId,
        requestId: params.request_id,
        toolName: params.tool_name,
        description: params.description,
        inputPreview: params.input_preview,
      })

      // Wait for verdict from hub (will be resolved by handleVerdict)
      const behavior = await new Promise<'allow' | 'deny'>((resolve) => {
        this.pendingVerdicts.set(params.request_id, { resolve, toolName: params.tool_name })
        // Timeout: auto-deny after 5 minutes
        setTimeout(() => {
          if (this.pendingVerdicts.has(params.request_id)) {
            this.pendingVerdicts.delete(params.request_id)
            resolve('deny')
            this.socketClient.send({
              type: 'permission_timeout',
              agentId: this.agentId,
              requestId: params.request_id,
            })
            console.log(`[spoke:${this.agentId}] Permission timeout: ${params.request_id}`)
          }
        }, 5 * 60 * 1000)
      })

      await this.server.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: params.request_id, behavior },
      })
      console.log(`[spoke:${this.agentId}] Permission verdict forwarded to CC: ${params.request_id} → ${behavior}`)
    })
  }

  /** Called when hub sends a verdict back */
  handleVerdict(requestId: string, behavior: 'allow' | 'deny' | 'always', toolName?: string) {
    const pending = this.pendingVerdicts.get(requestId)
    if (pending) {
      this.pendingVerdicts.delete(requestId)
      if (behavior === 'always') {
        const tool = toolName || pending.toolName
        this.addAlwaysAllow(tool)
        console.log(`[spoke:${this.agentId}] Always-allow added: ${tool}`)
        pending.resolve('allow')
      } else {
        pending.resolve(behavior)
      }
    } else {
      console.log(`[spoke:${this.agentId}] Verdict for unknown request: ${requestId}`)
    }
  }

  /** Add a tool to always-allow list */
  addAlwaysAllow(toolName: string) {
    this.alwaysAllow.add(toolName)
    this.saveAllowList()
  }
}
