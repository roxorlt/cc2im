/**
 * Token Stats — parse transcript JSONL files for accurate token usage
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const pricingPath = join(import.meta.dirname!, 'pricing.json')
const pricing = JSON.parse(readFileSync(pricingPath, 'utf8'))

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // Only read files modified in last 30 days

export interface DailyTokens {
  date: string
  input: number       // input_tokens (non-cached)
  output: number      // output_tokens
  cacheRead: number   // cache_read_input_tokens
  cacheCreate: number // cache_creation_input_tokens
  cost?: number
}

export interface TokenStats {
  daily: DailyTokens[]
  lastUpdated: string
  todayCost?: number
  avgDailyCost?: number
  pricingDate?: string
}

let cachedStats: TokenStats | null = null
let lastComputeTime = 0
const CACHE_TTL_MS = 30_000 // Recompute at most every 30s (parsing ~800 files takes ~1.5s)

export function getTokenStats(): TokenStats {
  const now = Date.now()
  if (cachedStats && now - lastComputeTime < CACHE_TTL_MS) {
    return cachedStats
  }

  cachedStats = computeTokenStats()
  lastComputeTime = now
  return cachedStats
}

function computeTokenStats(): TokenStats {
  const daily = new Map<string, DailyTokens>()

  if (!existsSync(PROJECTS_DIR)) {
    return { daily: [], lastUpdated: new Date().toISOString() }
  }

  const cutoff = Date.now() - MAX_AGE_MS

  function scanDir(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { scanDir(full); continue }
      if (!entry.name.endsWith('.jsonl')) continue

      try {
        // Skip files not modified in the last 30 days
        if (statSync(full).mtimeMs < cutoff) continue

        const content = readFileSync(full, 'utf8')
        for (const line of content.split('\n')) {
          if (!line.includes('input_tokens')) continue
          try {
            const rec = JSON.parse(line)
            const u = rec.message?.usage
            if (!u) continue
            const date = rec.timestamp?.slice(0, 10)
            if (!date) continue

            const d = daily.get(date) || { date, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
            d.input += u.input_tokens || 0
            d.output += u.output_tokens || 0
            d.cacheRead += u.cache_read_input_tokens || 0
            d.cacheCreate += u.cache_creation_input_tokens || 0
            daily.set(date, d)
          } catch {}
        }
      } catch {}
    }
  }

  scanDir(PROJECTS_DIR)

  const sorted = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date))

  // Calculate cost per day using default Opus 4.6 pricing
  const p = pricing.models['claude-opus-4-6']
  for (const d of sorted) {
    d.cost = (d.input * p.input + d.output * p.output + d.cacheRead * p.cacheRead + d.cacheCreate * p.cacheCreate) / 1_000_000
  }

  const today = new Date().toISOString().split('T')[0]
  const todayData = sorted.find(d => d.date === today)
  const last30 = sorted.slice(-30)
  const totalCost = last30.reduce((s, d) => s + (d.cost || 0), 0)

  return {
    daily: sorted,
    lastUpdated: new Date().toISOString(),
    todayCost: todayData?.cost,
    avgDailyCost: last30.length > 0 ? totalCost / last30.length : undefined,
    pricingDate: pricing.lastChecked,
  }
}
