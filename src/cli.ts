#!/usr/bin/env node

/**
 * cc2im CLI
 *
 * cc2im login              — 微信扫码登录
 * cc2im hub                — 启动 hub（前台，调试用）
 * cc2im start              — 启动 hub + 所有 autoStart agent
 * cc2im agent start <name> — 手动启动一个 agent（前台，调试用）
 * cc2im agent stop <name>  — 停止一个 agent
 * cc2im agent list         — 列出所有 agent
 * cc2im install            — 安装 launchd 服务（后台运行）
 * cc2im uninstall          — 卸载 launchd 服务
 * cc2im status             — 查看运行状态
 * cc2im logs               — 查看日志
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import qrterm from 'qrcode-terminal'
import { SOCKET_DIR, ensureSocketDir } from './shared/socket.js'
import { ensureMcpJson } from './shared/mcp-config.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')
const BASE_URL = 'https://ilinkai.weixin.qq.com'

const BANNER = [
  '',
  '\x1b[36m\x1b[1m   ██████╗ ██████╗██████╗ ██╗███╗   ███╗\x1b[0m',
  '\x1b[36m\x1b[1m  ██╔════╝██╔════╝╚════██╗██║████╗ ████║\x1b[0m',
  '\x1b[36m\x1b[1m  ██║     ██║      █████╔╝██║██╔████╔██║\x1b[0m',
  '\x1b[36m\x1b[1m  ██║     ██║     ██╔═══╝ ██║██║╚██╔╝██║\x1b[0m',
  '\x1b[36m\x1b[1m  ╚██████╗╚██████╗███████╗██║██║ ╚═╝ ██║\x1b[0m',
  '\x1b[36m\x1b[1m   ╚═════╝ ╚═════╝╚══════╝╚═╝╚═╝     ╚═╝\x1b[0m',
  '\x1b[2m    Claude Code ↔ WeChat IM Gateway\x1b[0m',
  '\x1b[2m              by \x1b[0m\x1b[33mroxorlt\x1b[0m',
  '',
].join('\n')
const CRED_DIR = join(homedir(), '.weixin-bot')
const CRED_PATH = join(CRED_DIR, 'credentials.json')
const POLL_INTERVAL = 2000

// --- Helpers ---
function loadAgentsJson() {
  if (existsSync(AGENTS_JSON_PATH)) {
    return JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  }
  return null
}

function ensureDefaultConfig() {
  ensureSocketDir()
  if (!existsSync(AGENTS_JSON_PATH)) {
    const defaultConfig = {
      defaultAgent: 'brain',
      agents: {
        brain: {
          name: 'brain',
          cwd: join(homedir(), 'brain'),
          claudeArgs: ['--effort', 'max'],
          createdAt: new Date().toISOString().split('T')[0],
          autoStart: true,
        },
      },
    }
    writeFileSync(AGENTS_JSON_PATH, JSON.stringify(defaultConfig, null, 2) + '\n')
    console.log(`[cc2im] Created default config: ${AGENTS_JSON_PATH}`)
  }
}

// --- Commands ---

async function login() {
  console.log(BANNER)
  console.log('正在获取登录二维码...\n')

  let qrData: any
  try {
    const qrResp = await fetch(`${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)
    qrData = await qrResp.json()
  } catch (err: any) {
    console.error(`无法连接 iLink 服务器: ${err.message}`)
    process.exit(1)
  }

  const qrUrl = qrData.qrcode_img_content
  const qrToken = qrData.qrcode

  console.log('请用微信扫一扫下方二维码:\n')
  qrterm.generate(qrUrl, { small: true })
  console.log(`\n(也可手动复制链接在微信内打开: ${qrUrl})\n`)

  let lastStatus = ''
  while (true) {
    const statusResp = await fetch(
      `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrToken)}`,
      { headers: { 'iLink-App-ClientVersion': '1' } },
    )
    const status: any = await statusResp.json()

    if (status.status !== lastStatus) {
      if (status.status === 'scaned') console.log('已扫码，请在微信中确认授权...')
      if (status.status === 'expired') {
        console.log('二维码已过期，请重新运行: cc2im login')
        process.exit(1)
      }
      lastStatus = status.status
    }

    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id || !status.ilink_user_id) {
        console.error('授权成功但未返回凭证，请重试')
        process.exit(1)
      }

      const credentials = {
        token: status.bot_token,
        baseUrl: status.baseurl || BASE_URL,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
      }

      mkdirSync(CRED_DIR, { recursive: true, mode: 0o700 })
      writeFileSync(CRED_PATH, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 })

      console.log(`\n登录成功!`)
      console.log(`  accountId: ${credentials.accountId}`)
      console.log(`  userId:    ${credentials.userId}`)
      console.log(`  凭证已保存到 ${CRED_PATH}`)
      break
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL))
  }
}

async function runHub() {
  ensureDefaultConfig()
  const { startHub } = await import('./hub/index.js') as any
  await startHub({ autoStartAgents: false })
}

async function runStart() {
  ensureDefaultConfig()
  console.log('[cc2im] Starting hub + auto-start agents...')
  const { startHub } = await import('./hub/index.js') as any
  await startHub({ autoStartAgents: true })
}

function startAgentForeground(name: string) {
  const config = loadAgentsJson()
  if (!config?.agents?.[name]) {
    console.error(`Agent "${name}" not found in ${AGENTS_JSON_PATH}`)
    process.exit(1)
  }

  const agent = config.agents[name]

  // Resolve spoke script path (works for both tsx/src and compiled/dist)
  const dir = import.meta.dirname!
  const spokeTs = join(dir, 'spoke', 'index.ts')
  const spokeJs = join(dir, 'spoke', 'index.js')
  const spokeScript = existsSync(spokeTs) ? spokeTs : spokeJs

  ensureMcpJson(agent.cwd, spokeScript, name)

  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:cc2im',
    ...(agent.claudeArgs || []),
  ]

  const cmd = process.platform === 'darwin' ? 'caffeinate' : 'claude'
  const args = process.platform === 'darwin' ? ['-i', 'claude', ...claudeArgs] : claudeArgs

  console.log(`[cc2im] Starting agent "${name}" in ${agent.cwd} (foreground)`)
  const child = spawn(cmd, args, {
    cwd: agent.cwd,
    stdio: 'inherit',
  })

  child.on('exit', (code) => {
    console.log(`[cc2im] Agent "${name}" exited with code ${code}`)
    process.exit(code ?? 0)
  })
}

function agentRegister(name: string, cwd: string) {
  ensureDefaultConfig()
  const config = JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  if (config.agents[name]) {
    console.error(`Agent "${name}" already exists`)
    process.exit(1)
  }
  if (!existsSync(cwd)) {
    console.error(`Directory "${cwd}" does not exist`)
    process.exit(1)
  }
  config.agents[name] = {
    name,
    cwd,
    claudeArgs: [],
    createdAt: new Date().toISOString().split('T')[0],
    autoStart: false,
  }
  writeFileSync(AGENTS_JSON_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log(`[cc2im] Registered agent "${name}" → ${cwd}`)
}

function agentDeregister(name: string) {
  ensureDefaultConfig()
  const config = JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'))
  if (!config.agents[name]) {
    console.error(`Agent "${name}" not found`)
    process.exit(1)
  }
  delete config.agents[name]
  if (config.defaultAgent === name) {
    config.defaultAgent = Object.keys(config.agents)[0] || ''
  }
  writeFileSync(AGENTS_JSON_PATH, JSON.stringify(config, null, 2) + '\n')
  console.log(`[cc2im] Deregistered agent "${name}"`)
}

function agentList() {
  const config = loadAgentsJson()
  if (!config) {
    console.log('No agents configured. Run `cc2im hub` to create default config.')
    return
  }

  console.log(`Default agent: ${config.defaultAgent}\n`)
  for (const [name, agent] of Object.entries(config.agents) as [string, any][]) {
    const isDefault = name === config.defaultAgent ? ' ★' : ''
    console.log(`  ${name}${isDefault}`)
    console.log(`    cwd: ${agent.cwd}`)
    console.log(`    autoStart: ${agent.autoStart ?? false}`)
    console.log(`    claudeArgs: ${(agent.claudeArgs || []).join(' ')}`)
    console.log()
  }
}

// --- Main ---
const command = process.argv[2]
const subcommand = process.argv[3]
const arg = process.argv[4]

switch (command) {
  case '--version':
  case '-v':
    console.log('cc2im v0.1.0')
    break

  case 'login':
    await login()
    break

  case 'hub':
    await runHub()
    break

  case 'start':
    await runStart()
    break

  case 'agent':
    switch (subcommand) {
      case 'register': {
        const regCwd = process.argv[5]
        if (!arg || !regCwd) { console.error('Usage: cc2im agent register <name> <cwd>'); process.exit(1) }
        agentRegister(arg, regCwd)
        break
      }
      case 'deregister':
        if (!arg) { console.error('Usage: cc2im agent deregister <name>'); process.exit(1) }
        agentDeregister(arg)
        break
      case 'start':
        if (!arg) { console.error('Usage: cc2im agent start <name>'); process.exit(1) }
        startAgentForeground(arg)
        break
      case 'stop':
        console.log('Use `cc2im start` to run hub-managed agents, then stop via WeChat or MCP tools.')
        break
      case 'list':
        agentList()
        break
      default:
        console.error(`Unknown agent command: ${subcommand}`)
        console.error('Usage: cc2im agent [register|deregister|start|stop|list] [name] [cwd]')
        process.exit(1)
    }
    break

  case 'install': {
    const { install } = await import('./hub/launchd.js')
    install()
    break
  }

  case 'uninstall': {
    const { uninstall } = await import('./hub/launchd.js')
    uninstall()
    break
  }

  case 'status': {
    const { status } = await import('./hub/launchd.js')
    status()
    break
  }

  case 'logs': {
    const { logs } = await import('./hub/launchd.js')
    logs()
    break
  }

  case '--help':
  case '-h':
  default:
    console.log(`cc2im v0.1.0 — IM gateway for multiple Claude Code instances

Usage:
  cc2im login              微信扫码登录
  cc2im hub                启动 hub（前台调试，不启动 agent）
  cc2im start              启动 hub + 所有 autoStart agent
  cc2im agent start <name> 前台启动指定 agent（调试用）
  cc2im agent list         列出所有 agent 配置

  cc2im install            安装 launchd 后台服务
  cc2im uninstall          卸载 launchd 服务
  cc2im status             查看运行状态
  cc2im logs               查看实时日志
`)
}
