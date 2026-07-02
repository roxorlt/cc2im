/**
 * B2.4 one-click handoff — open-terminal primitives + handoff API.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { shellQuote, buildTerminalScript, resolveTerminalApp, openInTerminal, handoffCommand } from '../shared/open-terminal.js'

describe('open-terminal primitives', () => {
  it('shellQuote wraps and escapes single quotes', () => {
    expect(shellQuote('/a/b')).toBe(`'/a/b'`)
    expect(shellQuote('/a b/c')).toBe(`'/a b/c'`)
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote('/项目/foo')).toBe(`'/项目/foo'`)
  })

  it('buildTerminalScript cds then runs, quoting cwd', () => {
    const s = buildTerminalScript('/a b/proj', 'claude --continue')
    expect(s).toBe(`#!/bin/zsh\ncd '/a b/proj' && claude --continue\n`)
  })

  it('resolveTerminalApp prefers Ghostty when present', () => {
    expect(resolveTerminalApp(true)).toBe('Ghostty')
    expect(resolveTerminalApp(false)).toBe('Terminal')
  })

  it('openInTerminal writes a script and spawns open -a with injected deps', () => {
    const spawnFn = vi.fn(() => ({ unref: vi.fn() })) as any
    const writeScript = vi.fn(() => '/tmp/handoff.command')
    const res = openInTerminal('/proj', 'claude --continue', {
      ghosttyInstalled: () => true, spawnFn, writeScript,
    })
    expect(res).toMatchObject({ ok: true, app: 'Ghostty', scriptPath: '/tmp/handoff.command' })
    expect(writeScript).toHaveBeenCalledWith(`#!/bin/zsh\ncd '/proj' && claude --continue\n`)
    expect(spawnFn).toHaveBeenCalledWith('open', ['-a', 'Ghostty', '/tmp/handoff.command'], expect.objectContaining({ detached: true }))
  })

  it('openInTerminal falls back to Terminal without Ghostty', () => {
    const res = openInTerminal('/p', 'x', { ghosttyInstalled: () => false, spawnFn: (() => ({ unref() {} })) as any, writeScript: () => '/s' })
    expect(res.app).toBe('Terminal')
  })

  it('openInTerminal reports spawn failure', () => {
    const res = openInTerminal('/p', 'x', {
      ghosttyInstalled: () => true,
      spawnFn: (() => { throw new Error('boom') }) as any,
      writeScript: () => '/s',
    })
    expect(res).toMatchObject({ ok: false, error: 'boom' })
  })

  it('handoffCommand carries --continue + channel + flags', () => {
    expect(handoffCommand()).toContain('claude --continue')
    expect(handoffCommand()).toContain('server:cc2im')
  })
})

// --- handoff API ---
vi.mock('../plugins/persistence/db.js', () => ({ getNicknames: vi.fn(() => []), setNickname: vi.fn() }))
vi.mock('../plugins/cron-scheduler/db.js', () => ({
  listJobs: vi.fn(() => []), createJob: vi.fn(), deleteJob: vi.fn(), updateJob: vi.fn(), getRecentRuns: vi.fn(() => []),
}))
vi.mock('../plugins/cron-scheduler/scheduler.js', () => ({ CronScheduler: vi.fn().mockImplementation(() => ({ calcNextRun: vi.fn() })) }))
vi.mock('../plugins/web-monitor/token-stats.js', () => ({ getTokenStats: vi.fn(() => ({})) }))
vi.mock('../plugins/web-monitor/usage-stats.js', () => ({ getUsageStats: vi.fn(() => ({})) }))
vi.mock('../plugins/web-monitor/stats-reader.js', () => ({ readStats: vi.fn(() => ({})) }))
vi.mock('../plugins/weixin/qr-login.js', () => ({ fetchQrCode: vi.fn(), checkQrStatus: vi.fn(), saveCredentials: vi.fn(), POLL_INTERVAL: 2000 }))

import { createApiHandler } from '../plugins/web-monitor/server.js'
import type { HubContext } from '../shared/plugin.js'

function getPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

describe('POST /api/agents/:name/handoff', () => {
  let server: Server
  let baseUrl: string
  let tmpDir: string
  const stop = vi.fn(async () => ({ success: true }))
  const openTerminalFn = vi.fn(() => ({ ok: true as const, app: 'Ghostty', scriptPath: '/s', command: 'claude' }))

  const ctx = {
    getAgentManager: () => ({ isManaged: (n: string) => n === 'brain', stop }),
  } as unknown as HubContext

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cc2im-handoff-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'agents.json'), JSON.stringify({
      defaultAgent: 'brain',
      agents: { brain: { name: 'brain', cwd: '/Users/x/brain', autoStart: true, createdAt: '2026-01-01' } },
    }))
    const handler = createApiHandler({
      agentsJsonPath: join(tmpDir, 'agents.json'), mediaDir: tmpDir, messageHistory: [],
      monitor: { isConnected: () => true }, wsClients: { size: 0 }, ctx,
      activeQrPolls: new Map(), broadcastWs: vi.fn(), openTerminalFn,
    })
    server = createServer(handler)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${getPort(server)}`
  })
  afterAll(() => { server.close(); try { rmSync(tmpDir, { recursive: true }) } catch {} })

  it('stops the managed agent and opens a terminal at its cwd', async () => {
    const res = await fetch(`${baseUrl}/api/agents/brain/handoff`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, stopped: true, app: 'Ghostty', cwd: '/Users/x/brain' })
    expect(stop).toHaveBeenCalledWith('brain')
    expect(openTerminalFn).toHaveBeenCalledWith('/Users/x/brain', expect.stringContaining('claude --continue'))
  })

  it('404 for unknown agent', async () => {
    expect((await fetch(`${baseUrl}/api/agents/ghost/handoff`, { method: 'POST' })).status).toBe(404)
  })

  it('returns 500 when opening the terminal fails', async () => {
    openTerminalFn.mockReturnValueOnce({ ok: false as any, error: 'no display' } as any)
    const res = await fetch(`${baseUrl}/api/agents/brain/handoff`, { method: 'POST' })
    expect(res.status).toBe(500)
    const data = await res.json()
    expect(data).toMatchObject({ error: 'no display' })
    expect(data).toHaveProperty('stopped')
  })

  it('refuses cross-site handoff (CSRF guard)', async () => {
    const res = await fetch(`${baseUrl}/api/agents/brain/handoff`, {
      method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' },
    })
    expect(res.status).toBe(403)
  })
})
