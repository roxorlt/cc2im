import { describe, it, expect } from 'vitest'
import { registerFrame } from '../spoke/socket-client.js'

describe('spoke register frame', () => {
  it('reports the CC session id the spoke runs in, so the hub can record the agent\'s own session', () => {
    const frame = registerFrame('brain', 4321, { CLAUDE_CODE_SESSION_ID: '11111111-2222-4333-8444-555555555555' })
    expect(frame).toEqual({
      type: 'register', agentId: 'brain', pid: 4321, sessionId: '11111111-2222-4333-8444-555555555555',
    })
  })

  it('omits sessionId when CC did not provide one', () => {
    const frame = registerFrame('brain', 4321, {})
    expect(frame).toEqual({ type: 'register', agentId: 'brain', pid: 4321 })
    expect('sessionId' in frame).toBe(false)
  })
})
