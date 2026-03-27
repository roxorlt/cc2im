/**
 * Integration: Router + HubContext delivery flow
 *
 * Tests that messages are correctly routed and delivered,
 * with deliver:before/after events firing in the right order.
 */
import { describe, it, expect, vi } from 'vitest'
import { Router } from '../hub/router.js'
import { HubContextImpl } from '../hub/hub-context.js'
import type { AgentsConfig, HubToSpoke } from '../shared/types.js'

function makeConfig(): AgentsConfig {
  return {
    defaultAgent: 'brain',
    agents: {
      brain: { name: 'brain', cwd: '/tmp/brain', createdAt: '2026-01-01' },
      demo: { name: 'demo', cwd: '/tmp/demo', createdAt: '2026-01-01' },
    },
  }
}

/** Minimal mock for socket server — tracks send() calls */
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

describe('Message routing + delivery (integration)', () => {
  it('routes @mention message and delivers to correct agent', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('brain')
    socketServer.connected.add('demo')

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    // Route the message
    const route = router.route('@demo run tests')
    expect(route.agentId).toBe('demo')

    // Deliver
    const msg: HubToSpoke = {
      type: 'message',
      userId: 'user1',
      text: route.text,
      msgType: 'text',
      timestamp: new Date().toISOString(),
    }
    const delivered = ctx.deliverToAgent(route.agentId, msg)

    expect(delivered).toBe(true)
    expect(socketServer.sent).toHaveLength(1)
    expect(socketServer.sent[0].agentId).toBe('demo')
    expect(socketServer.sent[0].msg.type).toBe('message')
  })

  it('fires deliver:before and deliver:after events in order', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('brain')

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const events: string[] = []
    let capturedMessageId: string | undefined

    ctx.on('deliver:before', (agentId: string, _msg: any, messageId: string) => {
      events.push(`before:${agentId}`)
      capturedMessageId = messageId
    })
    ctx.on('deliver:after', (messageId: string, ok: boolean) => {
      events.push(`after:${ok}`)
      // messageId should match
      expect(messageId).toBe(capturedMessageId)
    })

    ctx.deliverToAgent('brain', {
      type: 'message',
      userId: 'u1',
      text: 'hello',
      msgType: 'text',
      timestamp: new Date().toISOString(),
    })

    expect(events).toEqual(['before:brain', 'after:true'])
  })

  it('deliver:after reports false when agent is disconnected', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    // brain NOT in connected set

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    let deliveredOk: boolean | undefined
    ctx.on('deliver:after', (_id: string, ok: boolean) => {
      deliveredOk = ok
    })

    const result = ctx.deliverToAgent('brain', {
      type: 'message',
      userId: 'u1',
      text: 'hello',
      msgType: 'text',
      timestamp: new Date().toISOString(),
    })

    expect(result).toBe(false)
    expect(deliveredOk).toBe(false)
  })

  it('no @mention routes to default agent', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('brain')

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const route = router.route('plain message')
    expect(route.agentId).toBe('brain')

    ctx.deliverToAgent(route.agentId, {
      type: 'message',
      userId: 'u1',
      text: route.text,
      msgType: 'text',
      timestamp: new Date().toISOString(),
    })

    expect(socketServer.sent).toHaveLength(1)
    expect(socketServer.sent[0].agentId).toBe('brain')
  })

  it('each delivery gets a unique messageId', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()
    socketServer.connected.add('brain')

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const messageIds: string[] = []
    ctx.on('deliver:before', (_agentId: string, _msg: any, messageId: string) => {
      messageIds.push(messageId)
    })

    const msg: HubToSpoke = {
      type: 'message',
      userId: 'u1',
      text: 'test',
      msgType: 'text',
      timestamp: new Date().toISOString(),
    }
    ctx.deliverToAgent('brain', msg)
    ctx.deliverToAgent('brain', msg)
    ctx.deliverToAgent('brain', msg)

    expect(messageIds).toHaveLength(3)
    expect(new Set(messageIds).size).toBe(3) // all unique
  })
})

describe('Channel registration (integration)', () => {
  it('registers and retrieves channels', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const mockChannel = {
      id: 'weixin-test',
      type: 'weixin' as const,
      label: 'test',
      connect: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(() => 'disconnected' as const),
      sendText: vi.fn(),
      sendFile: vi.fn(),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
    }

    ctx.registerChannel(mockChannel)
    expect(ctx.getChannel('weixin-test')).toBe(mockChannel)
    expect(ctx.getChannels()).toHaveLength(1)
  })

  it('removeChannel deletes and emits event', () => {
    const config = makeConfig()
    const router = new Router(config)
    const socketServer = createMockSocketServer()

    const ctx = new HubContextImpl(
      socketServer as any,
      createMockAgentManager() as any,
      router,
      config,
    )

    const mockChannel = {
      id: 'weixin-test',
      type: 'weixin' as const,
      label: 'test',
      connect: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(() => 'disconnected' as const),
      sendText: vi.fn(),
      sendFile: vi.fn(),
      startTyping: vi.fn(),
      stopTyping: vi.fn(),
      onMessage: vi.fn(),
      onStatusChange: vi.fn(),
    }

    ctx.registerChannel(mockChannel)

    const removed: string[] = []
    ctx.on('channel:remove', (id: string) => removed.push(id))

    ctx.removeChannel('weixin-test')

    expect(ctx.getChannel('weixin-test')).toBeUndefined()
    expect(removed).toEqual(['weixin-test'])
  })
})
