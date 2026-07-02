/**
 * agent-env — marker that a CC process was launched BY cc2im as a managed agent.
 *
 * ~/brain/.mcp.json (written for the brain agent) is inherited by every Claude
 * session opened anywhere under ~/brain via ancestor .mcp.json discovery. Without
 * a guard, any such session spawns a spoke that registers as the agent and
 * hijacks its identity — messages then route to a session that never replies.
 *
 * Every legitimate launch path (agent-manager spawn, CLI foreground, terminal
 * handoff) sets this env var; the spoke refuses to register without it.
 */

export const AGENT_ENV_VAR = 'CC2IM_AGENT'

/** True when this process (or its CC parent) was launched as a cc2im-managed agent. */
export function isManagedAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_ENV_VAR] === '1'
}
