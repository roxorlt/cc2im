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
        '使用 weixin_reply 工具回复微信消息。',
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
  action: 'register' | 'deregister' | 'start' | 'stop' | 'list',
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
  // Queue of userIds from incoming messages, in arrival order.
  // CC processes messages serially: push on message arrival, shift on reply.
  // This prevents a later message from stealing an earlier message's reply target.
  const replyTargets: string[] = []

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
              description: '目标用户 ID（可选，默认回复最近一条消息的发送者）',
            },
          },
          required: ['text'],
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
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params

    switch (name) {
      case 'weixin_reply': {
        const { text, user_id } = args as { text: string; user_id?: string }
        // Explicit user_id takes priority; otherwise consume from the queue (FIFO)
        const targetId = user_id || replyTargets.shift() || null

        if (!targetId) {
          return {
            content: [{ type: 'text' as const, text: '没有可回复的用户，等待微信消息...' }],
            isError: true,
          }
        }

        socketClient.send({
          type: 'reply',
          agentId,
          userId: targetId,
          text,
        })

        return {
          content: [{ type: 'text' as const, text: `已发送到微信用户 ${targetId}` }],
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

      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  function pushReplyTarget(userId: string) {
    replyTargets.push(userId)
  }

  /** The userId of the message currently being processed (front of queue). */
  function getCurrentUserId(): string | null {
    return replyTargets[0] || null
  }

  return { pushReplyTarget, getCurrentUserId }
}

export async function connectTransport(server: Server) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[spoke] MCP server connected via stdio')
}
