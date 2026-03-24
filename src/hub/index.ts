/**
 * cc2im Hub — 常驻进程，持有唯一微信连接，消息路由 + agent 管理
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HubSocketServer } from './socket-server.js'
import { WeixinConnection } from './weixin.js'
import { Router } from './router.js'
import { SOCKET_DIR } from '../shared/socket.js'
import type { AgentsConfig, SpokeToHub } from '../shared/types.js'

// --- Config ---
const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')

function loadAgentsConfig(): AgentsConfig {
  if (existsSync(AGENTS_JSON_PATH)) {
    return JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  }
  return { defaultAgent: 'brain', agents: {} }
}

// --- Permission tracking ---
const pendingPermissions: Array<{
  requestId: string
  agentId: string
  toolName: string
  userId: string // 发给哪个微信用户的
}> = []

// --- Main ---
export async function startHub() {
  const config = loadAgentsConfig()
  const router = new Router(config)
  const weixin = new WeixinConnection()

  // --- Socket Server: 接收 spoke 消息 ---
  const socketServer = new HubSocketServer(async (agentId: string, msg: SpokeToHub) => {
    switch (msg.type) {
      case 'reply': {
        console.log(`[hub] Reply from ${agentId} to ${msg.userId}: ${msg.text.slice(0, 100)}`)
        await weixin.send(msg.userId, msg.text)
        break
      }
      case 'permission_request': {
        console.log(`[hub] Permission request from ${agentId}: ${msg.toolName}`)
        // Find the most recent user
        const userId = msg.agentId // will be overridden below
        // For now, broadcast to the user who last sent a message to this agent
        // TODO: track per-agent last user
        const targetUserId = (lastUserByAgent.get(agentId) || lastGlobalUser)
        if (!targetUserId) {
          console.log(`[hub] No user to forward permission request to`)
          break
        }

        pendingPermissions.push({
          requestId: msg.requestId,
          agentId,
          toolName: msg.toolName,
          userId: targetUserId,
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

        await weixin.send(targetUserId, prompt)
        break
      }
      case 'status': {
        console.log(`[hub] Agent ${agentId} status: ${msg.status}`)
        break
      }
    }
  })

  // --- Track which user last talked to which agent ---
  const lastUserByAgent = new Map<string, string>()
  let lastGlobalUser: string | null = null

  // Permission verdict detection
  const SIMPLE_RE = /^\s*(y|yes|ok|好|批准|always|始终|总是|n|no|不|拒绝)\s*$/i

  // --- WeChat message handler ---
  weixin.setMessageHandler((msg) => {
    const userId = msg.userId
    lastGlobalUser = userId

    // Check for permission verdict
    if (msg.type === 'text' && msg.text && pendingPermissions.length > 0) {
      const simpleMatch = msg.text.match(SIMPLE_RE)
      if (simpleMatch) {
        const reply = simpleMatch[1].trim().toLowerCase()
        const isAlways = /^(always|始终|总是)$/.test(reply)
        const isAllow = isAlways || /^(y|yes|ok|好|批准)$/i.test(reply)

        const pending = pendingPermissions.shift() // FIFO
        if (pending) {
          socketServer.send(pending.agentId, {
            type: 'permission_verdict',
            requestId: pending.requestId,
            behavior: isAllow ? 'allow' : 'deny',
          })
          console.log(`[hub] Permission verdict: ${pending.requestId} → ${isAllow ? 'allow' : 'deny'}`)
          // TODO: always-allow persistence (Task 4 spoke-side)
          return
        }
      }
    }

    // Route message to spoke
    const text = buildMessageContent(msg)
    const routed = router.route(msg.text || '')
    lastUserByAgent.set(routed.agentId, userId)

    const connected = socketServer.getConnectedAgents()
    if (!connected.includes(routed.agentId)) {
      console.log(`[hub] Agent ${routed.agentId} not connected, dropping message`)
      weixin.send(userId, `⚠ Agent "${routed.agentId}" 不在线。在线: ${connected.join(', ') || '无'}`)
      return
    }

    socketServer.send(routed.agentId, {
      type: 'message',
      userId,
      text,
      msgType: msg.type,
      mediaPath: msg.mediaPath ?? undefined,
      timestamp: msg.timestamp?.toISOString() ?? new Date().toISOString(),
    })
  })

  // --- Start everything ---
  socketServer.start()
  await weixin.login()
  weixin.startListening()
  await weixin.startPolling()
}

function buildMessageContent(msg: any): string {
  if (msg.type === 'voice' && msg.voiceText) {
    return `[微信 ${msg.userId}] (语音转文字) ${msg.voiceText}`
  } else if (msg.type === 'voice') {
    return `[微信 ${msg.userId}] (语音消息，无法识别)`
  } else if (msg.mediaPath) {
    return `[微信 ${msg.userId}] (${msg.type} 已下载到 ${msg.mediaPath})`
  } else if (msg.type !== 'text') {
    return `[微信 ${msg.userId}] (${msg.type} 消息，下载失败)`
  }
  return `[微信 ${msg.userId}] ${msg.text}`
}

// Run if executed directly
startHub().catch((err) => {
  console.error(`[hub] Fatal: ${err.message}`)
  process.exit(1)
})
