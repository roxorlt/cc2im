import { describe, it, expect, vi } from 'vitest'
import { PermissionManager } from '../plugins/weixin/permission.js'

const mockCtx = {
  deliverToAgent: vi.fn(),
  broadcastMonitor: vi.fn(),
} as any

describe('PermissionManager channel matching', () => {
  it('does not match verdict from wrong channel', async () => {
    const mgr = new PermissionManager()

    // Register pending for user1 on weixin-roxor
    await mgr.handleRequest('agent-a', {
      requestId: 'req1', toolName: 'Bash', description: 'cmd', inputPreview: 'ls', userId: 'user1',
    }, mockCtx, vi.fn(), new Map([['agent-a', { userId: 'user1', channelId: 'weixin-roxor' }]]), null)

    // Try verdict from wrong channel
    const handled = mgr.tryHandleVerdict(
      { type: 'text', text: 'yes', userId: 'user1', channelId: 'weixin-family' },
      mockCtx,
    )
    expect(handled).toBe(false)
  })

  it('matches verdict from correct channel', async () => {
    const mgr = new PermissionManager()

    await mgr.handleRequest('agent-a', {
      requestId: 'req2', toolName: 'Bash', description: 'cmd', inputPreview: 'ls', userId: 'user1',
    }, mockCtx, vi.fn(), new Map([['agent-a', { userId: 'user1', channelId: 'weixin-roxor' }]]), null)

    const handled = mgr.tryHandleVerdict(
      { type: 'text', text: 'yes', userId: 'user1', channelId: 'weixin-roxor' },
      mockCtx,
    )
    expect(handled).toBe(true)
  })

  it('matches when no channelId provided (backward compat)', async () => {
    const mgr = new PermissionManager()

    await mgr.handleRequest('agent-a', {
      requestId: 'req3', toolName: 'Bash', description: 'cmd', inputPreview: 'ls',
    }, mockCtx, vi.fn(), new Map(), { userId: 'user1', channelId: 'weixin-roxor' })

    // No channelId in verdict — should still match by userId alone
    const handled = mgr.tryHandleVerdict(
      { type: 'text', text: 'yes', userId: 'user1' },
      mockCtx,
    )
    expect(handled).toBe(true)
  })
})
