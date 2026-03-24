#!/usr/bin/env node

/**
 * cc2im CLI
 *
 * cc2im login        — 微信扫码登录
 * cc2im hub          — 启动 hub（前台，调试用）
 * cc2im start        — 启动 hub + 所有 autoStart agent
 * cc2im agent start <name>  — 手动启动一个 agent
 * cc2im agent stop <name>   — 停止一个 agent
 * cc2im agent list          — 列出所有 agent 及状态
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import qrterm from 'qrcode-terminal'
import { SOCKET_DIR, ensureSocketDir } from './shared/socket.js'

const AGENTS_JSON_PATH = join(SOCKET_DIR, 'agents.json')
const BASE_URL = 'https://ilinkai.weixin.qq.com'
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

async function startHub() {
  ensureDefaultConfig()
  const { startHub: runHub } = await import('./hub/index.js') as any
  await runHub()
}

function ensureMcpJson(agentCwd: string, spokeScriptPath: string, agentId: string) {
  const mcpPath = join(agentCwd, '.mcp.json')
  const entry = {
    command: 'npx',
    args: ['tsx', spokeScriptPath, '--agent-id', agentId],
  }

  let config: any = { mcpServers: {} }
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, 'utf8')) } catch {}
    config.mcpServers = config.mcpServers || {}
  }
  config.mcpServers['cc2im'] = entry
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n')
}

function startAgent(name: string) {
  const config = loadAgentsJson()
  if (!config?.agents?.[name]) {
    console.error(`Agent "${name}" not found in ${AGENTS_JSON_PATH}`)
    process.exit(1)
  }

  const agent = config.agents[name]
  const spokeScript = join(import.meta.dirname!, '..', 'src', 'spoke', 'index.ts')

  // Ensure .mcp.json in agent's cwd
  ensureMcpJson(agent.cwd, spokeScript, name)

  const claudeArgs = [
    '--dangerously-load-development-channels', 'server:cc2im',
    ...(agent.claudeArgs || []),
  ]

  // macOS: caffeinate -i to prevent idle sleep
  const cmd = process.platform === 'darwin' ? 'caffeinate' : 'claude'
  const args = process.platform === 'darwin' ? ['-i', 'claude', ...claudeArgs] : claudeArgs

  console.log(`[cc2im] Starting agent "${name}" in ${agent.cwd}`)
  const child = spawn(cmd, args, {
    cwd: agent.cwd,
    stdio: 'inherit',
  })

  child.on('exit', (code) => {
    console.log(`[cc2im] Agent "${name}" exited with code ${code}`)
  })

  return child
}

function agentList() {
  const config = loadAgentsJson()
  if (!config) {
    console.log('No agents configured. Run `cc2im hub` to create default config.')
    return
  }

  console.log(`Default agent: ${config.defaultAgent}\n`)
  for (const [name, agent] of Object.entries(config.agents) as [string, any][]) {
    console.log(`  ${name}`)
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
  case 'login':
    await login()
    break

  case 'hub':
    await startHub()
    break

  case 'start': {
    ensureDefaultConfig()
    // Start hub in background, then start all autoStart agents
    console.log('[cc2im] Starting hub + auto-start agents...')
    // For now, just start hub (agents will be managed in Phase 2)
    await startHub()
    break
  }

  case 'agent':
    switch (subcommand) {
      case 'start':
        if (!arg) { console.error('Usage: cc2im agent start <name>'); process.exit(1) }
        startAgent(arg)
        break
      case 'stop':
        console.log('Agent stop: not yet implemented (Phase 2)')
        break
      case 'list':
        agentList()
        break
      default:
        console.error(`Unknown agent command: ${subcommand}`)
        console.error('Usage: cc2im agent [start|stop|list] [name]')
        process.exit(1)
    }
    break

  default:
    console.log(`cc2im v0.1.0 — IM gateway for multiple Claude Code instances

Usage:
  cc2im login              微信扫码登录
  cc2im hub                启动 hub（前台调试）
  cc2im start              启动 hub + 所有 autoStart agent
  cc2im agent start <name> 启动指定 agent
  cc2im agent stop <name>  停止指定 agent
  cc2im agent list         列出所有 agent
`)
}
