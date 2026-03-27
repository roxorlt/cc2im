/**
 * WeixinChannel disconnect/reconnect teardown tests.
 *
 * Verifies that disconnect() properly stops polling and clears listeners
 * so that reconnect (disconnect + connect) doesn't stack handlers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── mock WeixinConnection ───────────────────────────────────────────
// Must be declared before the import of WeixinChannel so vi.mock hoists it.

const mockLogin = vi.fn().mockResolvedValue('mock-account-id')
const mockRestoreContextCache = vi.fn()
const mockSaveContextCache = vi.fn()
const mockSetMessageHandler = vi.fn()
const mockStartListening = vi.fn()
const mockStartPolling = vi.fn().mockReturnValue(new Promise(() => {})) // never resolves (like real polling)
const mockStop = vi.fn()
const mockSend = vi.fn()
const mockSendImage = vi.fn()
const mockSendFile = vi.fn()
const mockStartTyping = vi.fn()
const mockStopTyping = vi.fn()

vi.mock('../plugins/weixin/connection.js', () => ({
  WeixinConnection: vi.fn().mockImplementation(function (this: any) {
    this.login = mockLogin
    this.restoreContextCache = mockRestoreContextCache
    this.saveContextCache = mockSaveContextCache
    this.setMessageHandler = mockSetMessageHandler
    this.startListening = mockStartListening
    this.startPolling = mockStartPolling
    this.stop = mockStop
    this.send = mockSend
    this.sendImage = mockSendImage
    this.sendFile = mockSendFile
    this.startTyping = mockStartTyping
    this.stopTyping = mockStopTyping
  }),
}))

import { WeixinChannel } from '../plugins/weixin/weixin-channel.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WeixinChannel.disconnect()', () => {
  it('calls saveContextCache and stop on the connection', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')
    await ch.connect()

    await ch.disconnect()

    expect(mockSaveContextCache).toHaveBeenCalled()
    expect(mockStop).toHaveBeenCalled()
    // saveContextCache should be called before stop
    const saveOrder = mockSaveContextCache.mock.invocationCallOrder[0]
    const stopOrder = mockStop.mock.invocationCallOrder[0]
    expect(saveOrder).toBeLessThan(stopOrder)
  })

  it('sets status to disconnected', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')
    await ch.connect()
    expect(ch.getStatus()).toBe('connected')

    await ch.disconnect()
    expect(ch.getStatus()).toBe('disconnected')
  })

  it('fires status change handlers on disconnect', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')
    const statuses: string[] = []
    ch.onStatusChange((s) => statuses.push(s))

    await ch.connect()
    await ch.disconnect()

    // connecting -> connected -> disconnected
    expect(statuses).toEqual(['connecting', 'connected', 'disconnected'])
  })
})

describe('WeixinChannel reconnect (disconnect + connect)', () => {
  it('calls stop then re-initializes cleanly', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')

    // First connection
    await ch.connect()
    expect(mockLogin).toHaveBeenCalledTimes(1)
    expect(mockStartListening).toHaveBeenCalledTimes(1)

    // Disconnect
    await ch.disconnect()
    expect(mockStop).toHaveBeenCalledTimes(1)

    // Reconnect
    await ch.connect()
    expect(mockLogin).toHaveBeenCalledTimes(2)
    expect(mockStartListening).toHaveBeenCalledTimes(2)
    expect(ch.getStatus()).toBe('connected')
  })

  it('does not stack message handlers on reconnect', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')

    await ch.connect()
    await ch.disconnect()
    await ch.connect()

    // setMessageHandler is called once per connect() via registerMessageBridge
    // After disconnect+connect, there should be exactly 2 total calls (not stacking)
    expect(mockSetMessageHandler).toHaveBeenCalledTimes(2)
  })
})

describe('WeixinChannel.connect()', () => {
  it('calls login, restoreContextCache, registerMessageBridge, startListening, startPolling', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')
    await ch.connect()

    expect(mockLogin).toHaveBeenCalledWith('test-wx')
    expect(mockRestoreContextCache).toHaveBeenCalled()
    expect(mockSetMessageHandler).toHaveBeenCalled()
    expect(mockStartListening).toHaveBeenCalled()
    expect(mockStartPolling).toHaveBeenCalled()
  })

  it('sets status to connected on success', async () => {
    const ch = new WeixinChannel('test-wx', 'Test WeChat')
    await ch.connect()
    expect(ch.getStatus()).toBe('connected')
  })

  it('sets status to disconnected and rethrows on login failure', async () => {
    mockLogin.mockRejectedValueOnce(new Error('no credentials'))
    const ch = new WeixinChannel('test-wx', 'Test WeChat')

    await expect(ch.connect()).rejects.toThrow('no credentials')
    expect(ch.getStatus()).toBe('disconnected')
  })
})
