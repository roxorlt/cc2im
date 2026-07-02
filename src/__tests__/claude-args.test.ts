import { describe, it, expect } from 'vitest'
import { DEFAULT_CLAUDE_ARGS, mergeClaudeArgs } from '../shared/claude-args.js'

describe('DEFAULT_CLAUDE_ARGS', () => {
  it('includes permission-mode auto and effort max', () => {
    expect(DEFAULT_CLAUDE_ARGS).toEqual([
      '--permission-mode', 'auto',
      '--effort', 'max',
    ])
  })

  it('does not include allowedTools (wildcard rejected by new CLI)', () => {
    expect(DEFAULT_CLAUDE_ARGS).not.toContain('--allowedTools')
  })
})

describe('mergeClaudeArgs', () => {
  it('returns defaults unchanged when user args is empty', () => {
    expect(mergeClaudeArgs(DEFAULT_CLAUDE_ARGS, [])).toEqual([
      '--permission-mode', 'auto',
      '--effort', 'max',
    ])
  })

  it('appends user args when no flag overlap', () => {
    expect(mergeClaudeArgs(DEFAULT_CLAUDE_ARGS, ['--foo', 'bar'])).toEqual([
      '--permission-mode', 'auto',
      '--effort', 'max',
      '--foo', 'bar',
    ])
  })

  it('drops default flag+value when user sets the same flag', () => {
    expect(mergeClaudeArgs(DEFAULT_CLAUDE_ARGS, ['--effort', 'high'])).toEqual([
      '--permission-mode', 'auto',
      '--effort', 'high',
    ])
  })

  it('handles multiple overrides', () => {
    expect(mergeClaudeArgs(
      DEFAULT_CLAUDE_ARGS,
      ['--permission-mode', 'ask', '--effort', 'low'],
    )).toEqual([
      '--permission-mode', 'ask',
      '--effort', 'low',
    ])
  })

  it('handles flag without value (bare flag)', () => {
    const defaults = ['--verbose', '--effort', 'max']
    expect(mergeClaudeArgs(defaults, ['--verbose'])).toEqual([
      '--effort', 'max',
      '--verbose',
    ])
  })

  it('does not mutate the input arrays', () => {
    const defaults = [...DEFAULT_CLAUDE_ARGS]
    const user = ['--effort', 'high']
    const defaultsSnapshot = [...defaults]
    const userSnapshot = [...user]
    mergeClaudeArgs(defaults, user)
    expect(defaults).toEqual(defaultsSnapshot)
    expect(user).toEqual(userSnapshot)
  })
})
