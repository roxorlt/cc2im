import { useState, useEffect } from 'react'

export interface DailyTokens {
  date: string
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

export interface TokenStats {
  daily: DailyTokens[]
  lastUpdated: string
}

export function useTokens(intervalMs = 5000) {
  const [tokens, setTokens] = useState<TokenStats>({ daily: [], lastUpdated: '' })

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const res = await fetch('/api/tokens')
        if (res.ok) setTokens(await res.json())
      } catch {}
    }

    fetchTokens()
    const timer = setInterval(fetchTokens, intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return tokens
}
