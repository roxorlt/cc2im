import { describe, it, expect } from 'vitest'
import { encodeFrame, createFrameParser } from '../shared/socket.js'

describe('encodeFrame', () => {
  it('encodes object as JSON + newline', () => {
    const frame = encodeFrame({ type: 'test', value: 42 })
    expect(frame).toBeInstanceOf(Buffer)
    expect(frame.toString()).toBe('{"type":"test","value":42}\n')
  })

  it('encodes string value', () => {
    const frame = encodeFrame('hello')
    expect(frame.toString()).toBe('"hello"\n')
  })
})

describe('createFrameParser', () => {
  it('parses a single complete frame', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    parser(Buffer.from('{"type":"register","agentId":"brain"}\n'))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ type: 'register', agentId: 'brain' })
  })

  it('handles multiple frames in one chunk', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    parser(Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n'))

    expect(frames).toHaveLength(3)
    expect(frames[0]).toEqual({ a: 1 })
    expect(frames[1]).toEqual({ b: 2 })
    expect(frames[2]).toEqual({ c: 3 })
  })

  it('handles frame split across multiple chunks', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    // Split '{"type":"msg"}\n' across two chunks
    parser(Buffer.from('{"type":'))
    expect(frames).toHaveLength(0)

    parser(Buffer.from('"msg"}\n'))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ type: 'msg' })
  })

  it('handles partial frame followed by complete frame', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    parser(Buffer.from('{"partial":'))
    parser(Buffer.from('true}\n{"complete":true}\n'))

    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({ partial: true })
    expect(frames[1]).toEqual({ complete: true })
  })

  it('ignores empty lines', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    parser(Buffer.from('\n\n{"ok":true}\n\n'))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ ok: true })
  })

  it('survives malformed JSON without crashing', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    // Bad frame followed by good frame
    parser(Buffer.from('not-json\n{"valid":true}\n'))

    // Only the valid frame should be parsed
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ valid: true })
  })

  it('roundtrips with encodeFrame', () => {
    const frames: unknown[] = []
    const parser = createFrameParser((data) => frames.push(data))

    const original = { type: 'reply', agentId: 'brain', userId: 'u1', text: '你好' }
    parser(encodeFrame(original))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual(original)
  })
})
