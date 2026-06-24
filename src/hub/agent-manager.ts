/**
 * Agent Lifecycle Manager — hub 侧
 * 管理 agent 的注册/注销、启动/停止、健康检查
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, execSync, ChildProcess } from 'node:child_process'
import { SOCKET_DIR } from '../shared/socket.js'
import { ensureMcpJson } from '../shared/mcp-config.js'
import { DEFAULT_CLAUDE_ARGS, mergeClaudeArgs } from '../shared/claude-args.js'
import type { AgentConfig, AgentsConfig } from '../shared/types.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')
const PGID_FILE_PATH = join(SOCKET_DIR, 'agent-pgids.json')
const STOP_TIMEOUT_MS = 5000
const RESTART_DELAY_MS = 5000
const MAX_RESTART_ATTEMPTS = 5
const RESTART_WINDOW_MS = 5 * 60_000 // 5 min — reset counter if stable for this long
const CONNECT_TIMEOUT_MS = 60_000     // if spoke doesn't connect within this window after spawn,
                                      // assume init got stuck (e.g. unknown interactive prompt)
                                      // and restart without --continue to unblock

export class AgentManager {
  private processes = new Map<string, ChildProcess>()
  private config: AgentsConfig
  private getConnectedAgents: () => string[]
  private onEvent?: (kind: string, agentId: string, extra?: Record<string, any>) => void
  private stoppedManually = new Set<string>()  // agents stopped by user intent
  private shuttingDown = false                  // suppress auto-restart during hub shutdown
  private restartAttempts = new Map<string, { count: number; firstAt: number }>() // backoff tracking
  private skipContinueOnce = new Set<string>()  // agents to start without --continue on next spawn
                                                // (used when previous session stalled during init)

  constructor(getConnectedAgents: () => string[], onEvent?: (kind: string, agentId: string, extra?: Record<string, any>) => void) {
    this.config = this.loadConfig()
    this.getConnectedAgents = getConnectedAgents
    this.onEvent = onEvent
    this.killOrphanProcesses()
  }

  /**
   * Kill orphan agent processes from a previous hub session.
   * Reads PGIDs saved by the previous hub, kills any still-alive process groups,
   * then clears the file. Called once in constructor before any agents are started.
   */
  private killOrphanProcesses() {
    const names = new Set<string>()
    try {
      if (existsSync(PGID_FILE_PATH)) {
        const pgids: Record<string, number> = JSON.parse(readFileSync(PGID_FILE_PATH, 'utf8'))
        let killed = 0
        for (const [name, pgid] of Object.entries(pgids)) {
          names.add(name)
          try {
            process.kill(-pgid, 'SIGKILL') // kill entire process group (caffeinate + expect)
            killed++
            console.log(`[agent-manager] Killed orphan "${name}" (pgid ${pgid})`)
          } catch {
            // ESRCH = process group doesn't exist (already dead) — expected
          }
        }
        if (killed > 0) {
          console.log(`[agent-manager] Cleaned up ${killed} orphan process group(s)`)
        }
      }
    } catch {}
    // The pgid kill above misses any claude that called setsid() and escaped the group
    // (a hung claude survives otherwise). Reap those directly via their persisted PIDs.
    for (const name of Object.keys(this.config.agents)) names.add(name)
    for (const name of names) this.killDetachedClaude(name, 'SIGKILL')
    // Clear the file — we'll write fresh PGIDs as agents start
    this.savePgids()
  }

  /** Persist current agent PGIDs to disk for orphan cleanup on next startup. */
  private savePgids() {
    const pgids: Record<string, number> = {}
    for (const [name, child] of this.processes) {
      if (child.pid) pgids[name] = child.pid // detached child.pid === pgid
    }
    try {
      writeFileSync(PGID_FILE_PATH, JSON.stringify(pgids) + '\n')
    } catch {}
  }

  private loadConfig(): AgentsConfig {
    if (existsSync(AGENTS_JSON_PATH)) {
      return JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
    }
    return { defaultAgent: 'brain', agents: {} }
  }

  private saveConfig() {
    writeFileSync(AGENTS_JSON_PATH, JSON.stringify(this.config, null, 2) + '\n')
  }

  getConfig(): AgentsConfig {
    return this.config
  }

  reloadConfig() {
    this.config = this.loadConfig()
  }

  register(name: string, cwd: string, claudeArgs?: string[]): { success: boolean; error?: string } {
    if (this.config.agents[name]) {
      return { success: false, error: `Agent "${name}" already exists` }
    }
    if (!existsSync(cwd)) {
      return { success: false, error: `Directory "${cwd}" does not exist` }
    }

    this.config.agents[name] = {
      name,
      cwd,
      claudeArgs,
      createdAt: new Date().toISOString().split('T')[0],
      autoStart: true,
    }
    this.saveConfig()
    console.log(`[agent-manager] Registered "${name}" → ${cwd}`)
    return { success: true }
  }

  async deregister(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.config.agents[name]) {
      return { success: false, error: `Agent "${name}" not found` }
    }

    await this.stop(name)
    delete this.config.agents[name]

    if (this.config.defaultAgent === name) {
      const remaining = Object.keys(this.config.agents)
      this.config.defaultAgent = remaining[0] || ''
    }
    this.saveConfig()
    console.log(`[agent-manager] Deregistered "${name}"`)
    return { success: true }
  }

  start(name: string): { success: boolean; error?: string } {
    if (!this.config.agents[name]) {
      return { success: false, error: `Agent "${name}" not found in config` }
    }

    // Guard: refuse to spawn if spoke is already connected (externally started)
    const connected = this.getConnectedAgents()
    if (!this.processes.has(name) && connected.includes(name)) {
      return { success: false, error: `Agent "${name}" is already running externally (spoke connected). Stop it manually first.` }
    }

    // If process exists but spoke not connected, it's stale — kill and restart
    if (this.processes.has(name)) {
      if (connected.includes(name)) {
        return { success: false, error: `Agent "${name}" is already running and connected` }
      }
      console.log(`[agent-manager] Agent "${name}" has stale process (not connected), restarting`)
      const stale = this.processes.get(name)!
      this.killProcessTree(stale, name)
      this.processes.delete(name)
    }

    const agent = this.config.agents[name]

    // Cwd may have been renamed/deleted after registration. Fail this agent
    // gracefully instead of letting downstream fs writes crash the hub process.
    if (!existsSync(agent.cwd)) {
      return { success: false, error: `Agent "${name}" cwd does not exist: ${agent.cwd}` }
    }

    // Resolve spoke script path (works for both tsx/src and compiled/dist)
    const dir = import.meta.dirname!
    const spokeTs = join(dir, '..', 'spoke', 'index.ts')
    const spokeJs = join(dir, '..', 'spoke', 'index.js')
    const spokeScript = existsSync(spokeTs) ? spokeTs : spokeJs

    // Write .mcp.json in agent's cwd. Isolate any fs error so a single bad
    // agent can't bring down the hub (and with it the web dashboard).
    try {
      ensureMcpJson(agent.cwd, spokeScript, name)
    } catch (err: any) {
      return { success: false, error: `Failed to write .mcp.json for "${name}": ${err?.message ?? err}` }
    }

    // Ensure agent log directory
    const agentDir = join(SOCKET_DIR, 'agents', name)
    mkdirSync(agentDir, { recursive: true })

    // Skip --continue if the previous spawn stalled during init — start fresh instead
    const skipContinue = this.skipContinueOnce.delete(name)
    if (skipContinue) {
      console.log(`[agent-manager] "${name}": starting without --continue (previous session stalled during init)`)
    }
    const claudeArgs = [
      '--dangerously-load-development-channels', 'server:cc2im',
      ...(skipContinue ? [] : ['--continue']),  // resume most recent session unless last attempt stalled
      ...mergeClaudeArgs(DEFAULT_CLAUDE_ARGS, agent.claudeArgs || []),  // permission-mode/allowedTools/effort defaults + per-agent override
    ]

    // Use `expect` to allocate a pseudo-tty so CC enters interactive mode.
    // Unlike `script`, `expect` creates its own pty without needing a tty stdin.
    // The expect script auto-approves the workspace trust prompt and then waits.
    const logPath = join(agentDir, 'claude.log')
    const expectScriptPath = join(agentDir, 'start.exp')
    const claudePidPath = join(agentDir, 'claude.pid')

    // Capture claude's real PID: it calls setsid() and escapes the caffeinate/expect
    // process group, so `kill -pgid` alone can't reap it. We persist the PID so
    // killProcessTree / orphan cleanup can hard-kill a hung claude directly.
    const expectScript = [
      `log_file -a {${logPath}}`,
      `set cc_pid [spawn claude ${claudeArgs.map(a => `{${a}}`).join(' ')}]`,
      `set pidfh [open {${claudePidPath}} w]`,
      `puts $pidfh $cc_pid`,
      `close $pidfh`,
      '',
      '# Auto-handle initialization prompts:',
      '#   - Workspace trust prompt ("confirm" text)',
      '#   - "Resume from summary" session picker (shown by --continue for old/large sessions)',
      '# exp_continue keeps listening so multiple prompts in sequence are all handled.',
      '# If 60s passes with no further known prompts, assume CC is up and switch to eof wait.',
      'set timeout 60',
      'expect {',
      '  "Resume from summary" {',
      '    after 500',
      '    send "1\\r"',
      '    exp_continue',
      '  }',
      '  "confirm" {',
      '    after 500',
      '    send "\\r"',
      '    exp_continue',
      '  }',
      '  timeout {}',
      '}',
      '',
      '# Keep CC running until it exits',
      'set timeout -1',
      'expect eof',
    ].join('\n')
    writeFileSync(expectScriptPath, expectScript + '\n')

    // macOS: caffeinate -i prevents idle sleep
    const cmd = process.platform === 'darwin' ? 'caffeinate' : 'expect'
    const args = process.platform === 'darwin'
      ? ['-i', 'expect', expectScriptPath]
      : [expectScriptPath]

    console.log(`[agent-manager] Starting "${name}" in ${agent.cwd}`)
    const child = spawn(cmd, args, {
      cwd: agent.cwd,
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,  // new process group — allows killing entire tree with -pid
    })

    // Fallback: if spoke doesn't connect within CONNECT_TIMEOUT_MS, assume init got stuck
    // (e.g. an unknown interactive prompt blocked CC) and kill the process tree.
    // On next auto-restart, --continue is skipped so CC starts with a fresh session.
    const connectTimer = setTimeout(() => {
      if (!this.processes.has(name)) return                         // already exited/stopped
      if (this.getConnectedAgents().includes(name)) return          // healthy, no action needed
      console.warn(`[agent-manager] "${name}" did not connect within ${CONNECT_TIMEOUT_MS / 1000}s — killing to restart without --continue`)
      this.skipContinueOnce.add(name)
      this.killProcessTree(child, name)
    }, CONNECT_TIMEOUT_MS)

    child.on('exit', (code) => {
      clearTimeout(connectTimer)
      const wasConnected = this.getConnectedAgents().includes(name)
      console.log(`[agent-manager] Agent "${name}" exited (code ${code})`)
      this.processes.delete(name)
      this.savePgids()
      this.onEvent?.('agent_stopped', name, { code })

      // Don't restart if: shutting down, or user explicitly stopped
      if (this.shuttingDown) return
      if (this.stoppedManually.has(name)) {
        this.stoppedManually.delete(name)
        this.restartAttempts.delete(name)
        return
      }

      const agentConfig = this.config.agents[name]
      if (!agentConfig?.autoStart) return

      // If CC exited fast with non-zero code before ever connecting, --continue probably failed
      // (no prior session for a new agent). Skip --continue on next restart to start fresh.
      if (!wasConnected && code !== 0 && code !== null && !skipContinue) {
        console.log(`[agent-manager] "${name}" exited before connecting — will skip --continue on next restart`)
        this.skipContinueOnce.add(name)
      }

      // Backoff: track consecutive restarts within time window
      const now = Date.now()
      const attempts = this.restartAttempts.get(name)
      if (attempts && now - attempts.firstAt < RESTART_WINDOW_MS) {
        attempts.count++
        if (attempts.count > MAX_RESTART_ATTEMPTS) {
          console.error(`[agent-manager] "${name}" crashed ${attempts.count} times in ${Math.round((now - attempts.firstAt) / 1000)}s — giving up auto-restart`)
          this.restartAttempts.delete(name)
          this.onEvent?.('agent_dead', name)
          return
        }
      } else {
        this.restartAttempts.set(name, { count: 1, firstAt: now })
      }

      const attempt = this.restartAttempts.get(name)!
      const delay = RESTART_DELAY_MS * attempt.count // 5s, 10s, 15s, 20s, 25s
      console.log(`[agent-manager] Auto-restarting "${name}" in ${delay / 1000}s (attempt ${attempt.count}/${MAX_RESTART_ATTEMPTS})`)
      setTimeout(() => {
        if (this.shuttingDown || this.stoppedManually.has(name)) return
        const result = this.start(name)
        if (!result.success) {
          console.log(`[agent-manager] Failed to restart "${name}": ${result.error}`)
        }
      }, delay)
    })

    this.processes.set(name, child)
    this.savePgids()
    this.onEvent?.('agent_started', name)
    return { success: true }
  }

  /** Stop an agent and wait for the process to exit (with timeout).
   *  Marks as manually stopped — will NOT auto-restart. */
  stop(name: string): Promise<{ success: boolean; error?: string }> {
    const child = this.processes.get(name)
    if (!child) {
      return Promise.resolve({ success: false, error: `Agent "${name}" is not running` })
    }

    this.stoppedManually.add(name)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill entire process tree if SIGTERM didn't work
        this.killProcessTree(child, name)
        this.processes.delete(name)
        console.log(`[agent-manager] Force-killed "${name}" (SIGTERM timeout)`)
        resolve({ success: true })
      }, STOP_TIMEOUT_MS)

      child.once('exit', () => {
        clearTimeout(timeout)
        this.processes.delete(name)
        console.log(`[agent-manager] Stopped "${name}"`)
        resolve({ success: true })
      })

      // SIGTERM the entire process group
      this.killProcessTree(child, name, 'SIGTERM')
    })
  }

  list(): Array<{
    name: string
    cwd: string
    status: 'connected' | 'starting' | 'stopped'
    autoStart: boolean
    claudeArgs: string[]
    isDefault: boolean
  }> {
    const connected = this.getConnectedAgents()
    return Object.entries(this.config.agents).map(([name, agent]) => ({
      name,
      cwd: agent.cwd,
      // 'connected' = spoke online, 'starting' = process spawned but not yet connected, 'stopped' = no process
      status: connected.includes(name) ? 'connected' as const
        : this.processes.has(name) ? 'starting' as const
        : 'stopped' as const,
      autoStart: agent.autoStart ?? false,
      claudeArgs: agent.claudeArgs || [],
      isDefault: this.config.defaultAgent === name,
    }))
  }

  /** Kill an agent's entire process tree (caffeinate → expect → claude).
   *  Uses negative PID to kill the process group created by detached: true.
   *  `claude` calls setsid() and escapes that group, so it is killed separately
   *  via its persisted PID (see killDetachedClaude). */
  private killProcessTree(child: ChildProcess, name: string, signal: NodeJS.Signals = 'SIGKILL') {
    try {
      // Kill entire process group (negative PID) — caffeinate + expect
      process.kill(-child.pid!, signal)
    } catch {
      // Fallback: kill just the child
      try { child.kill(signal) } catch { /* already dead */ }
    }
    // claude detached into its own process group — reap it directly
    this.killDetachedClaude(name, signal)
  }

  private claudePidPath(name: string): string {
    return join(SOCKET_DIR, 'agents', name, 'claude.pid')
  }

  /** Read the persisted claude PID for an agent (written by the expect script). */
  private readClaudePid(name: string): number | null {
    try {
      const p = this.claudePidPath(name)
      if (!existsSync(p)) return null
      const pid = parseInt(readFileSync(p, 'utf8').trim(), 10)
      return Number.isInteger(pid) && pid > 1 ? pid : null
    } catch {
      return null
    }
  }

  /** Verify a PID is still THIS gateway's claude process before killing it.
   *  Guards against PID reuse (a stale claude.pid pointing at an unrelated process). */
  private isClaudeProcess(pid: number): boolean {
    try {
      const out = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8', timeout: 2000 })
      return out.includes('claude') && out.includes('server:cc2im')
    } catch {
      return false // ps exits non-zero when the PID no longer exists
    }
  }

  /** Hard-kill the detached claude process (and its own group) for an agent. No-op if
   *  the PID is unknown, already gone, or has been reused by an unrelated process. */
  private killDetachedClaude(name: string, signal: NodeJS.Signals = 'SIGKILL') {
    const pid = this.readClaudePid(name)
    if (pid == null || !this.isClaudeProcess(pid)) return
    try { process.kill(-pid, signal) } catch { /* no own group */ }
    try { process.kill(pid, signal) } catch { /* already dead */ }
    console.log(`[agent-manager] Hard-killed detached claude for "${name}" (pid ${pid})`)
  }

  /** Kill an agent's process for restart (e.g., after heartbeat eviction).
   *  Does NOT mark as manually stopped — child.on('exit') will auto-restart. */
  killForRestart(name: string) {
    const child = this.processes.get(name)
    if (child) {
      console.log(`[agent-manager] Killing "${name}" for restart`)
      this.killProcessTree(child, name)
    }
  }

  /** Hard restart: fully tear down an agent (incl. a hung claude that escaped its
   *  process group) and start it fresh. Works whether the agent is stuck-starting,
   *  running, or already stopped — the universal remote-recovery action. */
  async restart(name: string): Promise<{ success: boolean; error?: string }> {
    if (!this.config.agents[name]) {
      return { success: false, error: `Agent "${name}" is not registered` }
    }
    if (this.processes.has(name)) {
      // Hub-managed process exists — stop() now reaps the detached claude too.
      await this.stop(name)
    } else {
      // Not hub-managed — clear any lingering hung claude orphan before starting fresh.
      this.killDetachedClaude(name, 'SIGKILL')
    }
    // stop()/kill resolves on process exit, but the spoke's socket-close is detected
    // asynchronously. Wait until the hub marks it disconnected, else start() sees stale
    // "connected" state and refuses. Bounded so a zombie spoke can't hang restart forever.
    await this.waitForDisconnect(name, 6000)
    this.stoppedManually.delete(name)  // restart is intentional, allow re-start
    this.restartAttempts.delete(name)   // reset backoff
    return this.start(name)
  }

  /** Resolve once the agent's spoke is no longer connected, or after timeoutMs. */
  private waitForDisconnect(name: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = Date.now()
      const tick = () => {
        if (!this.getConnectedAgents().includes(name) || Date.now() - startedAt > timeoutMs) {
          return resolve()
        }
        setTimeout(tick, 200)
      }
      tick()
    })
  }

  updateEffort(name: string, effort: string): { success: boolean; error?: string } {
    if (!this.config.agents[name]) {
      return { success: false, error: `Agent "${name}" not found` }
    }
    const agent = this.config.agents[name]
    const args = agent.claudeArgs || []
    const effortIdx = args.indexOf('--effort')
    if (effortIdx >= 0) {
      args[effortIdx + 1] = effort
    } else {
      args.push('--effort', effort)
    }
    agent.claudeArgs = args
    this.saveConfig()
    return { success: true }
  }

  startAutoAgents() {
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (!agent.autoStart) continue
      // Each agent's startup is isolated: a failure (return-error or unexpected
      // throw) must not stop the loop, otherwise one bad config tears down the
      // whole hub including the web dashboard.
      try {
        const result = this.start(name)
        if (result.success) {
          console.log(`[agent-manager] Auto-started "${name}"`)
        } else {
          console.log(`[agent-manager] Failed to auto-start "${name}": ${result.error}`)
        }
      } catch (err: any) {
        console.error(`[agent-manager] Unexpected error auto-starting "${name}": ${err?.message ?? err}`)
      }
    }
  }

  /** Check if this agent's process is managed (spawned) by the hub. */
  isManaged(name: string): boolean {
    return this.processes.has(name)
  }

  async stopAll() {
    this.shuttingDown = true
    const names = [...this.processes.keys()]
    await Promise.all(names.map(name => this.stop(name)))
  }
}
