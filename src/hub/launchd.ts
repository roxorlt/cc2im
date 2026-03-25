/**
 * launchd 集成 — macOS 后台服务化
 */

import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync, spawn } from 'node:child_process'
import { SOCKET_DIR } from '../shared/socket.js'

const PLIST_LABEL = 'com.cc2im.hub'
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(PLIST_DIR, `${PLIST_LABEL}.plist`)
const LOG_PATH = join(SOCKET_DIR, 'hub.log')
const ERROR_LOG_PATH = join(SOCKET_DIR, 'hub.error.log')

function findBinary(name: string): string {
  try {
    return execSync(`which ${name}`, { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(`"${name}" not found in PATH`)
  }
}

function getCliScript(): string {
  // Resolve cli.ts/cli.js path relative to this file
  const dir = import.meta.dirname!
  const cliTs = join(dir, '..', 'cli.ts')
  const cliJs = join(dir, '..', 'cli.js')
  if (existsSync(cliTs)) return cliTs
  if (existsSync(cliJs)) return cliJs
  throw new Error('Cannot find cli entry point')
}

export function install() {
  if (process.platform !== 'darwin') {
    console.error('[cc2im] launchd is macOS-only')
    process.exit(1)
  }

  const npxPath = findBinary('npx')
  const cliScript = getCliScript()
  const pathEnv = process.env.PATH || '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'

  mkdirSync(PLIST_DIR, { recursive: true })
  mkdirSync(SOCKET_DIR, { recursive: true })

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>caffeinate</string>
    <string>-i</string>
    <string>${npxPath}</string>
    <string>tsx</string>
    <string>${cliScript}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERROR_LOG_PATH}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${homedir()}</string>
</dict>
</plist>
`

  writeFileSync(PLIST_PATH, plist)
  console.log(`[cc2im] Plist written to ${PLIST_PATH}`)

  try {
    execSync(`launchctl load ${PLIST_PATH}`, { stdio: 'inherit' })
    console.log(`[cc2im] Service loaded: ${PLIST_LABEL}`)
  } catch {
    console.error('[cc2im] Failed to load service. You may need to load manually:')
    console.error(`  launchctl load ${PLIST_PATH}`)
  }
}

export function uninstall() {
  if (existsSync(PLIST_PATH)) {
    try {
      execSync(`launchctl unload ${PLIST_PATH}`, { stdio: 'inherit' })
      console.log(`[cc2im] Service unloaded`)
    } catch {
      console.log('[cc2im] Service was not loaded')
    }
    unlinkSync(PLIST_PATH)
    console.log(`[cc2im] Plist removed: ${PLIST_PATH}`)
  } else {
    console.log(`[cc2im] No plist found at ${PLIST_PATH}`)
  }
}

export function status() {
  // Check launchd service
  try {
    const output = execSync('launchctl list', { encoding: 'utf8' })
    const line = output.split('\n').find(l => l.includes('cc2im'))
    if (line) {
      console.log(`Hub service: ${line.trim()}`)
    } else {
      console.log('Hub service: not loaded')
    }
  } catch {
    console.log('Hub service: unable to check')
  }

  // Check socket file
  const hubSockPath = join(SOCKET_DIR, 'hub.sock')
  console.log(`Hub socket: ${existsSync(hubSockPath) ? 'exists' : 'not found'}`)

  // Check agents.json
  const agentsPath = join(SOCKET_DIR, 'agents.json')
  if (existsSync(agentsPath)) {
    try {
      const config = JSON.parse(readFileSync(agentsPath, 'utf8'))
      const names = Object.keys(config.agents)
      console.log(`Agents configured: ${names.join(', ') || 'none'}`)
      console.log(`Default agent: ${config.defaultAgent}`)
    } catch {
      console.log('Agents config: unable to parse')
    }
  }
}

export function logs() {
  console.log(`[cc2im] Tailing logs from ${LOG_PATH} and ${ERROR_LOG_PATH}`)
  console.log('Press Ctrl+C to stop.\n')

  const files: string[] = []
  if (existsSync(LOG_PATH)) files.push(LOG_PATH)
  if (existsSync(ERROR_LOG_PATH)) files.push(ERROR_LOG_PATH)

  if (files.length === 0) {
    console.log('No log files found yet.')
    return
  }

  const tail = spawn('tail', ['-f', ...files], { stdio: 'inherit' })
  tail.on('exit', () => process.exit(0))
}
