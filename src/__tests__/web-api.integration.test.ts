/**
 * Integration: Web Monitor HTTP API
 *
 * Tests the REAL createApiHandler from server.ts with mock dependencies.
 * Starts a real HTTP server using the production handler, hits API endpoints,
 * verifies responses.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, Server } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// --- Mock heavy dependencies that require SQLite or network ---

vi.mock('../plugins/persistence/db.js', () => ({
  getNicknames: vi.fn(() => []),
  setNickname: vi.fn(),
}))

vi.mock('../plugins/cron-scheduler/db.js', () => ({
  listJobs: vi.fn(() => []),
  createJob: vi.fn((input: any) => ({ id: 'mock-job-id', ...input })),
  deleteJob: vi.fn(() => false),
  updateJob: vi.fn(() => false),
  getRecentRuns: vi.fn(() => []),
}))

// CronScheduler imports cron-scheduler/db at module level, mock it too
vi.mock('../plugins/cron-scheduler/scheduler.js', () => ({
  CronScheduler: vi.fn().mockImplementation(() => ({
    calcNextRun: vi.fn(() => new Date(Date.now() + 86400000).toISOString()),
  })),
}))

vi.mock('../plugins/web-monitor/token-stats.js', () => ({
  getTokenStats: vi.fn(() => ({ daily: [], summary: {} })),
}))

vi.mock('../plugins/web-monitor/usage-stats.js', () => ({
  getUsageStats: vi.fn(() => ({ lastUpdated: '' })),
}))

vi.mock('../plugins/web-monitor/stats-reader.js', () => ({
  readStats: vi.fn(() => ({})),
}))

vi.mock('../plugins/weixin/qr-login.js', () => ({
  fetchQrCode: vi.fn(),
  checkQrStatus: vi.fn(),
  saveCredentials: vi.fn(),
  POLL_INTERVAL: 2000,
}))

// --- Import the real handler factory (after mocks are registered) ---

import { createApiHandler } from '../plugins/web-monitor/server.js'
import { listJobs, updateJob } from '../plugins/cron-scheduler/db.js'
import type { HubContext } from '../shared/plugin.js'
import type { Cc2imChannel, ChannelStatus } from '../shared/channel.js'

// --- Helpers ---

function getPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

/** Create a minimal mock Cc2imChannel */
function mockChannel(id: string, type: string, label: string, status: ChannelStatus = 'connected'): Cc2imChannel {
  let _status = status
  return {
    id,
    type: type as any,
    label,
    getStatus: () => _status,
    connect: vi.fn(async () => { _status = 'connected' }),
    disconnect: vi.fn(async () => { _status = 'disconnected' }),
    sendText: vi.fn(),
    sendFile: vi.fn(),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
    onMessage: vi.fn(),
    onStatusChange: vi.fn(),
  }
}

describe('Web API (integration)', () => {
  let server: Server
  let baseUrl: string
  let mediaDir: string
  let agentsJsonPath: string
  let tmpDir: string

  const testMessages = [
    { event: { kind: 'message_in', agentId: 'brain', text: 'hello', timestamp: '2026-03-27T10:00:00Z' }, receivedAt: '2026-03-27T10:00:00Z' },
    { event: { kind: 'message_out', agentId: 'brain', text: 'hi there', timestamp: '2026-03-27T10:00:01Z' }, receivedAt: '2026-03-27T10:00:01Z' },
    { event: { kind: 'message_in', agentId: 'demo', text: 'test', timestamp: '2026-03-27T10:01:00Z' }, receivedAt: '2026-03-27T10:01:00Z' },
  ]

  const testAgentsConfig = {
    defaultAgent: 'brain',
    agents: {
      brain: { name: 'brain', cwd: '/tmp/brain', autoStart: true, createdAt: '2026-01-01' },
      demo: { name: 'demo', cwd: '/tmp/demo', autoStart: false, createdAt: '2026-01-01' },
    },
  }

  const testChannel = mockChannel('weixin-roxor', 'weixin', 'roxor', 'connected')

  const mockCtx = {
    getChannels: vi.fn(() => [testChannel]),
    getChannel: vi.fn((id: string) => id === 'weixin-roxor' ? testChannel : undefined),
    addChannel: vi.fn(),
    removeChannel: vi.fn(),
    reconnectChannel: vi.fn(),
  } as unknown as HubContext

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cc2im-test-${randomUUID()}`)
    mediaDir = join(tmpDir, 'media')
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'test.jpg'), Buffer.from('fake-image-data'))

    agentsJsonPath = join(tmpDir, 'agents.json')
    writeFileSync(agentsJsonPath, JSON.stringify(testAgentsConfig))

    const handler = createApiHandler({
      agentsJsonPath,
      mediaDir,
      messageHistory: testMessages as any,
      monitor: { isConnected: () => false },
      wsClients: { size: 0 },
      ctx: mockCtx,
      activeQrPolls: new Map(),
      broadcastWs: vi.fn(),
      // No frontendDir — unknown routes return 404
    })

    server = createServer(handler)

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${getPort(server)}`
  })

  afterAll(() => {
    server.close()
    try { rmSync(tmpDir, { recursive: true }) } catch {}
  })

  // --- /api/health ---

  it('GET /api/health returns JSON with expected fields', async () => {
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveProperty('hubConnected')
    expect(data).toHaveProperty('uptime')
    expect(data).toHaveProperty('wsClients')
  })

  // --- /api/agents ---

  it('GET /api/agents returns agent config', async () => {
    const res = await fetch(`${baseUrl}/api/agents`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.defaultAgent).toBe('brain')
    expect(Object.keys(data.agents)).toEqual(['brain', 'demo'])
    expect(data.agents.brain.cwd).toBe('/tmp/brain')
  })

  // --- /api/messages ---

  it('GET /api/messages returns all messages', async () => {
    const res = await fetch(`${baseUrl}/api/messages`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(3)
  })

  it('GET /api/messages?agent=brain filters by agentId', async () => {
    const res = await fetch(`${baseUrl}/api/messages?agent=brain`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(2)
    expect(data.every((m: any) => m.event.agentId === 'brain')).toBe(true)
  })

  it('GET /api/messages?agent=nonexistent returns empty array', async () => {
    const res = await fetch(`${baseUrl}/api/messages?agent=nonexistent`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(0)
  })

  // --- /api/channels ---

  it('GET /api/channels returns channel list', async () => {
    const res = await fetch(`${baseUrl}/api/channels`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe('weixin-roxor')
    expect(data[0].status).toBe('connected')
  })

  // --- /media/ path traversal protection ---

  it('GET /media/test.jpg serves existing file', async () => {
    const res = await fetch(`${baseUrl}/media/test.jpg`)
    expect(res.status).toBe(200)
  })

  it('GET /media/nonexistent.jpg returns 404', async () => {
    const res = await fetch(`${baseUrl}/media/nonexistent.jpg`)
    expect(res.status).toBe(404)
  })

  it('GET /media/../etc/passwd — URL-encoded slashes stay literal, file not found', async () => {
    // %2F stays encoded in pathname — resolve() treats "..%2Fetc%2Fpasswd"
    // as a literal filename inside mediaDir (not a traversal). Returns 404.
    const res = await fetch(`${baseUrl}/media/..%2Fetc%2Fpasswd`)
    expect(res.status).toBe(404)
  })

  it('GET /media/..\\windows — URL-encoded backslash stays literal, file not found', async () => {
    // Same principle: %5C stays literal, not a real path separator
    const res = await fetch(`${baseUrl}/media/..%5Cwindows`)
    expect(res.status).toBe(404)
  })

  it('GET /media/ with empty filename is blocked', async () => {
    const res = await fetch(`${baseUrl}/media/`)
    expect(res.status).toBe(400) // empty filename is rejected
  })

  // --- Unknown routes ---

  it('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/nonexistent-route`)
    expect(res.status).toBe(404)
  })

  // --- PATCH /api/cron-jobs/:id — nextRun recalculation on re-enable ---

  it('PATCH /api/cron-jobs/:id recalculates nextRun when re-enabling a cron job', async () => {
    const staleNextRun = '2025-01-01T00:00:00.000Z' // far in the past
    const mockJob = {
      id: 'job-reenable-test',
      name: 'test-cron',
      agentId: 'brain',
      scheduleType: 'cron' as const,
      scheduleValue: '0 9 * * *', // every day at 09:00
      timezone: 'Asia/Shanghai',
      message: 'hello',
      enabled: false,
      nextRun: staleNextRun,
      createdAt: '2025-01-01T00:00:00.000Z',
      createdBy: 'dashboard',
    }

    // Configure mocks for this test
    const listJobsMock = vi.mocked(listJobs)
    const updateJobMock = vi.mocked(updateJob)
    listJobsMock.mockReturnValueOnce([mockJob])
    updateJobMock.mockReturnValueOnce(true)

    const res = await fetch(`${baseUrl}/api/cron-jobs/job-reenable-test`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.success).toBe(true)

    // Verify updateJob was called with a recalculated nextRun in the future
    expect(updateJobMock).toHaveBeenCalledWith(
      'job-reenable-test',
      expect.objectContaining({
        enabled: true,
        nextRun: expect.any(String),
      })
    )
    const callArgs = updateJobMock.mock.calls[updateJobMock.mock.calls.length - 1]
    const updatedNextRun = callArgs[1].nextRun as string
    expect(new Date(updatedNextRun).getTime()).toBeGreaterThan(Date.now())
    expect(updatedNextRun).not.toBe(staleNextRun)
  })

  it('PATCH /api/cron-jobs/:id recalculates nextRun for interval schedule on re-enable', async () => {
    const staleNextRun = '2025-01-01T00:00:00.000Z'
    const mockJob = {
      id: 'job-interval-test',
      name: 'test-interval',
      agentId: 'brain',
      scheduleType: 'interval' as const,
      scheduleValue: '3600000', // 1 hour in ms
      timezone: 'Asia/Shanghai',
      message: 'ping',
      enabled: false,
      nextRun: staleNextRun,
      createdAt: '2025-01-01T00:00:00.000Z',
      createdBy: 'dashboard',
    }

    const listJobsMock = vi.mocked(listJobs)
    const updateJobMock = vi.mocked(updateJob)
    listJobsMock.mockReturnValueOnce([mockJob])
    updateJobMock.mockReturnValueOnce(true)

    const beforeCall = Date.now()
    const res = await fetch(`${baseUrl}/api/cron-jobs/job-interval-test`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    })

    expect(res.status).toBe(200)

    const callArgs = updateJobMock.mock.calls[updateJobMock.mock.calls.length - 1]
    const updatedNextRun = new Date(callArgs[1].nextRun as string).getTime()
    // nextRun should be ~1 hour from now (within a small tolerance)
    expect(updatedNextRun).toBeGreaterThanOrEqual(beforeCall + 3600000 - 1000)
    expect(updatedNextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000)
  })

  it('PATCH /api/cron-jobs/:id does NOT recalculate nextRun when enabled is not true', async () => {
    const updateJobMock = vi.mocked(updateJob)
    updateJobMock.mockReturnValueOnce(true)

    const res = await fetch(`${baseUrl}/api/cron-jobs/some-job`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    })

    expect(res.status).toBe(200)

    // updateJob should be called with only the name update, no nextRun
    const callArgs = updateJobMock.mock.calls[updateJobMock.mock.calls.length - 1]
    expect(callArgs[1]).toEqual({ name: 'renamed' })
    expect(callArgs[1]).not.toHaveProperty('nextRun')
  })
})
