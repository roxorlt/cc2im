import { describe, it, expect } from 'vitest'
import { AGENT_ENV_VAR, isManagedAgentEnv } from '../shared/agent-env.js'

describe('agent-env guard', () => {
  it('accepts env explicitly marked as managed agent', () => {
    expect(isManagedAgentEnv({ [AGENT_ENV_VAR]: '1' })).toBe(true)
  })

  it('rejects env without the marker (inherited .mcp.json session)', () => {
    expect(isManagedAgentEnv({})).toBe(false)
    expect(isManagedAgentEnv({ PATH: '/usr/bin' })).toBe(false)
  })

  it('rejects wrong values — only the exact "1" opts in', () => {
    expect(isManagedAgentEnv({ [AGENT_ENV_VAR]: '0' })).toBe(false)
    expect(isManagedAgentEnv({ [AGENT_ENV_VAR]: 'true' })).toBe(false)
    expect(isManagedAgentEnv({ [AGENT_ENV_VAR]: '' })).toBe(false)
  })
})
