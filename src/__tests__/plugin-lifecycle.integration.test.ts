/**
 * Integration: PluginManager + HubContext event wiring
 *
 * Tests that plugins correctly subscribe to events during init,
 * receive events when they fire, and clean up on destroy.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PluginManager } from '../hub/plugin-manager.js'
import type { Cc2imPlugin, HubContext } from '../shared/plugin.js'

/** Minimal HubContext stub — just needs to be an EventEmitter */
function createMockContext(): HubContext {
  const emitter = new EventEmitter() as HubContext
  emitter.deliverToAgent = vi.fn(() => true)
  emitter.broadcastMonitor = vi.fn()
  emitter.getConnectedAgents = vi.fn(() => [])
  emitter.getAgentManager = vi.fn() as any
  emitter.getRouter = vi.fn() as any
  emitter.getConfig = vi.fn(() => ({ defaultAgent: 'brain', agents: {} }))
  emitter.registerChannel = vi.fn()
  emitter.getChannel = vi.fn()
  emitter.getChannels = vi.fn(() => [])
  emitter.addChannel = vi.fn()
  emitter.removeChannel = vi.fn()
  return emitter
}

describe('Plugin lifecycle (integration)', () => {
  it('inits all plugins in registration order', async () => {
    const order: string[] = []
    const pluginA: Cc2imPlugin = {
      name: 'alpha',
      init: () => { order.push('alpha') },
      destroy: () => {},
    }
    const pluginB: Cc2imPlugin = {
      name: 'beta',
      init: () => { order.push('beta') },
      destroy: () => {},
    }

    const pm = new PluginManager()
    pm.register(pluginA)
    pm.register(pluginB)
    await pm.initAll(createMockContext())

    expect(order).toEqual(['alpha', 'beta'])
  })

  it('destroys plugins in reverse order', async () => {
    const order: string[] = []
    const pluginA: Cc2imPlugin = {
      name: 'alpha',
      init: () => {},
      destroy: () => { order.push('alpha') },
    }
    const pluginB: Cc2imPlugin = {
      name: 'beta',
      init: () => {},
      destroy: () => { order.push('beta') },
    }

    const pm = new PluginManager()
    pm.register(pluginA)
    pm.register(pluginB)
    await pm.initAll(createMockContext())
    await pm.destroyAll()

    expect(order).toEqual(['beta', 'alpha'])
  })

  it('plugin receives events via HubContext after init', async () => {
    const received: any[] = []
    const plugin: Cc2imPlugin = {
      name: 'listener',
      init(ctx) {
        ctx.on('spoke:message', (agentId: string, msg: any) => {
          received.push({ agentId, msg })
        })
      },
      destroy: () => {},
    }

    const ctx = createMockContext()
    const pm = new PluginManager()
    pm.register(plugin)
    await pm.initAll(ctx)

    // Simulate spoke message
    ctx.emit('spoke:message', 'brain', { type: 'reply', text: 'hello' })
    ctx.emit('spoke:message', 'demo', { type: 'reply', text: 'world' })

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ agentId: 'brain', msg: { type: 'reply', text: 'hello' } })
    expect(received[1]).toEqual({ agentId: 'demo', msg: { type: 'reply', text: 'world' } })
  })

  it('multiple plugins can listen to the same event', async () => {
    const counters = { a: 0, b: 0 }
    const pluginA: Cc2imPlugin = {
      name: 'counter-a',
      init(ctx) { ctx.on('agent:online', () => { counters.a++ }) },
      destroy: () => {},
    }
    const pluginB: Cc2imPlugin = {
      name: 'counter-b',
      init(ctx) { ctx.on('agent:online', () => { counters.b++ }) },
      destroy: () => {},
    }

    const ctx = createMockContext()
    const pm = new PluginManager()
    pm.register(pluginA)
    pm.register(pluginB)
    await pm.initAll(ctx)

    ctx.emit('agent:online', 'brain')

    expect(counters.a).toBe(1)
    expect(counters.b).toBe(1)
  })

  it('continues init even if one plugin throws', async () => {
    const inited: string[] = []
    const badPlugin: Cc2imPlugin = {
      name: 'bad',
      init() { throw new Error('boom') },
      destroy: () => {},
    }
    const goodPlugin: Cc2imPlugin = {
      name: 'good',
      init() { inited.push('good') },
      destroy: () => {},
    }

    const pm = new PluginManager()
    pm.register(badPlugin)
    pm.register(goodPlugin)
    await pm.initAll(createMockContext())

    expect(inited).toEqual(['good'])
  })

  it('continues destroy even if one plugin throws', async () => {
    const destroyed: string[] = []
    const badPlugin: Cc2imPlugin = {
      name: 'bad',
      init: () => {},
      destroy() { throw new Error('boom') },
    }
    const goodPlugin: Cc2imPlugin = {
      name: 'good',
      init: () => {},
      destroy() { destroyed.push('good') },
    }

    const pm = new PluginManager()
    pm.register(goodPlugin)
    pm.register(badPlugin)
    await pm.initAll(createMockContext())
    await pm.destroyAll()

    // bad is destroyed first (reverse order) but throws; good still destroys
    expect(destroyed).toEqual(['good'])
  })
})
