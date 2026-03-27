/**
 * Permission state management for channel-based approval flow.
 * Tracks pending permission requests and matches incoming messages as verdicts.
 *
 * Channel-agnostic: accepts a sendFn callback for sending prompts,
 * and a UserRef map for resolving target users.
 */

import type { HubContext } from '../../shared/plugin.js'

/** Identifies a user on a specific channel */
export interface UserRef {
  userId: string
  channelId: string
}

interface PendingPermission {
  requestId: string
  agentId: string
  toolName: string
  userId: string
  createdAt: number
}

const PERMISSION_TTL_MS = 6 * 60 * 1000 // 6 minutes (spoke timeout is 5 min)
const SIMPLE_RE = /^\s*(y|yes|ok|好|批准|always|始终|总是|n|no|不|拒绝)\s*$/i

export class PermissionManager {
  private pending: PendingPermission[] = []

  /** Handle a permission_request from a spoke */
  async handleRequest(
    agentId: string,
    msg: { requestId: string; toolName: string; description: string; inputPreview: string; userId?: string },
    ctx: HubContext,
    sendFn: (userId: string, text: string) => Promise<void>,
    lastUserByAgent: Map<string, UserRef>,
    lastGlobalUser: UserRef | null,
  ) {
    const ref = msg.userId
      ? { userId: msg.userId, channelId: lastUserByAgent.get(agentId)?.channelId || lastGlobalUser?.channelId || '' }
      : lastUserByAgent.get(agentId) || lastGlobalUser
    const targetUserId = ref?.userId
    if (!targetUserId) {
      console.log(`[hub] No user to forward permission request to`)
      return
    }

    this.pending.push({
      requestId: msg.requestId,
      agentId,
      toolName: msg.toolName,
      userId: targetUserId,
      createdAt: Date.now(),
    })

    let preview = msg.inputPreview
    try {
      const parsed = JSON.parse(preview)
      if (parsed.command) preview = parsed.command
      else if (parsed.file_path) preview = parsed.file_path
      else preview = JSON.stringify(parsed, null, 2)
    } catch { /* keep original */ }

    const prompt = [
      `🔐 [${agentId}] Claude 请求权限`,
      `工具: ${msg.toolName}`,
      `说明: ${msg.description}`,
      '',
      preview.slice(0, 800),
      '',
      `回复 yes 批准 / always 始终批准 / no 拒绝`,
    ].join('\n')

    ctx.broadcastMonitor({ kind: 'permission_request', agentId, toolName: msg.toolName, timestamp: new Date().toISOString() })
    await sendFn(targetUserId, prompt)
  }

  /** Try to match an incoming WeChat message as a permission verdict. Returns true if handled. */
  tryHandleVerdict(
    msg: { type: string; text?: string; userId: string },
    ctx: HubContext,
  ): boolean {
    if (msg.type !== 'text' || !msg.text || this.pending.length === 0) return false

    const simpleMatch = msg.text.match(SIMPLE_RE)
    if (!simpleMatch) return false

    const reply = simpleMatch[1].trim().toLowerCase()
    const isAlways = /^(always|始终|总是)$/.test(reply)
    const isAllow = isAlways || /^(y|yes|ok|好|批准)$/i.test(reply)

    const idx = this.pending.findIndex(p => p.userId === msg.userId)
    if (idx < 0) return false

    const pending = this.pending.splice(idx, 1)[0]
    const behavior = isAlways ? 'always' : isAllow ? 'allow' : 'deny'
    ctx.deliverToAgent(pending.agentId, {
      type: 'permission_verdict',
      requestId: pending.requestId,
      behavior,
      toolName: pending.toolName,
    })
    console.log(`[hub] Permission verdict: ${pending.requestId} → ${behavior}`)
    ctx.broadcastMonitor({ kind: 'permission_verdict', agentId: pending.agentId, behavior, timestamp: new Date().toISOString() })
    return true
  }

  /** Handle permission_timeout from spoke */
  handleTimeout(requestId: string) {
    const idx = this.pending.findIndex(p => p.requestId === requestId)
    if (idx >= 0) {
      this.pending.splice(idx, 1)
      console.log(`[hub] Permission expired: ${requestId} (removed from queue)`)
    }
  }

  /** Clean up stale permissions (called periodically) */
  cleanup() {
    const now = Date.now()
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (now - this.pending[i].createdAt > PERMISSION_TTL_MS) {
        console.log(`[hub] Cleaning stale permission: ${this.pending[i].requestId}`)
        this.pending.splice(i, 1)
      }
    }
  }
}
