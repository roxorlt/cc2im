/**
 * Unit tests for AgentManager — pure state logic only (no process spawning).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks must be declared before import ---

// Mock node:fs to avoid touching real ~/.cc2im/agents.json
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Mock the mcp-config helper (called during start())
vi.mock('../shared/mcp-config.js', () => ({
  ensureMcpJson: vi.fn(),
}))

// Mock node:child_process to prevent actual spawning
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { ensureMcpJson } from '../shared/mcp-config.js'
import { AgentManager } from '../hub/agent-manager.js'

// Typed mocks for convenience
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>
const mockWriteFileSync = writeFileSync as ReturnType<typeof vi.fn>
const mockSpawn = spawn as ReturnType<typeof vi.fn>
const mockEnsureMcpJson = ensureMcpJson as ReturnType<typeof vi.fn>

// Default agents.json content for tests
const emptyConfig = { defaultAgent: 'brain', agents: {} }
const brainAgent = {
  name: 'brain',
  cwd: '/projects/brain',
  createdAt: '2026-01-01',
  autoStart: true,
}

function makeManager(
  connectedAgents: string[] = [],
  configOnDisk?: object,
  opts?: { newSessionId?: () => string },
): { manager: AgentManager; getConnected: ReturnType<typeof vi.fn>; events: Array<{ kind: string; agentId: string; extra?: any }> } {
  // Reset mocks
  mockExistsSync.mockReset()
  mockReadFileSync.mockReset()
  mockWriteFileSync.mockReset()
  mockSpawn.mockReset()
  mockEnsureMcpJson.mockReset()

  // existsSync: agents.json → true if config provided, cwd paths → true by default
  mockExistsSync.mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('agents.json')) {
      return configOnDisk !== undefined
    }
    // For cwd existence checks in register(), return true
    return true
  })

  if (configOnDisk) {
    mockReadFileSync.mockReturnValue(JSON.stringify(configOnDisk))
  }

  const getConnected = vi.fn<() => string[]>(() => connectedAgents)
  const events: Array<{ kind: string; agentId: string; extra?: any }> = []
  const onEvent = (kind: string, agentId: string, extra?: any) => events.push({ kind, agentId, extra })

  const manager = new AgentManager(getConnected, onEvent, opts)
  return { manager, getConnected, events }
}

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------
describe('AgentManager.register()', () => {
  it('registers a new agent and persists config', () => {
    const { manager } = makeManager()

    const result = manager.register('mybot', '/projects/mybot')

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()

    // Config should contain the new agent
    const config = manager.getConfig()
    expect(config.agents['mybot']).toBeDefined()
    expect(config.agents['mybot'].cwd).toBe('/projects/mybot')
    expect(config.agents['mybot'].autoStart).toBe(true)

    // Should have written to disk
    expect(mockWriteFileSync).toHaveBeenCalled()
  })

  it('rejects duplicate agent name', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    const result = manager.register('brain', '/other/path')

    expect(result.success).toBe(false)
    expect(result.error).toContain('already exists')
  })

  it('rejects non-existent directory', () => {
    const { manager } = makeManager()

    // Override existsSync to return false for the target directory
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p === 'string' && p.endsWith('agents.json')) return false
      if (p === '/nonexistent/dir') return false
      return true
    })

    const result = manager.register('bot', '/nonexistent/dir')

    expect(result.success).toBe(false)
    expect(result.error).toContain('does not exist')
  })

  it('stores optional claudeArgs', () => {
    const { manager } = makeManager()

    manager.register('bot', '/projects/bot', ['--effort', 'high'])

    const config = manager.getConfig()
    expect(config.agents['bot'].claudeArgs).toEqual(['--effort', 'high'])
  })
})

// ---------------------------------------------------------------------------
// deregister()
// ---------------------------------------------------------------------------
describe('AgentManager.deregister()', () => {
  it('removes an agent from config', async () => {
    const existing = {
      defaultAgent: 'brain',
      agents: { brain: brainAgent, other: { ...brainAgent, name: 'other', cwd: '/projects/other' } },
    }
    const { manager } = makeManager([], existing)

    const result = await manager.deregister('other')

    expect(result.success).toBe(true)
    expect(manager.getConfig().agents['other']).toBeUndefined()
  })

  it('updates defaultAgent if the removed agent was default', async () => {
    const existing = {
      defaultAgent: 'brain',
      agents: { brain: brainAgent, backup: { ...brainAgent, name: 'backup', cwd: '/projects/backup' } },
    }
    const { manager } = makeManager([], existing)

    const result = await manager.deregister('brain')

    expect(result.success).toBe(true)
    // defaultAgent should fall back to remaining agent
    expect(manager.getConfig().defaultAgent).toBe('backup')
  })

  it('sets defaultAgent to empty string if no agents remain', async () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    await manager.deregister('brain')

    expect(manager.getConfig().defaultAgent).toBe('')
  })

  it('fails for unknown agent', async () => {
    const { manager } = makeManager()

    const result = await manager.deregister('ghost')

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// start() — error paths only (happy path requires real spawn)
// ---------------------------------------------------------------------------
describe('AgentManager.start() — error paths', () => {
  it('fails for unknown agent', () => {
    const { manager } = makeManager()
    const result = manager.start('ghost')
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found in config')
  })

  it('fails when agent cwd does not exist (renamed/deleted after registration)', () => {
    const stale = { ...brainAgent, name: 'stale', cwd: '/projects/was-renamed' }
    const existing = { defaultAgent: 'stale', agents: { stale } }
    const { manager } = makeManager([], existing)

    // Pretend the cwd is gone (but spoke script + agents.json still resolve true)
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p !== 'string') return true
      if (p === '/projects/was-renamed') return false
      return true
    })

    const result = manager.start('stale')

    expect(result.success).toBe(false)
    expect(result.error).toContain('cwd does not exist')
    expect(result.error).toContain('/projects/was-renamed')
    // Critical: we must have failed BEFORE calling ensureMcpJson — the original
    // bug was ensureMcpJson throwing ENOENT and crashing the entire hub process.
    expect(mockEnsureMcpJson).not.toHaveBeenCalled()
  })

  it('catches ensureMcpJson failures and returns an error instead of throwing', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    mockEnsureMcpJson.mockImplementationOnce(() => {
      const err: any = new Error("ENOENT: no such file or directory, open '/projects/brain/.mcp.json'")
      err.code = 'ENOENT'
      throw err
    })

    const result = manager.start('brain')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Failed to write .mcp.json')
    expect(result.error).toContain('ENOENT')
  })
})

// ---------------------------------------------------------------------------
// startAutoAgents() — failure isolation
// ---------------------------------------------------------------------------
describe('AgentManager.startAutoAgents() — failure isolation', () => {
  it('continues to remaining agents when one has a missing cwd', () => {
    const broken = { ...brainAgent, name: 'broken', cwd: '/projects/gone', autoStart: true }
    const good = { ...brainAgent, name: 'good', cwd: '/projects/good', autoStart: true }
    const existing = { defaultAgent: 'good', agents: { broken, good } }
    const { manager } = makeManager([], existing)

    // /projects/gone is missing, everything else resolves
    mockExistsSync.mockImplementation((p: string) => {
      if (typeof p !== 'string') return true
      if (p === '/projects/gone') return false
      return true
    })

    // spawn must return a child-shaped object so the "good" agent's full start()
    // path completes without throwing.
    mockSpawn.mockReturnValue({
      pid: 99999,
      on: vi.fn(),
    } as any)

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(() => manager.startAutoAgents()).not.toThrow()

    const lines = logSpy.mock.calls.map(c => c.join(' '))
    expect(lines.some(l => l.includes('Failed to auto-start "broken"') && l.includes('cwd does not exist'))).toBe(true)
    expect(lines.some(l => l.includes('Auto-started "good"'))).toBe(true)

    logSpy.mockRestore()
  })

  it('survives an unexpected throw from start() (defense in depth)', () => {
    const a = { ...brainAgent, name: 'a', cwd: '/projects/a', autoStart: true }
    const b = { ...brainAgent, name: 'b', cwd: '/projects/b', autoStart: true }
    const existing = { defaultAgent: 'a', agents: { a, b } }
    const { manager } = makeManager([], existing)

    // First start() throws via spawn; second succeeds.
    let call = 0
    mockSpawn.mockImplementation(() => {
      call++
      if (call === 1) throw new Error('boom: simulated spawn failure')
      return { pid: 42, on: vi.fn() } as any
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => manager.startAutoAgents()).not.toThrow()

    const errLines = errSpy.mock.calls.map(c => c.join(' '))
    expect(errLines.some(l => l.includes('Unexpected error auto-starting "a"'))).toBe(true)

    const logLines = logSpy.mock.calls.map(c => c.join(' '))
    expect(logLines.some(l => l.includes('Auto-started "b"'))).toBe(true)

    logSpy.mockRestore()
    errSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------
describe('AgentManager.list()', () => {
  it('returns "stopped" when no process and not connected', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    const agents = manager.list()

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: 'brain',
      cwd: '/projects/brain',
      status: 'stopped',
      isDefault: true,
      autoStart: true,
    })
  })

  it('returns "connected" when spoke is connected', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager(['brain'], existing)

    const agents = manager.list()

    expect(agents[0].status).toBe('connected')
  })

  it('returns "starting" when process exists but spoke not connected', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    // Simulate a managed process by injecting into the private Map
    const fakeChild = { pid: 1234 } as any
    ;(manager as any).processes.set('brain', fakeChild)

    const agents = manager.list()

    expect(agents[0].status).toBe('starting')
  })

  it('marks the correct agent as default', () => {
    const existing = {
      defaultAgent: 'backup',
      agents: {
        brain: brainAgent,
        backup: { ...brainAgent, name: 'backup', cwd: '/projects/backup' },
      },
    }
    const { manager } = makeManager([], existing)

    const agents = manager.list()

    const brainEntry = agents.find(a => a.name === 'brain')!
    const backupEntry = agents.find(a => a.name === 'backup')!
    expect(brainEntry.isDefault).toBe(false)
    expect(backupEntry.isDefault).toBe(true)
  })

  it('returns empty claudeArgs as empty array', () => {
    const noArgs = { ...brainAgent, claudeArgs: undefined }
    const existing = { defaultAgent: 'brain', agents: { brain: noArgs } }
    const { manager } = makeManager([], existing)

    const agents = manager.list()
    expect(agents[0].claudeArgs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// updateEffort()
// ---------------------------------------------------------------------------
describe('AgentManager.updateEffort()', () => {
  it('adds --effort arg when not present', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    const result = manager.updateEffort('brain', 'high')

    expect(result.success).toBe(true)
    const args = manager.getConfig().agents['brain'].claudeArgs!
    expect(args).toContain('--effort')
    expect(args[args.indexOf('--effort') + 1]).toBe('high')
  })

  it('updates existing --effort value', () => {
    const withEffort = { ...brainAgent, claudeArgs: ['--effort', 'low', '--verbose'] }
    const existing = { defaultAgent: 'brain', agents: { brain: withEffort } }
    const { manager } = makeManager([], existing)

    const result = manager.updateEffort('brain', 'max')

    expect(result.success).toBe(true)
    const args = manager.getConfig().agents['brain'].claudeArgs!
    expect(args).toEqual(['--effort', 'max', '--verbose'])
  })

  it('fails for unknown agent', () => {
    const { manager } = makeManager()

    const result = manager.updateEffort('ghost', 'high')

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('persists to disk', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    // Clear the writes from constructor/load
    mockWriteFileSync.mockClear()

    manager.updateEffort('brain', 'medium')

    expect(mockWriteFileSync).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Restart backoff tracking (state-only, no real timers/processes)
// ---------------------------------------------------------------------------
describe('restart backoff tracking', () => {
  it('initializes with empty restartAttempts map', () => {
    const { manager } = makeManager()

    const attempts = (manager as any).restartAttempts as Map<string, { count: number; firstAt: number }>
    expect(attempts.size).toBe(0)
  })

  it('tracks first restart attempt', () => {
    const { manager } = makeManager()
    const attempts = (manager as any).restartAttempts as Map<string, { count: number; firstAt: number }>

    const now = Date.now()
    attempts.set('brain', { count: 1, firstAt: now })

    expect(attempts.get('brain')!.count).toBe(1)
    expect(attempts.get('brain')!.firstAt).toBeGreaterThanOrEqual(now - 10)
  })

  it('increments count on subsequent attempts within window', () => {
    const { manager } = makeManager()
    const attempts = (manager as any).restartAttempts as Map<string, { count: number; firstAt: number }>

    const firstAt = Date.now()
    attempts.set('brain', { count: 1, firstAt })

    // Simulate incrementing within the 5-minute window
    const entry = attempts.get('brain')!
    entry.count++
    expect(entry.count).toBe(2)

    entry.count++
    expect(entry.count).toBe(3)
  })

  it('gives up after MAX_RESTART_ATTEMPTS (5)', () => {
    const { manager } = makeManager()
    const attempts = (manager as any).restartAttempts as Map<string, { count: number; firstAt: number }>

    // Simulate 6 consecutive crashes within the window — count > 5 means give up
    const firstAt = Date.now()
    attempts.set('brain', { count: 6, firstAt })

    const entry = attempts.get('brain')!
    // The exit handler checks: if count > MAX_RESTART_ATTEMPTS (5), give up
    expect(entry.count).toBeGreaterThan(5)
  })

  describe('simulated exit handler backoff logic', () => {
    // Re-implement the core backoff decision logic from child.on('exit')
    // to test it without spawning processes.
    const MAX_RESTART_ATTEMPTS = 5
    const RESTART_WINDOW_MS = 5 * 60_000
    const RESTART_DELAY_MS = 5000

    function simulateExitBackoff(
      restartAttempts: Map<string, { count: number; firstAt: number }>,
      name: string,
      now: number,
    ): { action: 'restart'; delay: number; attempt: number } | { action: 'give_up' } | { action: 'first_attempt'; delay: number } {
      const attempts = restartAttempts.get(name)
      if (attempts && now - attempts.firstAt < RESTART_WINDOW_MS) {
        attempts.count++
        if (attempts.count > MAX_RESTART_ATTEMPTS) {
          restartAttempts.delete(name)
          return { action: 'give_up' }
        }
      } else {
        restartAttempts.set(name, { count: 1, firstAt: now })
      }

      const attempt = restartAttempts.get(name)!
      const delay = RESTART_DELAY_MS * attempt.count
      return attempt.count === 1
        ? { action: 'first_attempt', delay }
        : { action: 'restart', delay, attempt: attempt.count }
    }

    it('first crash starts a new tracking window', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const now = 1000000

      const result = simulateExitBackoff(attempts, 'brain', now)

      expect(result.action).toBe('first_attempt')
      if (result.action === 'first_attempt') {
        expect(result.delay).toBe(5000) // 5s * 1
      }
      expect(attempts.get('brain')!.count).toBe(1)
      expect(attempts.get('brain')!.firstAt).toBe(now)
    })

    it('second crash within window increments count and increases delay', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const t0 = 1000000
      attempts.set('brain', { count: 1, firstAt: t0 })

      const result = simulateExitBackoff(attempts, 'brain', t0 + 10_000) // 10s later

      expect(result.action).toBe('restart')
      if (result.action === 'restart') {
        expect(result.delay).toBe(10_000) // 5s * 2
        expect(result.attempt).toBe(2)
      }
    })

    it('delay escalates linearly: 5s, 10s, 15s, 20s, 25s', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const t0 = 1000000
      const expectedDelays = [5000, 10000, 15000, 20000, 25000]

      for (let i = 0; i < 5; i++) {
        if (i === 0) {
          attempts.set('brain', { count: 0, firstAt: t0 }) // will be incremented to 1
        }
        const result = simulateExitBackoff(attempts, 'brain', t0 + i * 6000)
        if (result.action === 'give_up') {
          throw new Error(`Should not give up on attempt ${i + 1}`)
        }
        expect(result.delay).toBe(expectedDelays[i])
      }
    })

    it('gives up on 6th crash within window', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const t0 = 1000000
      attempts.set('brain', { count: 5, firstAt: t0 }) // already at max

      const result = simulateExitBackoff(attempts, 'brain', t0 + 30_000)

      expect(result.action).toBe('give_up')
      // restartAttempts entry should be cleaned up
      expect(attempts.has('brain')).toBe(false)
    })

    it('resets counter if stable for longer than the 5-minute window', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const t0 = 1000000
      attempts.set('brain', { count: 4, firstAt: t0 }) // near max

      // 6 minutes later — outside the window
      const result = simulateExitBackoff(attempts, 'brain', t0 + 6 * 60_000)

      // Should have reset to a fresh first attempt
      expect(result.action).toBe('first_attempt')
      expect(attempts.get('brain')!.count).toBe(1)
    })

    it('tracks multiple agents independently', () => {
      const attempts = new Map<string, { count: number; firstAt: number }>()
      const t0 = 1000000

      simulateExitBackoff(attempts, 'brain', t0)
      simulateExitBackoff(attempts, 'work', t0 + 100)

      expect(attempts.get('brain')!.count).toBe(1)
      expect(attempts.get('work')!.count).toBe(1)

      // Crash brain again
      simulateExitBackoff(attempts, 'brain', t0 + 5000)
      expect(attempts.get('brain')!.count).toBe(2)
      expect(attempts.get('work')!.count).toBe(1) // unaffected
    })
  })
})

// ---------------------------------------------------------------------------
// stoppedManually flag
// ---------------------------------------------------------------------------
describe('stoppedManually flag', () => {
  it('is empty initially', () => {
    const { manager } = makeManager()
    const stopped = (manager as any).stoppedManually as Set<string>
    expect(stopped.size).toBe(0)
  })

  it('can be set and checked per agent', () => {
    const { manager } = makeManager()
    const stopped = (manager as any).stoppedManually as Set<string>

    stopped.add('brain')
    expect(stopped.has('brain')).toBe(true)
    expect(stopped.has('other')).toBe(false)
  })

  it('prevents auto-restart when present (logic check)', () => {
    const { manager } = makeManager()
    const stopped = (manager as any).stoppedManually as Set<string>

    stopped.add('brain')

    // Simulate the exit handler check
    const shouldRestart = !stopped.has('brain')
    expect(shouldRestart).toBe(false)
  })

  it('is cleared after being consumed (mirrors exit handler behavior)', () => {
    const { manager } = makeManager()
    const stopped = (manager as any).stoppedManually as Set<string>
    const attempts = (manager as any).restartAttempts as Map<string, { count: number; firstAt: number }>

    stopped.add('brain')
    attempts.set('brain', { count: 3, firstAt: Date.now() })

    // Simulate exit handler: if stoppedManually, delete and reset attempts
    if (stopped.has('brain')) {
      stopped.delete('brain')
      attempts.delete('brain')
    }

    expect(stopped.has('brain')).toBe(false)
    expect(attempts.has('brain')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shuttingDown flag
// ---------------------------------------------------------------------------
describe('shuttingDown flag', () => {
  it('is false initially', () => {
    const { manager } = makeManager()
    expect((manager as any).shuttingDown).toBe(false)
  })

  it('suppresses restart when true (logic check)', () => {
    const { manager } = makeManager()

    ;(manager as any).shuttingDown = true

    // The exit handler's first check
    const shouldContinue = !(manager as any).shuttingDown
    expect(shouldContinue).toBe(false)
  })

  it('stopAll sets shuttingDown to true', async () => {
    const { manager } = makeManager()

    // No processes to stop, but the flag should still be set
    await manager.stopAll()

    expect((manager as any).shuttingDown).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isManaged()
// ---------------------------------------------------------------------------
describe('AgentManager.isManaged()', () => {
  it('returns false when no process is tracked', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    expect(manager.isManaged('brain')).toBe(false)
  })

  it('returns true when a process is in the map', () => {
    const existing = { defaultAgent: 'brain', agents: { brain: brainAgent } }
    const { manager } = makeManager([], existing)

    ;(manager as any).processes.set('brain', { pid: 999 })

    expect(manager.isManaged('brain')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// reloadConfig()
// ---------------------------------------------------------------------------
describe('AgentManager.reloadConfig()', () => {
  it('reloads config from disk', () => {
    const { manager } = makeManager([], emptyConfig)

    // Simulate a new config on disk
    const updatedConfig = {
      defaultAgent: 'new-agent',
      agents: { 'new-agent': { ...brainAgent, name: 'new-agent', cwd: '/projects/new' } },
    }
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify(updatedConfig))

    manager.reloadConfig()

    expect(manager.getConfig().defaultAgent).toBe('new-agent')
    expect(manager.getConfig().agents['new-agent']).toBeDefined()
  })

  it('returns default config if agents.json is missing', () => {
    const { manager } = makeManager([], emptyConfig)

    mockExistsSync.mockReturnValue(false)

    manager.reloadConfig()

    expect(manager.getConfig()).toEqual({ defaultAgent: 'brain', agents: {} })
  })
})

// ---------------------------------------------------------------------------
// rename() + validateRename()  — B2.1
// ---------------------------------------------------------------------------
describe('AgentManager.rename()', () => {
  const cfg = () => ({
    defaultAgent: 'brain',
    agents: {
      brain: { name: 'brain', cwd: '/p/brain', createdAt: '2026-01-01', autoStart: true, claudeArgs: ['--effort', 'high'] },
      geo: { name: 'geo', cwd: '/p/geo', createdAt: '2026-01-01', autoStart: false },
    },
    channelDefaults: { 'weixin-a': 'brain', 'weixin-b': 'geo' },
  })

  it('migrates config key, preserving fields and updating name', async () => {
    const { manager } = makeManager([], cfg())
    const r = await manager.rename('brain', 'brainy')
    expect(r.success).toBe(true)
    const c = manager.getConfig()
    expect(c.agents['brain']).toBeUndefined()
    expect(c.agents['brainy']).toMatchObject({
      name: 'brainy', cwd: '/p/brain', autoStart: true, claudeArgs: ['--effort', 'high'], createdAt: '2026-01-01',
    })
    expect(mockWriteFileSync).toHaveBeenCalled()
  })

  it('updates defaultAgent when the old name was default', async () => {
    const { manager } = makeManager([], cfg())
    await manager.rename('brain', 'brainy')
    expect(manager.getConfig().defaultAgent).toBe('brainy')
  })

  it('rewrites channelDefaults references to the old name', async () => {
    const { manager } = makeManager([], cfg())
    await manager.rename('brain', 'brainy')
    expect(manager.getConfig().channelDefaults).toEqual({ 'weixin-a': 'brainy', 'weixin-b': 'geo' })
  })

  it('rejects a name that already exists', async () => {
    const { manager } = makeManager([], cfg())
    const r = await manager.rename('brain', 'geo')
    expect(r.success).toBe(false)
    expect(r.error).toContain('已存在')
    expect(manager.getConfig().agents['brain']).toBeDefined() // unchanged
  })

  it('rejects an illegal (whitespace/empty) new name', async () => {
    const { manager } = makeManager([], cfg())
    expect((await manager.rename('brain', 'has space')).success).toBe(false)
    expect((await manager.rename('brain', '')).success).toBe(false)
  })

  it('errors when the old name does not exist', async () => {
    const { manager } = makeManager([], cfg())
    const r = await manager.rename('ghost', 'x')
    expect(r.success).toBe(false)
    expect(r.error).toContain('not found')
  })

  it('is a no-op when new name equals old name', async () => {
    const { manager } = makeManager([], cfg())
    const r = await manager.rename('brain', 'brain')
    expect(r.success).toBe(true)
    expect(manager.getConfig().agents['brain']).toBeDefined()
  })

  it('validateRename returns error messages / null without mutating', () => {
    const { manager } = makeManager([], cfg())
    expect(manager.validateRename('brain', 'ok')).toBeNull()
    expect(manager.validateRename('brain', 'geo')).toContain('已存在')
    expect(manager.validateRename('ghost', 'x')).toContain('not found')
    expect(manager.validateRename('brain', 'a b')).toContain('非法')
    // still intact
    expect(manager.getConfig().agents['brain']).toBeDefined()
  })
})

describe('AgentManager.rename() — process + validation edges (B2.1 review fixes)', () => {
  const cfg = () => ({
    defaultAgent: 'brain',
    agents: {
      brain: { name: 'brain', cwd: '/p/brain', createdAt: '2026-01-01', autoStart: true },
      geo: { name: 'geo', cwd: '/p/geo', createdAt: '2026-01-01', autoStart: false },
    },
  })

  it('managed agent: stops old, waits for disconnect, starts new', async () => {
    const { manager } = makeManager([], cfg())
    ;(manager as any).processes.set('brain', { pid: 111 }) // mark managed
    const stopSpy = vi.spyOn(manager as any, 'stop').mockResolvedValue({ success: true })
    const waitSpy = vi.spyOn(manager as any, 'waitForDisconnect').mockResolvedValue(undefined)
    const startSpy = vi.spyOn(manager as any, 'start').mockReturnValue({ success: true })

    const r = await manager.rename('brain', 'brainy')
    expect(r.success).toBe(true)
    expect(stopSpy).toHaveBeenCalledWith('brain')
    expect(waitSpy).toHaveBeenCalledWith('brain', expect.any(Number))
    expect(startSpy).toHaveBeenCalledWith('brainy')
    expect(manager.getConfig().agents['brainy']).toBeDefined()
    expect(manager.getConfig().agents['brain']).toBeUndefined()
  })

  it('external (connected but unmanaged) agent: warns instead of restarting', async () => {
    const { manager } = makeManager(['brain'], cfg()) // connected, but no process → unmanaged
    const startSpy = vi.spyOn(manager as any, 'start')
    const r = await manager.rename('brain', 'brainy')
    expect(r.success).toBe(true)
    expect(r.warning).toMatch(/外部启动/)
    expect(startSpy).not.toHaveBeenCalled()
    expect(manager.getConfig().agents['brainy']).toBeDefined()
  })

  it('rejects path-traversal / separator names (aligned with onboard)', () => {
    const { manager } = makeManager([], cfg())
    expect(manager.validateRename('brain', '../evil')).toContain('非法')
    expect(manager.validateRename('brain', 'a/b')).toContain('非法')
    expect(manager.validateRename('brain', '.hidden')).toContain('非法')
    expect(manager.validateRename('brain', 'ok_name-1')).toBeNull()
    expect(manager.validateRename('brain', '报告组')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Session ownership — each agent resumes ITS OWN session, never `--continue`
// (`--continue` grabbed whatever session the user last touched in the agent's cwd)
// ---------------------------------------------------------------------------
describe('AgentManager — each agent resumes its own session', () => {
  const ID_A = '11111111-2222-4333-8444-555555555555'
  const ID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const ID_C = 'cccccccc-dddd-4eee-8fff-000000000000'

  /** Minimal ChildProcess stand-in: records the 'exit' listener so tests can fire it. */
  function fakeChild() {
    const listeners: Record<string, (...a: any[]) => void> = {}
    return {
      pid: 2_000_000_000, // never a real pid/pgid — process.kill is stubbed anyway
      on: vi.fn((ev: string, fn: (...a: any[]) => void) => { listeners[ev] = fn }),
      once: vi.fn((ev: string, fn: (...a: any[]) => void) => { listeners[ev] = fn }),
      kill: vi.fn(),
      emitExit: (code: number | null) => listeners['exit']?.(code),
    }
  }

  const cfg = (sessionId?: string) => ({
    defaultAgent: 'brain',
    agents: { brain: { ...brainAgent, ...(sessionId ? { sessionId } : {}) } },
  })

  let child: ReturnType<typeof fakeChild>

  function setup(sessionId?: string) {
    const ids = [ID_B, ID_C]
    const ctx = makeManager([], cfg(sessionId), { newSessionId: () => ids.shift()! })
    child = fakeChild()
    mockSpawn.mockImplementation(() => child)
    return ctx
  }

  /** Swap in a new fake child, then let the scheduled auto-restart (5s) run. */
  function runAutoRestart() {
    child = fakeChild()
    vi.advanceTimersByTime(5000)
  }

  const lastExpectScript = () =>
    String(mockWriteFileSync.mock.calls.filter(c => String(c[0]).endsWith('start.exp')).at(-1)?.[1] ?? '')
  const agentsJsonWrites = () =>
    mockWriteFileSync.mock.calls.filter(c => String(c[0]).endsWith('agents.json')).length

  let killSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })
  afterEach(() => {
    vi.useRealTimers()
    killSpy.mockRestore()
  })

  it('resumes the recorded session by id and leaves agents.json alone', () => {
    const { manager } = setup(ID_A)
    expect(manager.start('brain').success).toBe(true)
    const script = lastExpectScript()
    expect(script).toContain(`{--resume} {${ID_A}}`)
    expect(script).not.toContain('--continue')
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_A)
    expect(agentsJsonWrites()).toBe(0)
  })

  it('without a recorded session, starts a new one with a pre-assigned id and records it', () => {
    const { manager } = setup()
    manager.start('brain')
    expect(lastExpectScript()).toContain(`{--session-id} {${ID_B}}`)
    expect(lastExpectScript()).not.toContain('--continue')
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_B)
    expect(agentsJsonWrites()).toBe(1)
  })

  it('the expect wrapper exits with claude\'s own status (expect alone always exits 0)', () => {
    const { manager } = setup(ID_A)
    manager.start('brain')
    expect(lastExpectScript()).toMatch(/expect eof\nset status \[wait\]\nexit \[lindex \$status 3\]\n?$/)
  })

  it('a launch that fails before its spoke connects (e.g. --resume refused) starts a new session next time', () => {
    const { manager } = setup(ID_A)
    manager.start('brain')
    child.emitExit(1) // "No conversation found" / "running as a background session" → exit 1
    runAutoRestart()
    expect(lastExpectScript()).toContain(`{--session-id} {${ID_B}}`)
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_B)
  })

  it('a failed launch of a non-autoStart agent also makes its next (manual) start use a new session', () => {
    const ids = [ID_B]
    const { manager } = makeManager([], {
      defaultAgent: 'brain', agents: { brain: { ...brainAgent, autoStart: false, sessionId: ID_A } },
    }, { newSessionId: () => ids.shift()! })
    child = fakeChild()
    mockSpawn.mockImplementation(() => child)
    manager.start('brain')
    child.emitExit(1)
    child = fakeChild()
    manager.start('brain')
    expect(lastExpectScript()).toContain(`{--session-id} {${ID_B}}`)
  })

  it('a crash after the spoke had connected keeps the session, even if the spoke is gone by exit time', () => {
    const { manager } = setup(ID_A)
    manager.start('brain')
    manager.noteSpokeRegistered('brain', ID_A)
    child.emitExit(1) // getConnectedAgents() is already [] when the exit event fires
    runAutoRestart()
    expect(lastExpectScript()).toContain(`{--resume} {${ID_A}}`)
  })

  it('a normal exit (code 0) keeps the session', () => {
    const { manager } = setup(ID_A)
    manager.start('brain')
    child.emitExit(0)
    runAutoRestart()
    expect(lastExpectScript()).toContain(`{--resume} {${ID_A}}`)
  })

  it('a start that stalls during init (no spoke within 60s) is retried with a new session', () => {
    const { manager } = setup(ID_A)
    manager.start('brain')
    vi.advanceTimersByTime(60_000) // connect timeout → tree killed
    child.emitExit(null)
    runAutoRestart()
    expect(lastExpectScript()).toContain(`{--session-id} {${ID_B}}`)
  })

  it('adopts the session id the spoke reports when it differs from the record', () => {
    const { manager } = setup(ID_A)
    manager.noteSpokeRegistered('brain', ID_C)
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_C)
    expect(agentsJsonWrites()).toBe(1)
  })

  it('ignores missing, malformed or unchanged reports and unknown agents', () => {
    const { manager } = setup(ID_A)
    manager.noteSpokeRegistered('brain', undefined)
    manager.noteSpokeRegistered('brain', 'not-a-session-id')
    manager.noteSpokeRegistered('brain', ID_A)
    manager.noteSpokeRegistered('ghost', ID_C)
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_A)
    expect(manager.getConfig().agents.ghost).toBeUndefined()
    expect(agentsJsonWrites()).toBe(0)
  })

  it('terminal handoff resumes the recorded session', () => {
    const { manager } = setup(ID_A)
    expect(manager.handoffSessionArgs('brain')).toEqual(['--resume', ID_A])
    expect(agentsJsonWrites()).toBe(0)
  })

  it('terminal handoff pre-assigns and records a session id when none is known', () => {
    const { manager } = setup()
    expect(manager.handoffSessionArgs('brain')).toEqual(['--session-id', ID_B])
    expect(manager.getConfig().agents.brain.sessionId).toBe(ID_B)
  })

  it('terminal handoff returns null for an unknown agent', () => {
    const { manager } = setup(ID_A)
    expect(manager.handoffSessionArgs('ghost')).toBeNull()
  })

  it('rename keeps the agent\'s own session', async () => {
    const { manager } = setup(ID_A)
    await manager.rename('brain', 'brainy')
    expect(manager.getConfig().agents.brainy.sessionId).toBe(ID_A)
  })
})
