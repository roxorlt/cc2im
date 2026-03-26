/**
 * Stats Reader — polls ~/.claude/stats-cache.json
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const STATS_PATH = join(homedir(), '.claude', 'stats-cache.json')

export interface StatsData {
  dailyActivity: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>
  dailyModelTokens: Array<{ date: string; tokensByModel: Record<string, number> }>
  modelUsage: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }>
}

export function readStats(): StatsData | null {
  if (!existsSync(STATS_PATH)) return null
  try {
    return JSON.parse(readFileSync(STATS_PATH, 'utf8'))
  } catch {
    return null
  }
}
