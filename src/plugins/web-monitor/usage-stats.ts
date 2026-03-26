import { execSync } from 'node:child_process'

export interface UsageStats {
  fiveHour?: { utilization: number; resetsAt: string }
  sevenDay?: { utilization: number; resetsAt: string }
  lastUpdated: string
  error?: string
}

let cachedUsage: UsageStats | null = null
let lastFetchTime = 0
const CACHE_TTL_MS = 5 * 60_000 // 5 minutes — avoid rate limiting

export function getUsageStats(): UsageStats {
  const now = Date.now()
  if (cachedUsage && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedUsage
  }
  cachedUsage = fetchUsage()
  lastFetchTime = now
  return cachedUsage
}

function fetchUsage(): UsageStats {
  try {
    const creds = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf8', timeout: 5000 },
    ).trim()
    const { claudeAiOauth } = JSON.parse(creds)
    if (!claudeAiOauth?.accessToken) {
      return { lastUpdated: new Date().toISOString(), error: 'No OAuth token found' }
    }

    const res = execSync(
      `curl -s -H "Authorization: Bearer ${claudeAiOauth.accessToken}" -H "anthropic-beta: oauth-2025-04-20" "https://api.anthropic.com/api/oauth/usage"`,
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
