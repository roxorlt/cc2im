/**
 * Agent Lifecycle Manager — hub 侧
 * 管理 agent 的注册/注销、启动/停止、健康检查
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, ChildProcess } from 'node:child_process'
import { SOCKET_DIR } from '../shared/socket.js'
import { ensureMcpJson } from '../shared/mcp-config.js'
import type { AgentConfig, AgentsConfig } from '../shared/types.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')
const STOP_TIMEOUT_MS = 5000

export class AgentManager {
  private processes = new Map<string, ChildProcess>()
  private config: AgentsConfig
  private getConnectedAgents: () => string[]
  private onEvent?: (kind: string, agentId: string, extra?: Record<string, any>) => void

  constructor(getConnectedAgents: () => string[], onEvent?: (kind: string, agentId: string, extra?: Record<string, any>) => void) {
    this.config = this.loadConfig()
    this.getConnectedAgents = getConnectedAgents
    this.onEvent = onEvent
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
      stale.kill('SIGKILL')
      this.processes.delete(name)
    }

    const agent = this.config.agents[name]

    // Resolve spoke script path (works for both tsx/src and compiled/dist)
    const dir = import.meta.dirname!
    const spokeTs = join(dir, '..', 'spoke', 'index.ts')
    const spokeJs = join(dir, '..', 'spoke', 'index.js')
    const spokeScript = existsSync(spokeTs) ? spokeTs : spokeJs

    // Write .mcp.json in agent's cwd
    ensureMcpJson(agent.cwd, spokeScript, name)

    // Ensure agent log directory
    const agentDir = join(SOCKET_DIR, 'agents', name)
    mkdirSync(agentDir, { recursive: true })

    // autoMode defaults to true — auto-approve safe operations, deny risky ones
    const useAutoMode = agent.autoMode !== false

    const claudeArgs = [
      '--dangerously-load-development-channels', 'server:cc2im',
      ...(useAutoMode ? ['--enable-auto-mode'] : []),
      ...(agent.claudeArgs || []),
    ]

    // Use `expect` to allocate a pseudo-tty so CC enters interactive mode.
    // Unlike `script`, `expect` creates its own pty without needing a tty stdin.
    // The expect script auto-approves the workspace trust prompt and then waits.
    const logPath = join(agentDir, 'claude.log')
    const expectScriptPath = join(agentDir, 'start.exp')

    const expectScript = [
      `log_file -a {${logPath}}`,
      `spawn claude ${claudeArgs.map(a => `{${a}}`).join(' ')}`,
      '',
      '# Auto-approve workspace trust prompt if it appears',
      'set timeout 30',
      'expect {',
      '  "confirm" {',
      '    after 500',
      '    send "\\r"',
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
    })

    child.on('exit', (code) => {
      console.log(`[agent-manager] Agent "${name}" exited (code ${code})`)
      this.processes.delete(name)
      this.onEvent?.('agent_stopped', name, { code })

      // Auto-restart if configured (covers normal exit, not just heartbeat eviction)
      const agentConfig = this.config.agents[name]
      if (agentConfig?.autoStart) {
        console.log(`[agent-manager] Auto-restarting "${name}" (exited with code ${code})`)
        setTimeout(() => {
          const result = this.start(name)
          if (!result.success) {
            console.log(`[agent-manager] Failed to restart "${name}": ${result.error}`)
          }
        }, 5000)
      }
    })

    this.processes.set(name, child)
    this.onEvent?.('agent_started', name)
    return { success: true }
  }

  /** Stop an agent and wait for the process to exit (with timeout). */
  stop(name: string): Promise<{ success: boolean; error?: string }> {
    const child = this.processes.get(name)
    if (!child) {
      return Promise.resolve({ success: false, error: `Agent "${name}" is not running` })
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        // Force kill if SIGTERM didn't work
        child.kill('SIGKILL')
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

      child.kill('SIGTERM')
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

  async restart(name: string): Promise<{ success: boolean; error?: string }> {
    // Only restart hub-managed agents. Externally started agents (foreground CLI)
    // cannot be stopped by the hub — refuse rather than spawn a duplicate.
    if (!this.processes.has(name)) {
      const connected = this.getConnectedAgents()
      if (connected.includes(name)) {
        return { success: false, error: `Agent "${name}" was started externally. Stop it manually, then use start.` }
      }
      return { success: false, error: `Agent "${name}" is not running` }
    }
    await this.stop(name)
    return this.start(name)
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
      if (agent.autoStart) {
        const result = this.start(name)
        if (result.success) {
          console.log(`[agent-manager] Auto-started "${name}"`)
        } else {
          console.log(`[agent-manager] Failed to auto-start "${name}": ${result.error}`)
        }
      }
    }
  }

  /** Check if this agent's process is managed (spawned) by the hub. */
  isManaged(name: string): boolean {
    return this.processes.has(name)
  }

  async stopAll() {
    const names = [...this.processes.keys()]
    await Promise.all(names.map(name => this.stop(name)))
  }
}
