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
import type { SpokeSocketClient } from './socket-client.js'

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

export function setupTools(server: Server, agentId: string, socketClient: SpokeSocketClient) {
  // Track which user to reply to
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
              description: '目标用户 ID（可选，默认回复最近一条消息的发送者）',
            },
          },
          required: ['text'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'weixin_reply') {
      return {
        content: [{ type: 'text' as const, text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      }
    }

    const args = request.params.arguments as { text: string; user_id?: string }
    const targetId = args.user_id || lastUserId

    if (!targetId) {
      return {
        content: [{ type: 'text' as const, text: '没有可回复的用户，等待微信消息...' }],
        isError: true,
      }
    }

    // Send reply through hub
    socketClient.send({
      type: 'reply',
      agentId,
      userId: targetId,
      text: args.text,
    })

    return {
      content: [{ type: 'text' as const, text: `已发送到微信用户 ${targetId}` }],
    }
  })

  /** Update the last user ID (called when hub forwards a message) */
  function setLastUserId(userId: string) {
    lastUserId = userId
  }

  return { setLastUserId }
}

export async function connectTransport(server: Server) {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[spoke] MCP server connected via stdio')
}
