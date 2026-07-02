/**
 * Agent-name validation — shared by onboard (HTTP) and rename (management),
 * so the two entry points can't drift. The name becomes a filesystem path
 * segment (~/.cc2im/agents/<name>/…) and an --agent-id argv token in the
 * expect-spawned claude, so it must reject path separators / traversal.
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9一-龥][A-Za-z0-9一-龥._-]{0,63}$/

export function isValidAgentName(name: unknown): name is string {
  return typeof name === 'string' && AGENT_NAME_RE.test(name)
}
