/**
 * B3.1 channel health — counter logic, WeixinChannel aggregation,
 * pure formatters, and the health API endpoints.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createServer, Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// --- pure formatters (no mocks needed) ---
import { relativeTime, uptimeLabel, healthLevel } from '../plugins/web-monitor/frontend-v2/lib/health-format.js'

describe('health-format', () => {
  const now = Date.parse('2026-07-02T12:00:00Z')

  it('relativeTime buckets', () => {
    expect(relativeTime(undefined, now)).toBe('—')
    expect(relativeTime('2026-07-02T11:59:58Z', now)).toBe('刚刚')
    expect(relativeTime('2026-07-02T11:59:30Z', now)).toBe('30s 前')
    expect(relativeTime('2026-07-02T11:57:00Z', now)).toBe('3m 前')
    expect(relativeTime('2026-07-02T09:00:00Z', now)).toBe('3h 前')
    expect(relativeTime('2026-06-30T12:00:00Z', now)).toBe('2d 前')
    expect(relativeTime('not-a-date', now)).toBe('—')
  })

  it('uptimeLabel', () => {
    expect(uptimeLabel(undefined, now)).toBe('—')
    expect(uptimeLabel('2026-07-02T11:59:20Z', now)).toBe('40s')
    expect(uptimeLabel('2026-07-02T11:57:20Z', now)).toBe('2m 40s')
    expect(uptimeLabel('2026-07-02T09:47:00Z', now)).toBe('2h 13m')
  })

  it('healthLevel traffic light', () => {
    expect(healthLevel({ status: 'connected', consecutiveErrors: 0, stallCount: 0 })).toBe('ok')
    expect(healthLevel({ status: 'connected', consecutiveErrors: 3, stallCount: 0 })).toBe('warn')
    expect(healthLevel({ status: 'connected', consecutiveErrors: 0, stallCount: 1 })).toBe('warn')
    expect(healthLevel({ status: 'expired', consecutiveErrors: 0, stallCount: 0 })).toBe('bad')
    expect(healthLevel({ status: 'disconnected', consecutiveErrors: 0, stallCount: 0 })).toBe('bad')
  })
})

// --- WeixinConnection counter logic (mock the SDK, drive the real class) ---
vi.mock('@pinixai/weixin-bot', () => ({
  WeixinBot: vi.fn().mockImplementation(function (this: any) {
    this.onMessage = vi.fn()
    this.run = vi.fn()
    this.stop = vi.fn()
  }),
}))

import { WeixinConnection } from '../plugins/weixin/connection.js'

describe('WeixinConnection health counters', () => {
  it('tracks consecutive/total errors and stall threshold', () => {
    const conn = new WeixinConnection('test') as any
    const stalled = vi.fn()
    conn.onStalled(stalled)

    expect(conn.getHealthSnapshot()).toMatchObject({ consecutiveErrors: 0, totalErrors: 0, stallCount: 0 })

    for (let i = 0; i < 4; i++) conn.handlePollError(new Error('poll'))
    expect(conn.getHealthSnapshot()).toMatchObject({ consecutiveErrors: 4, totalErrors: 4, stallCount: 0 })
    expect(stalled).not.toHaveBeenCalled()

    // 5th error hits STALL_THRESHOLD → stall fires, consecutive resets, total keeps climbing
    conn.handlePollError(new Error('poll'))
    expect(stalled).toHaveBeenCalledOnce()
    expect(conn.getHealthSnapshot()).toMatchObject({ consecutiveErrors: 0, totalErrors: 5, stallCount: 1 })
  })
})

// --- WeixinChannel aggregation ---
describe('WeixinChannel.getHealth', () => {
  it('combines connection snapshot + status + reconnectCount', async () => {
    const { WeixinChannel } = await import('../plugins/weixin/weixin-channel.js')
    const ch = new WeixinChannel('weixin-x', 'X') as any
    // Inject a fake connection snapshot
    ch.weixin = { getHealthSnapshot: () => ({
      consecutiveErrors: 2, totalErrors: 9, stallCount: 1,
      lastReceiveAt: '2026-07-02T11:00:00Z', lastSendAt: '2026-07-02T11:01:00Z',
      connectedSince: '2026-07-02T10:00:00Z',
    }) }
    ch.status = 'connected'
    ch.setReconnectCount(3)

    const h = ch.getHealth()
    expect(h).toEqual({
      status: 'connected',
      consecutiveErrors: 2, totalErrors: 9, stallCount: 1, reconnectCount: 3,
      lastReceiveAt: '2026-07-02T11:00:00Z', lastSendAt: '2026-07-02T11:01:00Z',
      connectedSince: '2026-07-02T10:00:00Z',
    })
  })
})

// --- health API endpoints ---
vi.mock('../plugins/persistence/db.js', () => ({ getNicknames: vi.fn(() => []), setNickname: vi.fn() }))
vi.mock('../plugins/cron-scheduler/db.js', () => ({
  listJobs: vi.fn(() => []), createJob: vi.fn(), deleteJob: vi.fn(), updateJob: vi.fn(), getRecentRuns: vi.fn(() => []),
}))
vi.mock('../plugins/cron-scheduler/scheduler.js', () => ({ CronScheduler: vi.fn().mockImplementation(() => ({ calcNextRun: vi.fn() })) }))
vi.mock('../plugins/web-monitor/token-stats.js', () => ({ getTokenStats: vi.fn(() => ({})) }))
vi.mock('../plugins/web-monitor/usage-stats.js', () => ({ getUsageStats: vi.fn(() => ({})) }))
vi.mock('../plugins/web-monitor/stats-reader.js', () => ({ readStats: vi.fn(() => ({})) }))
vi.mock('../plugins/weixin/qr-login.js', () => ({
  fetchQrCode: vi.fn(), checkQrStatus: vi.fn(), saveCredentials: vi.fn(), POLL_INTERVAL: 2000,
  // connection.ts imports these at module load — mock is hoisted above that import
  loadCredentials: vi.fn(() => null), CRED_PATH: '/tmp/cc2im-test-cred.json', CRED_DIR: '/tmp/cc2im-test-creds',
}))

import { createApiHandler } from '../plugins/web-monitor/server.js'
import type { HubContext } from '../shared/plugin.js'

function getPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

describe('channel health API', () => {
  let server: Server
  let baseUrl: string
  let tmpDir: string

  const healthObj = {
    status: 'connected', consecutiveErrors: 0, totalErrors: 2, stallCount: 0,
    reconnectCount: 1, lastReceiveAt: '2026-07-02T11:00:00Z',
  }
  const withHealth = { id: 'weixin-a', type: 'weixin', label: 'A', getStatus: () => 'connected', getHealth: () => healthObj }
  const noHealth = { id: 'web', type: 'web', label: 'Web', getStatus: () => 'connected' } // no getHealth

  const ctx = {
    getChannels: () => [withHealth, noHealth],
    getChannel: (id: string) => (id === 'weixin-a' ? withHealth : id === 'web' ? noHealth : undefined),
  } as unknown as HubContext

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cc2im-health-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
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

  it('GET /api/channels includes health (null when unsupported)', async () => {
    const list = await (await fetch(`${baseUrl}/api/channels`)).json()
    expect(list.find((c: any) => c.id === 'weixin-a').health).toEqual(healthObj)
    expect(list.find((c: any) => c.id === 'web').health).toBeNull()
  })

  it('GET /api/channels/:id/health returns the snapshot', async () => {
    expect(await (await fetch(`${baseUrl}/api/channels/weixin-a/health`)).json()).toEqual(healthObj)
  })

  it('GET /api/channels/:id/health returns null for channel without getHealth', async () => {
    expect(await (await fetch(`${baseUrl}/api/channels/web/health`)).json()).toBeNull()
  })

  it('GET /api/channels/:id/health 404 for unknown channel', async () => {
    expect((await fetch(`${baseUrl}/api/channels/nope/health`)).status).toBe(404)
  })
})
