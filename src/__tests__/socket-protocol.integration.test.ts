/**
 * Integration: Real Unix socket with ndjson frame protocol
 *
 * Tests actual network I/O — frames sent over a real socket,
 * parsed on the receiving end.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, createConnection, Server, Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { unlinkSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { encodeFrame, createFrameParser } from '../shared/socket.js'

/** Create a temp socket path that won't collide */
function tempSocketPath(): string {
  return join(tmpdir(), `cc2im-test-${randomUUID()}.sock`)
}

/** Promise that resolves when N frames are collected */
function collectFrames(socket: Socket, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const frames: unknown[] = []
    const parser = createFrameParser((frame) => {
      frames.push(frame)
      if (frames.length >= count) resolve(frames)
    })
    socket.on('data', parser)
  })
}

describe('Socket protocol (integration)', () => {
  let server: Server | null = null
  let socketPath = ''

  afterEach(() => {
    server?.close()
    if (socketPath && existsSync(socketPath)) {
      try { unlinkSync(socketPath) } catch {}
    }
  })

  it('sends and receives frames over a real Unix socket', async () => {
    socketPath = tempSocketPath()

    // Start server
    const clientConnected = new Promise<Socket>((resolve) => {
      server = createServer((socket) => resolve(socket))
      server.listen(socketPath)
    })

    // Connect client
    const client = createConnection(socketPath)
    const serverSocket = await clientConnected

    // Server sends a frame to client
    const clientReceive = collectFrames(client, 1)
    serverSocket.write(encodeFrame({ type: 'message', text: 'hello from server' }))
    const clientFrames = await clientReceive
    expect(clientFrames[0]).toEqual({ type: 'message', text: 'hello from server' })

    // Client sends a frame to server
    const serverReceive = collectFrames(serverSocket, 1)
    client.write(encodeFrame({ type: 'register', agentId: 'test-agent' }))
    const serverFrames = await serverReceive
    expect(serverFrames[0]).toEqual({ type: 'register', agentId: 'test-agent' })

    client.end()
  })

  it('handles rapid-fire multiple frames', async () => {
    socketPath = tempSocketPath()

    const clientConnected = new Promise<Socket>((resolve) => {
      server = createServer((socket) => resolve(socket))
      server.listen(socketPath)
    })

    const client = createConnection(socketPath)
    const serverSocket = await clientConnected

    const frameCount = 50
    const clientReceive = collectFrames(client, frameCount)

    // Send 50 frames rapidly
    for (let i = 0; i < frameCount; i++) {
      serverSocket.write(encodeFrame({ seq: i, data: `msg-${i}` }))
    }

    const frames = await clientReceive
    expect(frames).toHaveLength(frameCount)

    // Verify order preserved
    for (let i = 0; i < frameCount; i++) {
      expect(frames[i]).toEqual({ seq: i, data: `msg-${i}` })
    }

    client.end()
  })

  it('handles frames with Chinese text and special characters', async () => {
    socketPath = tempSocketPath()

    const clientConnected = new Promise<Socket>((resolve) => {
      server = createServer((socket) => resolve(socket))
      server.listen(socketPath)
    })

    const client = createConnection(socketPath)
    const serverSocket = await clientConnected

    const clientReceive = collectFrames(client, 1)
    const payload = {
      type: 'message',
      text: '你好世界 🌍\n第二行\t制表符',
      userId: '微信用户_123',
    }
    serverSocket.write(encodeFrame(payload))

    const frames = await clientReceive
    expect(frames[0]).toEqual(payload)

    client.end()
  })

  it('simulates spoke registration → hub message → spoke reply round-trip', async () => {
    socketPath = tempSocketPath()

    // Hub side
    const spokeFrames: unknown[] = []
    const hubFrames: unknown[] = []

    const clientConnected = new Promise<Socket>((resolve) => {
      server = createServer((socket) => {
        const parser = createFrameParser((frame) => hubFrames.push(frame))
        socket.on('data', parser)
        resolve(socket)
      })
      server.listen(socketPath)
    })

    // Spoke connects
    const spoke = createConnection(socketPath)
    const hubSocket = await clientConnected

    const spokeParser = createFrameParser((frame) => spokeFrames.push(frame))
    spoke.on('data', spokeParser)

    // Step 1: Spoke registers
    spoke.write(encodeFrame({ type: 'register', agentId: 'brain', pid: 12345 }))
    await new Promise(r => setTimeout(r, 20))
    expect(hubFrames).toHaveLength(1)
    expect(hubFrames[0]).toEqual({ type: 'register', agentId: 'brain', pid: 12345 })

    // Step 2: Hub delivers a message
    hubSocket.write(encodeFrame({
      type: 'message',
      userId: 'wxid_abc',
      text: '查一下天气',
      msgType: 'text',
      timestamp: '2026-03-27T10:00:00Z',
    }))
    await new Promise(r => setTimeout(r, 20))
    expect(spokeFrames).toHaveLength(1)
    expect((spokeFrames[0] as any).text).toBe('查一下天气')

    // Step 3: Spoke replies
    spoke.write(encodeFrame({
      type: 'reply',
      agentId: 'brain',
      userId: 'wxid_abc',
      text: '今天北京晴，25°C',
    }))
    await new Promise(r => setTimeout(r, 20))
    expect(hubFrames).toHaveLength(2)
    expect((hubFrames[1] as any).text).toBe('今天北京晴，25°C')

    spoke.end()
  })
})
