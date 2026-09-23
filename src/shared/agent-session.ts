/**
 * agent-session — tie each agent to ITS OWN Claude Code session.
 *
 * `--continue` resumes "the most recent session in cwd", so a restarted agent grabs
 * whatever session the user last touched in that directory (e.g. one opened from
 * `claude agents`), and `claude agents` then refuses to open it ("running in another
 * terminal"). Instead the hub records each agent's session id and resumes exactly
 * that one; a new session gets its id assigned up front via `--session-id`.
 */
import { randomUUID } from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Strict UUID check — `claude --resume <x>` treats a non-UUID as a search term (picker). */
export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

export interface SessionLaunch {
  args: string[]     // ['--resume', id] or ['--session-id', id]
  sessionId: string
  resumed: boolean   // true = resuming the recorded session; false = new session
}

/** Resume the recorded session, unless a fresh start is requested or nothing valid is recorded. */
export function sessionLaunch(recorded: string | undefined, fresh: boolean, newId: () => string = randomUUID): SessionLaunch {
  if (!fresh && isSessionId(recorded)) {
    return { args: ['--resume', recorded], sessionId: recorded, resumed: true }
  }
  const id = newId()
  return { args: ['--session-id', id], sessionId: id, resumed: false }
}
