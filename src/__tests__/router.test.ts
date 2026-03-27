import { describe, it, expect } from 'vitest'
import { Router } from '../hub/router.js'
import type { AgentsConfig } from '../shared/types.js'

function makeConfig(overrides?: Partial<AgentsConfig>): AgentsConfig {
  return {
    defaultAgent: 'brain',
    agents: {
      brain: { name: 'brain', cwd: '/tmp/brain', createdAt: '2026-01-01' },
      demo: { name: 'demo', cwd: '/tmp/demo', createdAt: '2026-01-01' },
    },
    ...overrides,
  }
}

describe('Router', () => {
  describe('route()', () => {
    it('routes @mention to the named agent', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain 你好')
      expect(result).toMatchObject({
        agentId: 'brain',
        text: '你好',
        unknownAgent: false,
      })
    })

    it('strips @mention prefix from text', () => {
      const router = new Router(makeConfig())
      const result = router.route('@demo run tests please')
      expect(result.agentId).toBe('demo')
      expect(result.text).toBe('run tests please')
    })

    it('routes to default agent when no @mention', () => {
      const router = new Router(makeConfig())
      const result = router.route('hello world')
      expect(result).toMatchObject({
        agentId: 'brain',
        text: 'hello world',
        unknownAgent: false,
      })
    })

    it('marks unknown agent when @mention not in config', () => {
      const router = new Router(makeConfig())
      const result = router.route('@ghost 你好')
      expect(result).toMatchObject({
        agentId: 'ghost',
        unknownAgent: true,
      })
      // unknown agent preserves full original text
      expect(result.text).toBe('@ghost 你好')
    })

    it('intercepts restart command (中文)', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain 重启')
      expect(result.intercepted).toEqual({ command: 'restart' })
      expect(result.agentId).toBe('brain')
    })

    it('intercepts restart command (English)', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain restart')
      expect(result.intercepted).toEqual({ command: 'restart' })
    })

    it('intercepts /effort command', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain /effort high')
      expect(result.intercepted).toEqual({ command: 'effort', args: ['high'] })
    })

    it('does not intercept restart for unknown agent', () => {
      const router = new Router(makeConfig())
      const result = router.route('@ghost 重启')
      expect(result.intercepted).toBeUndefined()
      expect(result.unknownAgent).toBe(true)
    })

    it('passes channelId through', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain hi', 'weixin-roxor')
      expect(result.channelId).toBe('weixin-roxor')
    })

    it('uses channel default agent when no @mention', () => {
      const router = new Router(makeConfig({
        channelDefaults: { 'weixin-family': 'demo' },
      }))
      const result = router.route('hello', 'weixin-family')
      expect(result.agentId).toBe('demo')
    })

    it('falls back to global default when channel has no default', () => {
      const router = new Router(makeConfig({
        channelDefaults: { 'weixin-family': 'demo' },
      }))
      const result = router.route('hello', 'weixin-work')
      expect(result.agentId).toBe('brain')
    })

    it('handles multiline message text', () => {
      const router = new Router(makeConfig())
      const result = router.route('@brain line1\nline2\nline3')
      expect(result.agentId).toBe('brain')
      expect(result.text).toBe('line1\nline2\nline3')
    })
  })

  describe('getAgentNames()', () => {
    it('returns all configured agent names', () => {
      const router = new Router(makeConfig())
      expect(router.getAgentNames()).toEqual(['brain', 'demo'])
    })
  })

  describe('updateConfig()', () => {
    it('updates routing config dynamically', () => {
      const router = new Router(makeConfig())
      expect(router.route('@newbie hi').unknownAgent).toBe(true)

      router.updateConfig(makeConfig({
        agents: {
          brain: { name: 'brain', cwd: '/tmp/brain', createdAt: '2026-01-01' },
          newbie: { name: 'newbie', cwd: '/tmp/newbie', createdAt: '2026-01-01' },
        },
      }))
      expect(router.route('@newbie hi').unknownAgent).toBe(false)
    })
  })
})
