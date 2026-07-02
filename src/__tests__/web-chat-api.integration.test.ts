/**
 * Integration: Dashboard chat API (POST /api/chat)
 *
 * Uses the REAL createApiHandler + a REAL WebChannel instance,
 * verifying the dashboard → web channel injection path end to end
 * (short of the hub routing, which channel-manager owns).
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

import { createApiHandler } from '../plugins/web-monitor/server.js'
import { WebChannel, WEB_CHANNEL_ID, WEB_USER_ID } from '../plugins/web-channel/index.js'
import type { HubContext } from '../shared/plugin.js'
import type { IncomingChannelMessage } from '../shared/channel.js'

function getPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

describe('Dashboard chat API (integration)', () => {
  let server: Server
  let baseUrl: string
  let tmpDir: string
  const received: IncomingChannelMessage[] = []

  const webChannel = new WebChannel()
  webChannel.onMessage(async (msg) => { received.push(msg) })

  const mockCtx = {
    getChannels: vi.fn(() => [webChannel]),
    getChannel: vi.fn((id: string) => (id === WEB_CHANNEL_ID ? webChannel : undefined)),
    addChannel: vi.fn(),
    removeChannel: vi.fn(),
    reconnectChannel: vi.fn(),
  } as unknown as HubContext

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `cc2im-chat-test-${randomUUID()}`)
    mkdirSync(tmpDir, { recursive: true })
    const agentsJsonPath = join(tmpDir, 'agents.json')
    writeFileSync(agentsJsonPath, JSON.stringify({ defaultAgent: 'brain', agents: {} }))

    const handler = createApiHandler({
      agentsJsonPath,
      mediaDir: tmpDir,
      messageHistory: [],
      monitor: { isConnected: () => true },
      wsClients: { size: 0 },
      ctx: mockCtx,
      activeQrPolls: new Map(),
      broadcastWs: vi.fn(),
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

  it('POST /api/chat injects message with @agent prefix and dashboard identity', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好', agentId: 'brain' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const msg = received.at(-1)!
    expect(msg.text).toBe('@brain 你好')
    expect(msg.channelId).toBe(WEB_CHANNEL_ID)
    expect(msg.channelType).toBe('web')
    expect(msg.userId).toBe(WEB_USER_ID)
    expect(msg.type).toBe('text')
  })

  it('POST /api/chat does not double-prefix when text already has @mention', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '@xq 查一下', agentId: 'brain' }),
    })
    expect(res.status).toBe(200)
    expect(received.at(-1)!.text).toBe('@xq 查一下')
  })

  it('POST /api/chat without agentId sends raw text (default-agent routing)', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '走默认路由' }),
    })
    expect(res.status).toBe(200)
    expect(received.at(-1)!.text).toBe('走默认路由')
  })

  it('POST /api/chat rejects empty text with 400', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ', agentId: 'brain' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/chat rejects invalid JSON with 500', async () => {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    expect(res.status).toBe(500)
  })

  it('DELETE /api/channels/web is refused (built-in channel)', async () => {
    const res = await fetch(`${baseUrl}/api/channels/${WEB_CHANNEL_ID}`, { method: 'DELETE' })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toMatch(/built-in/)
  })
})

describe('WebChannel unit', () => {
  it('reports connected status and no-ops outbound', async () => {
    const ch = new WebChannel()
    expect(ch.getStatus()).toBe('connected')
    await expect(ch.sendText('u', 'x')).resolves.toBeUndefined()
    await expect(ch.sendFile('u', '/tmp/x')).resolves.toBeUndefined()
  })

  it('injectIncoming throws before onMessage is wired', async () => {
    const ch = new WebChannel()
    await expect(ch.injectIncoming('hi')).rejects.toThrow(/not wired/)
  })
})
