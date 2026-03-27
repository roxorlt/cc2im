/**
 * Tests: channel-manager outbound routing (resolveUserRef behavior)
 *
 * Verifies that replies route to the correct channel based on where
 * each userId was last seen, not just the agent's last tracked channel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createChannelManagerPlugin } from '../plugins/channel-manager/index.js'
import { HubContextImpl } from '../hub/hub-context.js'
import { Router } from '../hub/router.js'
import type { AgentsConfig, HubToSpoke } from '../shared/types.js'
import type { Cc2imChannel, IncomingChannelMessage, ChannelStatus, ChannelType } from '../shared/channel.js'

// Mock channel-config to avoid filesystem access during channel:remove tests
vi.mock('../shared/channel-config.js', () => ({
  loadChannelConfigs: () => [],
  saveChannelConfigs: () => {},
}))

// --- Helpers ---

function makeConfig(): AgentsConfig {
  return {
    defaultAgent: 'agent-a',
    agents: {
      'agent-a': { name: 'agent-a', cwd: '/tmp/a', createdAt: '2026-01-01' },
    },
  }
}

function createMockSocketServer() {
  const sent: Array<{ agentId: string; msg: HubToSpoke }> = []
  const connected = new Set<string>()
  return {
    sent,
    connected,
    send(agentId: string, msg: HubToSpoke) {
      if (!connected.has(agentId)) return false
      sent.push({ agentId, msg })
      return true
    },
    broadcast: vi.fn(),
    getConnectedAgents: () => [...connected],
    start: vi.fn(),
    stop: vi.fn(),
  }
}

function createMockAgentManager() {
  return {
    isManaged: vi.fn(() => false),
    killForRestart: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    list: vi.fn(() => []),
    register: vi.fn(),
    deregister: vi.fn(),
    restart: vi.fn(),
    getConfig: vi.fn(() => makeConfig()),
    startAutoAgents: vi.fn(),
    stopAll: vi.fn(),
    reloadConfig: vi.fn(),
    updateEffort: vi.fn(),
  }
}

/** Create a mock channel that captures onMessage handler and sendText calls */
function createMockChannel(id: string, type: ChannelType = 'weixin'): Cc2imChannel & {
  triggerMessage: (msg: IncomingChannelMessage) => Promise<void>
  sentTexts: Array<{ userId: string; text: string }>
} {
  let messageHandler: ((msg: IncomingChannelMessage) => Promise<void>) | null = null
  const sentTexts: Array<{ userId: string; text: string }> = []

  return {
    id,
    type,
    label: `${id}`,
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getStatus: vi.fn(() => 'connected' as ChannelStatus),
    sendText: vi.fn(async (userId: string, text: string) => {
      sentTexts.push({ userId, text })
    }),
    sendFile: vi.fn(async () => {}),
    startTyping: vi.fn(async () => {}),
    stopTyping: vi.fn(async () => {}),
    onMessage: vi.fn((handler) => { messageHandler = handler }),
    onStatusChange: vi.fn(),
    sentTexts,
    triggerMessage: async (msg: IncomingChannelMessage) => {
      if (!messageHandler) throw new Error(`onMessage not wired for channel ${id}`)
      await messageHandler(msg)
    },
  }
}

function makeIncomingMessage(channelId: string, userId: string, text: string): IncomingChannelMessage {
  return {
    channelId,
    channelType: 'weixin',
    userId,
    text,
    type: 'text',
    timestamp: new Date(),
  }
}

// --- Tests ---

describe('Channel routing: resolveUserRef multi-channel behavior', () => {
  let chRoxor: ReturnType<typeof createMockChannel>
  let chFamily: ReturnType<typeof createMockChannel>
  let ctx: HubContextImpl
  let plugin: ReturnType<typeof createChannelManagerPlugin>

  beforeEach(async () => {
    chRoxor = createMockChannel('weixin-roxor')
    chFamily = createMockChannel('weixin-family')

    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('agent-a')

    ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    plugin = createChannelManagerPlugin([chRoxor, chFamily])
    await plugin.init(ctx)
  })

  it('routes reply to the channel where the user was last seen', async () => {
    // user1 messages on weixin-roxor
    await chRoxor.triggerMessage(makeIncomingMessage('weixin-roxor', 'user1', 'hello from roxor'))

    // user2 messages on weixin-family (agent-a now tracks weixin-family)
    await chFamily.triggerMessage(makeIncomingMessage('weixin-family', 'user2', 'hello from family'))

    // Clear any auto-replies (offline messages, etc.) from sentTexts
    chRoxor.sentTexts.length = 0
    chFamily.sentTexts.length = 0

    // Agent replies to user1 — should go to weixin-roxor, not weixin-family
    ctx.emit('spoke:message', 'agent-a', {
      type: 'reply',
      userId: 'user1',
      text: 'reply to user1',
    })

    // Wait for async handler
    await new Promise(r => setTimeout(r, 50))

    expect(chRoxor.sentTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user1', text: 'reply to user1' }),
      ]),
    )
    // weixin-family should NOT have received this reply
    const familyUser1Msgs = chFamily.sentTexts.filter(m => m.userId === 'user1')
    expect(familyUser1Msgs).toHaveLength(0)
  })

  it('routes reply to the correct channel for each user independently', async () => {
    // user1 on weixin-roxor
    await chRoxor.triggerMessage(makeIncomingMessage('weixin-roxor', 'user1', 'hi'))
    // user2 on weixin-family
    await chFamily.triggerMessage(makeIncomingMessage('weixin-family', 'user2', 'hi'))

    chRoxor.sentTexts.length = 0
    chFamily.sentTexts.length = 0

    // Reply to user2 — should go to weixin-family
    ctx.emit('spoke:message', 'agent-a', {
      type: 'reply',
      userId: 'user2',
      text: 'reply to user2',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(chFamily.sentTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user2', text: 'reply to user2' }),
      ]),
    )
    const roxorUser2Msgs = chRoxor.sentTexts.filter(m => m.userId === 'user2')
    expect(roxorUser2Msgs).toHaveLength(0)
  })

  it('falls back to tracked channel when userId has no channel history', async () => {
    // user2 messages on weixin-family (sets agent-a tracked channel to weixin-family)
    await chFamily.triggerMessage(makeIncomingMessage('weixin-family', 'user2', 'hello'))

    chRoxor.sentTexts.length = 0
    chFamily.sentTexts.length = 0

    // Agent replies to unknown-user (never seen before) — falls back to agent's tracked channel
    ctx.emit('spoke:message', 'agent-a', {
      type: 'reply',
      userId: 'unknown-user',
      text: 'reply to unknown',
    })
    await new Promise(r => setTimeout(r, 50))

    // Should use weixin-family (agent's tracked channel) as fallback
    expect(chFamily.sentTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'unknown-user', text: 'reply to unknown' }),
      ]),
    )
  })

  it('updates channel mapping when user moves to a different channel', async () => {
    // user1 first messages on weixin-roxor
    await chRoxor.triggerMessage(makeIncomingMessage('weixin-roxor', 'user1', 'hello'))
    // user1 later messages on weixin-family
    await chFamily.triggerMessage(makeIncomingMessage('weixin-family', 'user1', 'hello again'))

    chRoxor.sentTexts.length = 0
    chFamily.sentTexts.length = 0

    // Reply to user1 — should go to weixin-family (their latest channel)
    ctx.emit('spoke:message', 'agent-a', {
      type: 'reply',
      userId: 'user1',
      text: 'reply after move',
    })
    await new Promise(r => setTimeout(r, 50))

    expect(chFamily.sentTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user1', text: 'reply after move' }),
      ]),
    )
    const roxorUser1Msgs = chRoxor.sentTexts.filter(m => m.text === 'reply after move')
    expect(roxorUser1Msgs).toHaveLength(0)
  })
})

describe('Channel routing: cleanup on channel:remove', () => {
  it('clears userId->channelId mappings when a channel is removed', async () => {
    const chRoxor = createMockChannel('weixin-roxor')
    const chFamily = createMockChannel('weixin-family')

    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('agent-a')

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const plugin = createChannelManagerPlugin([chRoxor, chFamily])
    await plugin.init(ctx)

    // user1 messages on weixin-roxor
    await chRoxor.triggerMessage(makeIncomingMessage('weixin-roxor', 'user1', 'hello'))
    // user2 messages on weixin-family
    await chFamily.triggerMessage(makeIncomingMessage('weixin-family', 'user2', 'hello'))

    chRoxor.sentTexts.length = 0
    chFamily.sentTexts.length = 0

    // Remove weixin-roxor — user1's channel mapping should be cleared
    ctx.emit('channel:remove', 'weixin-roxor')
    await new Promise(r => setTimeout(r, 50))

    // Now reply to user1 — should fall back to weixin-family (the agent's last tracked channel
    // from user2's message, since weixin-roxor mapping was cleaned up)
    ctx.emit('spoke:message', 'agent-a', {
      type: 'reply',
      userId: 'user1',
      text: 'reply after removal',
    })
    await new Promise(r => setTimeout(r, 50))

    // user1's dedicated mapping (weixin-roxor) is gone, so it falls back to agent's tracked
    // channel. Agent's tracked ref was user2 on weixin-family.
    expect(chFamily.sentTexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: 'user1', text: 'reply after removal' }),
      ]),
    )
    // weixin-roxor should not receive anything (it was removed from channelMap)
    const roxorMsgs = chRoxor.sentTexts.filter(m => m.text === 'reply after removal')
    expect(roxorMsgs).toHaveLength(0)
  })
})
