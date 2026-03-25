/**
 * Shared utility for managing .mcp.json in agent working directories
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Ensure the cc2im spoke entry exists in the agent's .mcp.json */
export function ensureMcpJson(agentCwd: string, spokeScriptPath: string, agentId: string) {
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
