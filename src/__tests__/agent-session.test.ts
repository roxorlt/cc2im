import { describe, it, expect, vi } from 'vitest'
import { isSessionId, sessionLaunch } from '../shared/agent-session.js'

const ID_A = '11111111-2222-4333-8444-555555555555'
const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('isSessionId', () => {
  it('accepts canonical UUIDs (any case)', () => {
    expect(isSessionId(ID_A)).toBe(true)
    expect(isSessionId(ID_B.toUpperCase())).toBe(true)
  })

  it('rejects anything --resume could misread as a search term', () => {
    expect(isSessionId(undefined)).toBe(false)
    expect(isSessionId('')).toBe(false)
    expect(isSessionId('my-session')).toBe(false)
    expect(isSessionId(`${ID_A} --fork-session`)).toBe(false)
    expect(isSessionId(ID_A.slice(0, 8))).toBe(false)
    expect(isSessionId(42)).toBe(false)
  })
})

describe('sessionLaunch', () => {
  it('resumes the recorded session by id — never --continue', () => {
    const newId = vi.fn(() => ID_B)
    const launch = sessionLaunch(ID_A, false, newId)
    expect(launch).toEqual({ args: ['--resume', ID_A], sessionId: ID_A, resumed: true })
    expect(newId).not.toHaveBeenCalled()
  })

  it('starts a new session with a pre-assigned id when nothing is recorded', () => {
    expect(sessionLaunch(undefined, false, () => ID_B))
      .toEqual({ args: ['--session-id', ID_B], sessionId: ID_B, resumed: false })
  })

  it('starts a new session when asked for a fresh start, even if one is recorded', () => {
    expect(sessionLaunch(ID_A, true, () => ID_B))
      .toEqual({ args: ['--session-id', ID_B], sessionId: ID_B, resumed: false })
  })

  it('treats a malformed recorded value as absent', () => {
    expect(sessionLaunch('not-a-uuid', false, () => ID_B).resumed).toBe(false)
  })

  it('mints real UUIDs by default', () => {
    const launch = sessionLaunch(undefined, false)
    expect(isSessionId(launch.sessionId)).toBe(true)
    expect(launch.args).toEqual(['--session-id', launch.sessionId])
  })

  it('never emits --continue', () => {
    for (const [recorded, fresh] of [[ID_A, false], [ID_A, true], [undefined, false]] as const) {
      expect(sessionLaunch(recorded, fresh, () => ID_B).args).not.toContain('--continue')
    }
  })
})
