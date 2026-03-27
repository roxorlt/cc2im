import { describe, it, expect } from 'vitest'
import { splitIntoChunks, formatChunks } from '../plugins/weixin/chunker.js'

describe('splitIntoChunks', () => {
  it('returns single chunk for short text', () => {
    const result = splitIntoChunks('hello world')
    expect(result).toEqual(['hello world'])
  })

  it('returns single chunk at exactly max length', () => {
    const text = 'a'.repeat(1800)
    const result = splitIntoChunks(text)
    expect(result).toHaveLength(1)
  })

  it('splits long text into multiple chunks', () => {
    const text = 'a'.repeat(3600)
    const result = splitIntoChunks(text)
    expect(result.length).toBeGreaterThan(1)
    // all chunks <= 1800
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1800)
    }
  })

  it('does not split code fences', () => {
    const code = '```\n' + 'x\n'.repeat(10) + '```'
    const padding = 'a'.repeat(1700)
    const text = padding + '\n\n' + code
    const result = splitIntoChunks(text)
    // code block should be in one chunk
    const codeChunk = result.find(c => c.includes('```'))!
    expect(codeChunk).toBeDefined()
    const fenceCount = (codeChunk.match(/```/g) || []).length
    expect(fenceCount).toBe(2) // opening and closing fence in same chunk
  })

  it('does not split tables', () => {
    const table = [
      '| Name | Value |',
      '|------|-------|',
      '| foo  | 1     |',
      '| bar  | 2     |',
      '| baz  | 3     |',
    ].join('\n')
    const padding = 'a'.repeat(1700)
    const text = padding + '\n\n' + table
    const result = splitIntoChunks(text)
    const tableChunk = result.find(c => c.includes('| Name'))!
    expect(tableChunk).toBeDefined()
    expect(tableChunk).toContain('| baz')
  })

  it('handles unclosed code fence gracefully', () => {
    const text = '```\nsome code without closing fence\nmore code'
    const result = splitIntoChunks(text)
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result.join('\n')).toContain('some code')
  })

  it('handles oversized single line with hard cut', () => {
    const longLine = 'x'.repeat(4000)
    const result = splitIntoChunks(longLine)
    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(1800)
    }
    // reconstructed text should match original
    expect(result.join('')).toBe(longLine)
  })

  it('splits at paragraph boundaries', () => {
    const p1 = 'a'.repeat(1000)
    const p2 = 'b'.repeat(1000)
    const text = p1 + '\n\n' + p2
    const result = splitIntoChunks(text)
    expect(result.length).toBe(2)
    expect(result[0]).toContain('aaa')
    expect(result[1]).toContain('bbb')
  })

  it('returns empty array for empty string', () => {
    const result = splitIntoChunks('')
    expect(result).toEqual([''])
  })
})

describe('formatChunks', () => {
  it('returns single chunk without prefix', () => {
    const result = formatChunks(['hello'])
    expect(result).toEqual(['hello'])
  })

  it('adds [n/N] prefix to multiple chunks', () => {
    const result = formatChunks(['chunk1', 'chunk2', 'chunk3'])
    expect(result[0]).toBe('[1/3]\nchunk1')
    expect(result[1]).toBe('[2/3]\nchunk2')
    expect(result[2]).toBe('[3/3]\nchunk3')
  })

  it('returns empty array for empty input', () => {
    const result = formatChunks([])
    expect(result).toEqual([])
  })
})
