/**
 * MCP Channel Server — spoke 侧
 * 从 cc2wx.ts 搬迁，改为通过 SpokeSocketClient 发消息到 hub
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { SpokeSocketClient } from './socket-client.js'
import type { HubToSpokeManagementResult } from '../shared/types.js'

export function createChannelServer(agentId: string) {
  const server = new Server(
    { name: `cc2im-spoke-${agentId}`, version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
      },
      instructions: [
        '微信消息通过 <channel source="cc2im"> 到达。',
        '使用 weixin_reply 工具回复文字消息。',
        '使用 weixin_send_file 工具发送图片或文件到微信（支持 jpg/png/gif/pdf 等格式）。',
        '回复时从 channel notification 的 meta.userId 提取用户 ID，传入 user_id 参数。',
        '回复不限长度，cc2im 会自动分段发送到微信。',
      ].join('\n'),
    },
  )

  return server
}

/** Pending management request resolvers */
const pendingManagement = new Map<string, {
  resolve: (result: { success: boolean; data?: any; error?: string }) => void
}>()

/** Handle management result from hub */
export function handleManagementResult(msg: HubToSpokeManagementResult) {
  const pending = pendingManagement.get(msg.requestId)
  if (pending) {
    pendingManagement.delete(msg.requestId)
    pending.resolve({ success: msg.success, data: msg.data, error: msg.error })
  }
}

/** Send management request and wait for result */
function sendManagement(
  socketClient: SpokeSocketClient,
  agentId: string,
  action: 'register' | 'deregister' | 'start' | 'stop' | 'list' | 'cron_create' | 'cron_list' | 'cron_delete' | 'cron_update',
  params?: Record<string, any>,
): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise((resolve) => {
    const requestId = randomUUID()
    pendingManagement.set(requestId, { resolve })

    const sent = socketClient.send({
      type: 'management',
      agentId,
      requestId,
      action,
      params,
    })

    if (!sent) {
      pendingManagement.delete(requestId)
      return resolve({ success: false, error: 'Hub not connected' })
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingManagement.has(requestId)) {
        pendingManagement.delete(requestId)
        resolve({ success: false, error: 'Management request timed out' })
      }
    }, 30_000)
  })
}

export function setupTools(server: Server, agentId: string, socketClient: SpokeSocketClient) {
  // Simple fallback: most recent userId. CC should pass explicit user_id from
  // notification meta whenever possible; this is only a last-resort default.
  let lastUserId: string | null = null

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'weixin_reply',
        description: '回复微信消息给最近发消息的用户',
        inputSchema: {
          type: 'object' as const,
          properties: {
            text: { type: 'string', description: '回复内容' },
            user_id: {
              type: 'string',
              description: '目标用户 ID — 从 channel notification 的 meta.userId 提取',
            },
          },
          required: ['text'],
        },
      },
      {
        name: 'weixin_send_file',
        description: '发送图片或文件到微信用户。支持 jpg/png/gif/pdf 等格式。图片以图片消息显示，其他格式以文件消息显示。',
        inputSchema: {
          type: 'object' as const,
          properties: {
            file_path: { type: 'string', description: '本地文件的绝对路径' },
            user_id: {
              type: 'string',
              description: '目标用户 ID — 从 channel notification 的 meta.userId 提取',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'agent_register',
        description: '注册一个新的 agent（CC 实例）',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'agent 名称，用于 @mention 路由' },
            cwd: { type: 'string', description: '工作目录的绝对路径' },
            claude_args: {
              type: 'array',
              items: { type: 'string' },
              description: '额外的 claude CLI 参数（如 ["--effort", "max"]）',
            },
          },
          required: ['name', 'cwd'],
        },
      },
      {
        name: 'agent_deregister',
        description: '注销一个 agent（停止进程 + 从配置中删除）',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'agent 名称' },
          },
          required: ['name'],
        },
      },
      {
        name: 'agent_start',
        description: '启动一个已注册的 agent',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'agent 名称' },
          },
          required: ['name'],
        },
      },
      {
        name: 'agent_stop',
        description: '停止一个正在运行的 agent',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: 'agent 名称' },
          },
          required: ['name'],
        },
      },
      {
        name: 'agent_list',
        description: '列出所有 agent 及其状态',
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
      },
      {
        name: 'hub_cron_create',
        description: '创建持久化定时任务（hub 管理，重启不丢失）。到点给指定 agent 发一条消息。',
        inputSchema: {
          type: 'object' as const,
          properties: {
            name: { type: 'string', description: '任务名称（如"每日晨报"）' },
            agent_id: { type: 'string', description: '目标 agent 名称（默认自己）' },
            schedule_type: { type: 'string', enum: ['cron', 'once', 'interval'], description: 'cron=重复(cron表达式) | once=一次性(ISO时间戳) | interval=固定间隔(毫秒)' },
            schedule_value: { type: 'string', description: 'cron: "0 9 * * *" | once: "2026-04-01T09:00:00+08:00" | interval: "3600000"' },
            timezone: { type: 'string', description: 'IANA 时区（默认 Asia/Shanghai）' },
            message: { type: 'string', description: '到点发给 agent 的消息内容' },
          },
          required: ['name', 'schedule_type', 'schedule_value', 'message'],
        },
      },
      {
        name: 'hub_cron_list',
        description: '列出持久化定时任务（可按 agent 筛选）',
        inputSchema: {
          type: 'object' as const,
          properties: {
            agent_id: { type: 'string', description: '按 agent 筛选（不填则列出所有）' },
          },
        },
      },
      {
        name: 'hub_cron_delete',
        description: '删除一个持久化定时任务',
        inputSchema: {
          type: 'object' as const,
          properties: {
            job_id: { type: 'string', description: '任务 ID' },
          },
          required: ['job_id'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'weixin_reply': {
        const { text, user_id } = args as { text: string; user_id?: string }
        const targetId = user_id || lastUserId

        if (!targetId) {
          return {
            content: [{ type: 'text' as const, text: '没有可回复的用户，等待微信消息...' }],
            isError: true,
          }
        }

        const sent = socketClient.send({
          type: 'reply',
          agentId,
          userId: targetId,
          text,
        })

        if (!sent) {
          return {
            content: [{ type: 'text' as const, text: 'Hub 未连接，消息未送达。稍后重试。' }],
            isError: true,
          }
        }

        return {
          content: [{ type: 'text' as const, text: `已发送到微信用户 ${targetId}` }],
        }
      }

      case 'weixin_send_file': {
        const { file_path, user_id } = args as { file_path: string; user_id?: string }
        const targetId = user_id || lastUserId

        if (!targetId) {
          return {
            content: [{ type: 'text' as const, text: '没有可回复的用户，等待微信消息...' }],
            isError: true,
          }
        }

        // Validate file exists
        if (!existsSync(file_path)) {
          return {
            content: [{ type: 'text' as const, text: `文件不存在: ${file_path}` }],
            isError: true,
          }
        }

        const sent = socketClient.send({
          type: 'send_file',
          agentId,
          userId: targetId,
          filePath: file_path,
        })

        if (!sent) {
          return {
            content: [{ type: 'text' as const, text: 'Hub 未连接，文件未送达。' }],
            isError: true,
          }
        }

        return {
          content: [{ type: 'text' as const, text: `文件已发送到微信用户 ${targetId}: ${file_path}` }],
        }
      }

      case 'agent_register': {
        const { name: agentName, cwd, claude_args } = args as {
          name: string; cwd: string; claude_args?: string[]
        }
        const result = await sendManagement(socketClient, agentId, 'register', {
          name: agentName, cwd, claudeArgs: claude_args,
        })
        return {
          content: [{ type: 'text' as const, text: result.success
            ? `Agent "${agentName}" 已注册 (cwd: ${cwd})`
            : `注册失败: ${result.error}` }],
          isError: !result.success,
        }
      }

      case 'agent_deregister': {
        const { name: agentName } = args as { name: string }
        const result = await sendManagement(socketClient, agentId, 'deregister', { name: agentName })
        return {
          content: [{ type: 'text' as const, text: result.success
            ? `Agent "${agentName}" 已注销`
            : `注销失败: ${result.error}` }],
          isError: !result.success,
        }
      }

      case 'agent_start': {
        const { name: agentName } = args as { name: string }
        const result = await sendManagement(socketClient, agentId, 'start', { name: agentName })
        return {
          content: [{ type: 'text' as const, text: result.success
            ? `Agent "${agentName}" 已启动`
            : `启动失败: ${result.error}` }],
          isError: !result.success,
        }
      }

      case 'agent_stop': {
        const { name: agentName } = args as { name: string }
        const result = await sendManagement(socketClient, agentId, 'stop', { name: agentName })
        return {
          content: [{ type: 'text' as const, text: result.success
            ? `Agent "${agentName}" 已停止`
            : `停止失败: ${result.error}` }],
          isError: !result.success,
        }
      }

      case 'agent_list': {
        const result = await sendManagement(socketClient, agentId, 'list')
        if (!result.success) {
          return {
            content: [{ type: 'text' as const, text: `查询失败: ${result.error}` }],
            isError: true,
          }
        }
        const agents = result.data as Array<{
          name: string; cwd: string; status: string;
          autoStart: boolean; claudeArgs: string[]; isDefault: boolean
        }>
        if (agents.length === 0) {
          return { content: [{ type: 'text' as const, text: '没有已注册的 agent' }] }
        }
        const lines = agents.map(a =>
          `${a.isDefault ? '★' : '·'} ${a.name} [${a.status}] — ${a.cwd}` +
          (a.claudeArgs.length ? ` (${a.claudeArgs.join(' ')})` : '') +
          (a.autoStart ? ' [autoStart]' : '')
        )
        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        }
      }

      case 'hub_cron_create': {
        const { name: jobName, agent_id, schedule_type, schedule_value, timezone, message } = args as any
        const result = await sendManagement(socketClient, agentId, 'cron_create', {
          name: jobName, agentId: agent_id, scheduleType: schedule_type,
          scheduleValue: schedule_value, timezone, message,
        })
        if (!result.success) {
          return { content: [{ type: 'text' as const, text: `创建失败: ${result.error}` }], isError: true }
        }
        const job = result.data
        return {
          content: [{ type: 'text' as const, text:
            `✅ 定时任务已创建\n` +
            `ID: ${job.id}\n` +
            `名称: ${job.name}\n` +
            `目标: ${job.agentId}\n` +
            `调度: ${job.scheduleType} "${job.scheduleValue}"\n` +
            `下次执行: ${job.nextRun}\n` +
            `消息: ${job.message}`
          }],
        }
      }

      case 'hub_cron_list': {
        const { agent_id } = args as any
        const result = await sendManagement(socketClient, agentId, 'cron_list', { agentId: agent_id })
        if (!result.success) {
          return { content: [{ type: 'text' as const, text: `查询失败: ${result.error}` }], isError: true }
        }
        const jobs = result.data as any[]
        if (jobs.length === 0) {
          return { content: [{ type: 'text' as const, text: '没有定时任务' }] }
        }
        const lines = jobs.map((j: any) => {
          const status = j.enabled ? '🟢' : '⏸️'
          const runs = j.recentRuns?.length ? ` (最近: ${j.recentRuns[0].status} @ ${j.recentRuns[0].firedAt})` : ''
          return `${status} ${j.name} [${j.scheduleType}: ${j.scheduleValue}] → ${j.agentId}\n   下次: ${j.nextRun || '无'}${runs}\n   ID: ${j.id}`
        })
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] }
      }

      case 'hub_cron_delete': {
        const { job_id } = args as any
        const result = await sendManagement(socketClient, agentId, 'cron_delete', { jobId: job_id })
        return {
          content: [{ type: 'text' as const, text: result.success ? '✅ 定时任务已删除' : `删除失败: ${result.error}` }],
          isError: !result.success,
        }
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  function setLastUserId(userId: string) {
    lastUserId = userId
  }

  /** The userId of the most recent message (for permission routing). */
  function getCurrentUserId(): string | null {
    return lastUserId
  }

  return { setLastUserId, getCurrentUserId }
}

export async function connectTransport(server: Server) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[spoke] MCP server connected via stdio')
}
