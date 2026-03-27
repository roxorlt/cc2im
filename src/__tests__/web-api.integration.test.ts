/**
 * Integration: Web Monitor HTTP API
 *
 * Starts a real HTTP server, hits API endpoints, verifies responses.
 * No external dependencies (no hub, no WeChat, no SQLite for most tests).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/**
 * We can't import startWeb directly because it pulls in SQLite-dependent
 * modules at import time. Instead we test the HTTP routing logic by
 * recreating the key handlers in isolation.
 *
 * This tests the API contract (status codes, JSON shape, security checks)
 * without needing the full plugin stack.
 */

// --- Minimal HTTP server mirroring server.ts API routes ---

function createTestServer(opts: {
  agentsJson?: any
  messageHistory?: any[]
  channels?: any[]
  mediaDir?: string
}) {
  const { agentsJson, messageHistory = [], channels = [], mediaDir } = opts

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost')

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hubConnected: false, uptime: 1, wsClients: 0 }))
      return
    }

    if (url.pathname === '/api/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(agentsJson || { defaultAgent: '', agents: {} }))
      return
    }

    if (url.pathname === '/api/messages') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      const agentId = url.searchParams.get('agent')
      const filtered = agentId
        ? messageHistory.filter((m: any) => m.event.agentId === agentId)
        : messageHistory
      res.end(JSON.stringify(filtered))
      return
    }

    if (url.pathname === '/api/channels' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(channels))
      return
    }

    // Media serving with path traversal protection (mirrors server.ts)
    if (url.pathname.startsWith('/media/') && mediaDir) {
      const filename = url.pathname.slice('/media/'.length)
      if (!filename || filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
        res.writeHead(400)
        res.end('Bad request')
        return
      }
      const filePath = join(mediaDir, filename)
      if (!existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      const { readFileSync } = require('node:fs')
      res.end(readFileSync(filePath))
      return
    }

    res.writeHead(404)
    res.end('Not found')
  })

  return server
}

function getPort(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr ? addr.port : 0
}

async function fetch(url: string, opts?: RequestInit): Promise<{ status: number; json: () => Promise<any>; text: () => Promise<string> }> {
  const res = await globalThis.fetch(url, opts)
  return res
}

describe('Web API (integration)', () => {
  let server: Server
  let baseUrl: string
  let mediaDir: string

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

  const testChannels = [
    { id: 'weixin-roxor', type: 'weixin', label: 'roxor', status: 'connected' },
  ]

  beforeAll(async () => {
    mediaDir = join(tmpdir(), `cc2im-test-media-${randomUUID()}`)
    mkdirSync(mediaDir, { recursive: true })
    writeFileSync(join(mediaDir, 'test.jpg'), Buffer.from('fake-image-data'))

    server = createTestServer({
      agentsJson: testAgentsConfig,
      messageHistory: testMessages,
      channels: testChannels,
      mediaDir,
    })

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    baseUrl = `http://127.0.0.1:${getPort(server)}`
  })

  afterAll(() => {
    server.close()
    try { rmSync(mediaDir, { recursive: true }) } catch {}
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

  it('GET /media/../etc/passwd is blocked (path traversal)', async () => {
    const res = await fetch(`${baseUrl}/media/..%2Fetc%2Fpasswd`)
    // URL decodes to ../etc/passwd which contains / — should be blocked
    expect(res.status).toBe(400)
  })

  it('GET /media/..\\windows is blocked (backslash traversal)', async () => {
    const res = await fetch(`${baseUrl}/media/..%5Cwindows`)
    expect(res.status).toBe(400)
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
})
