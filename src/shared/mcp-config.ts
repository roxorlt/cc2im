/**
 * Shared utility for managing .mcp.json in agent working directories
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Resolve the command + args for running the spoke script.
 * - .ts files: use cc2im's own tsx binary (absolute path from node_modules/.bin/)
 * - .js files: use node directly (process.execPath)
 */
function resolveRunner(spokeScriptPath: string): { command: string; args: string[] } {
  if (spokeScriptPath.endsWith('.ts')) {
    // Walk up from spoke script to find cc2im's node_modules/.bin/tsx
    // spokeScriptPath is like /path/to/cc2im/src/spoke/index.ts
    const cc2imRoot = dirname(dirname(dirname(spokeScriptPath))) // src/spoke/index.ts → cc2im root
    const tsxBin = join(cc2imRoot, 'node_modules', '.bin', 'tsx')
    if (existsSync(tsxBin)) {
      return { command: tsxBin, args: [] }
    }
    // Fallback: try npx tsx (may not work on clean workspaces)
    return { command: 'npx', args: ['tsx'] }
  }
  // .js files: node can run them directly
  return { command: process.execPath, args: [] }
}

/** Ensure the cc2im spoke entry exists in the agent's .mcp.json */
export function ensureMcpJson(agentCwd: string, spokeScriptPath: string, agentId: string) {
  const mcpPath = join(agentCwd, '.mcp.json')
  const runner = resolveRunner(spokeScriptPath)
  const entry = {
    command: runner.command,
    args: [...runner.args, spokeScriptPath, '--agent-id', agentId],
  }

  let config: any = { mcpServers: {} }
  if (existsSync(mcpPath)) {
    try { config = JSON.parse(readFileSync(mcpPath, 'utf8')) } catch {}
    config.mcpServers = config.mcpServers || {}
  }
  config.mcpServers['cc2im'] = entry
  writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n')
}
