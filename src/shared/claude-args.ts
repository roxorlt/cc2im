/**
 * Default CC CLI args injected on every spawn.
 * Per-agent claudeArgs (in agents.json) override these by flag name.
 */
export const DEFAULT_CLAUDE_ARGS: readonly string[] = [
  '--permission-mode', 'auto',
  '--allowedTools', '*',
  '--effort', 'max',
]

/**
 * Merge defaults with per-agent overrides. If a flag name appears in `userArgs`,
 * its default (flag + value) is dropped so the user's value wins.
 */
export function mergeClaudeArgs(defaults: readonly string[], userArgs: readonly string[]): string[] {
  const userFlags = new Set(userArgs.filter(t => t.startsWith('--')))
  const filtered: string[] = []
  for (let i = 0; i < defaults.length; i++) {
    const token = defaults[i]
    if (token.startsWith('--') && userFlags.has(token)) {
      if (i + 1 < defaults.length && !defaults[i + 1].startsWith('--')) i++
      continue
    }
    filtered.push(token)
  }
  return [...filtered, ...userArgs]
}
