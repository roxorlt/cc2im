import { useState, useEffect } from 'react'

export interface StatsData {
  dailyActivity?: Array<{ date: string; messageCount: number; sessionCount: number; toolCallCount: number }>
  dailyModelTokens?: Array<{ date: string; tokensByModel: Record<string, number> }>
  modelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }>
}

export function useStats(intervalMs = 500) {
  const [stats, setStats] = useState<StatsData>({})

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/stats')
        if (res.ok) setStats(await res.json())
      } catch {}
    }

    fetchStats()
    const timer = setInterval(fetchStats, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return stats
}
