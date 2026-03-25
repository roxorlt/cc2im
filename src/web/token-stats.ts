/**
 * Token Stats — parse transcript JSONL files for accurate token usage
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

export interface DailyTokens {
  date: string
  input: number       // input_tokens (non-cached)
  output: number      // output_tokens
  cacheRead: number   // cache_read_input_tokens
  cacheCreate: number // cache_creation_input_tokens
}

export interface TokenStats {
  daily: DailyTokens[]
  lastUpdated: string
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

  function scanDir(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { scanDir(full); continue }
      if (!entry.name.endsWith('.jsonl')) continue

      try {
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
  return { daily: sorted, lastUpdated: new Date().toISOString() }
}
