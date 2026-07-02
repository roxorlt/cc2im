/**
 * open-terminal — launch a command in a new macOS terminal window.
 *
 * Used by the dashboard's one-click handoff: stop a managed agent, then open
 * a real terminal running `claude --continue …` so the human can take over the
 * session locally. Split into pure builders + one injectable side-effect fn so
 * everything except the actual GUI window is unit-testable.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SOCKET_DIR } from './socket.js'

/** POSIX single-quote escaping: wrap in '…', turn internal ' into '\''. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** One-shot script: cd into cwd, then run command. */
export function buildTerminalScript(cwd: string, command: string): string {
  return `#!/bin/zsh\ncd ${shellQuote(cwd)} && ${command}\n`
}

/** Pick the terminal app — Ghostty if installed, else macOS Terminal. */
export function resolveTerminalApp(hasGhostty: boolean): 'Ghostty' | 'Terminal' {
  return hasGhostty ? 'Ghostty' : 'Terminal'
}

export interface OpenTerminalDeps {
  ghosttyInstalled?: () => boolean
  spawnFn?: typeof spawn
  writeScript?: (content: string) => string  // returns the script path
}

export interface OpenTerminalResult {
  ok: boolean
  app?: string
  scriptPath?: string
  command?: string
  error?: string
}

/** Open `command` in a new terminal window rooted at `cwd`. */
export function openInTerminal(cwd: string, command: string, deps: OpenTerminalDeps = {}): OpenTerminalResult {
  const ghosttyInstalled = deps.ghosttyInstalled ?? (() => existsSync('/Applications/Ghostty.app'))
  const spawnFn = deps.spawnFn ?? spawn
  const writeScript = deps.writeScript ?? ((content: string) => {
    const dir = join(SOCKET_DIR, 'handoff')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${randomUUID()}.command`)
    writeFileSync(p, content)
    chmodSync(p, 0o755)
    return p
  })

  const app = resolveTerminalApp(ghosttyInstalled())
  try {
    const scriptPath = writeScript(buildTerminalScript(cwd, command))
    const child = spawnFn('open', ['-a', app, scriptPath], { detached: true, stdio: 'ignore' })
    // Detach so the terminal outlives the hub process
    if (child && typeof child.unref === 'function') child.unref()
    return { ok: true, app, scriptPath, command }
  } catch (err: any) {
    return { ok: false, app, error: err?.message ?? String(err) }
  }
}

/** The claude command a handed-off terminal should run (matches agent-manager spawn args, sans expect). */
export function handoffCommand(): string {
  return 'claude --continue --dangerously-load-development-channels server:cc2im --permission-mode auto --effort max'
}
