/**
 * B2.3 onboard wizard — POST /api/onboard registers a directory as an agent.
 * Uses the real createApiHandler with a mock ctx whose AgentManager records calls.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

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

describe('POST /api/onboard', () => {
  let server: Server
  let baseUrl: string
  let tmpDir: string
  let realDir: string

  const calls = { register: [] as any[], writeMcpJson: [] as string[], start: [] as string[] }
  const mgr = {
    register: vi.fn((name: string, cwd: string, _args?: string[], autoStart?: boolean) => {
      if (name === 'dupe') return { success: false, error: 'already exists' }
      calls.register.push({ name, cwd, autoStart }); return { success: true }
    }),
    writeMcpJson: vi.fn((name: string) => { calls.writeMcpJson.push(name); return { success: true } }),
    start: vi.fn((name: string) => { calls.start.push(name); return { success: true } }),
    getConfig: vi.fn(() => ({ defaultAgent: 'brain', agents: {} })),
  }
  const ctx = {
    getAgentManager: () => mgr,
    getRouter: () => ({ updateConfig: vi.fn() }),
    broadcastMonitor: vi.fn(),
    getChannels: () => [],
    getChannel: () => undefined,
  } as unknown as HubContext

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cc2im-onboard-${randomUUID()}`)
    realDir = join(tmpDir, 'proj')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(tmpDir, 'agents.json'), JSON.stringify({ defaultAgent: 'brain', agents: {} }))
    const handler = createApiHandler({
      agentsJsonPath: join(tmpDir, 'agents.json'), mediaDir: tmpDir, messageHistory: [],
      monitor: { isConnected: () => true }, wsClients: { size: 0 }, ctx,
      activeQrPolls: new Map(), broadcastWs: vi.fn(),
    })
    server = createServer(handler)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    baseUrl = `http://127.0.0.1:${getPort(server)}`
  })
  afterAll(() => { server.close(); try { rmSync(tmpDir, { recursive: true }) } catch {} })

  const post = (body: any) => fetch(`${baseUrl}/api/onboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  it('registers + writes .mcp.json for a valid directory (no start by default)', async () => {
    const res = await post({ name: 'proj', cwd: realDir })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data).toMatchObject({ ok: true, registered: true, started: false })
    expect(calls.register.at(-1)).toEqual({ name: 'proj', cwd: realDir, autoStart: true })
    expect(calls.writeMcpJson.at(-1)).toBe('proj')
    expect(calls.start).not.toContain('proj')
  })

  it('startNow=true also starts the agent', async () => {
    const res = await post({ name: 'proj2', cwd: realDir, startNow: true, autoStart: false })
    expect(res.status).toBe(201)
    expect((await res.json()).started).toBe(true)
    expect(calls.register.at(-1)).toEqual({ name: 'proj2', cwd: realDir, autoStart: false })
    expect(calls.start.at(-1)).toBe('proj2')
  })

  it('rejects relative path', async () => {
    expect((await post({ name: 'x', cwd: 'relative/path' })).status).toBe(400)
  })

  it('rejects non-existent directory', async () => {
    expect((await post({ name: 'x', cwd: join(tmpDir, 'nope') })).status).toBe(400)
  })

  it('rejects illegal agent name', async () => {
    expect((await post({ name: 'bad name!', cwd: realDir })).status).toBe(400)
    expect((await post({ name: '', cwd: realDir })).status).toBe(400)
  })

  it('rejects cwd with control characters', async () => {
    expect((await post({ name: 'x', cwd: realDir + '\n/etc' })).status).toBe(400)
  })

  it('returns 409 when register reports a duplicate', async () => {
    expect((await post({ name: 'dupe', cwd: realDir })).status).toBe(409)
  })

  it('accepts Chinese agent names', async () => {
    const res = await post({ name: '报告组', cwd: realDir })
    expect(res.status).toBe(201)
  })
})
