import { execSync } from 'node:child_process'

export interface UsageStats {
  fiveHour?: { utilization: number; resetsAt: string }
  sevenDay?: { utilization: number; resetsAt: string }
  lastUpdated: string
  error?: string
}

let cachedUsage: UsageStats | null = null
let nextFetchAt = 0
const CACHE_TTL_MS = 5 * 60_000          // 5 min normal interval
const BACKOFF_BASE_MS = 60_000            // 60s base on 429
const BACKOFF_MAX_MS = 5 * 60_000         // 5 min max backoff
let consecutiveErrors = 0

export function getUsageStats(): UsageStats {
  const now = Date.now()
  if (now < nextFetchAt) {
    return cachedUsage || { lastUpdated: '' }
  }

  const result = fetchUsage()

  if (result.error) {
    consecutiveErrors++
    // Exponential backoff: 60s, 120s, 240s, 300s (cap)
    const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveErrors - 1), BACKOFF_MAX_MS)
    nextFetchAt = now + backoff
    // Keep last successful data in memory
    if (cachedUsage?.fiveHour) return cachedUsage
    return result
  }

  consecutiveErrors = 0
  nextFetchAt = now + CACHE_TTL_MS
  cachedUsage = result
  return cachedUsage
}

function fetchUsage(): UsageStats {
  try {
    const creds = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', timeout: 3000 },
    ).trim()
    const { claudeAiOauth } = JSON.parse(creds)
    if (!claudeAiOauth?.accessToken) {
      return { lastUpdated: new Date().toISOString(), error: 'No OAuth token' }
    }

    const res = execSync(
      `curl -s -H "Authorization: Bearer ${claudeAiOauth.accessToken}" -H "anthropic-beta: oauth-2025-04-20" -H "User-Agent: claude-code/2.1" "https://api.anthropic.com/api/oauth/usage"`,
      { encoding: 'utf8', timeout: 10000 },
    )
    const data = JSON.parse(res)

    if (data.error) {
      return { lastUpdated: new Date().toISOString(), error: data.error.message || 'API error' }
    }

    return {
      fiveHour: data.five_hour ? {
        utilization: data.five_hour.utilization,
        resetsAt: data.five_hour.resets_at,
      } : undefined,
      sevenDay: data.seven_day ? {
        utilization: data.seven_day.utilization,
        resetsAt: data.seven_day.resets_at,
      } : undefined,
      lastUpdated: new Date().toISOString(),
    }
  } catch (err: any) {
    return { lastUpdated: new Date().toISOString(), error: err.message }
  }
}
