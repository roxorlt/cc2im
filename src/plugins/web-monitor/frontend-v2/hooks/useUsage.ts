import { useState, useEffect } from 'react'

export interface UsageStats {
  fiveHour?: { utilization: number; resetsAt: string }
  sevenDay?: { utilization: number; resetsAt: string }
  lastUpdated: string
  error?: string
}

export function useUsage(intervalMs = 60000) {
  const [usage, setUsage] = useState<UsageStats>({ lastUpdated: '' })

  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const res = await fetch('/api/usage')
        if (res.ok) setUsage(await res.json())
      } catch {}
    }

    fetchUsage()
    const timer = setInterval(fetchUsage, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return usage
}
