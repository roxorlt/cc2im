import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface DeepseekBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export interface DeepseekBalance {
  isAvailable?: boolean
  balances?: DeepseekBalanceInfo[]
  lastUpdated: string
  error?: string
}

// Project root is 3 levels up from this file (src/plugins/web-monitor or dist/plugins/web-monitor).
const PROJECT_ROOT = resolve(import.meta.dirname!, '..', '..', '..')
const SECRETS_FILE = join(PROJECT_ROOT, '.secrets', 'keys.env')

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(path)) return out
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

function readApiKey(): string | null {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()
  const fileEnv = parseEnvFile(SECRETS_FILE)
  if (fileEnv.DEEPSEEK_API_KEY?.trim()) return fileEnv.DEEPSEEK_API_KEY.trim()
  return null
}

export async function getDeepseekBalance(): Promise<DeepseekBalance> {
  const apiKey = readApiKey()
  if (!apiKey) {
    return {
      lastUpdated: new Date().toISOString(),
      error: `请在 ${SECRETS_FILE} 中填写 DEEPSEEK_API_KEY=<你的key>`,
    }
  }

  try {
    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), 10000)
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        lastUpdated: new Date().toISOString(),
        error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      }
    }

    const data = await res.json() as {
      is_available?: boolean
      balance_infos?: Array<{
        currency: string
        total_balance: string
        granted_balance: string
        topped_up_balance: string
      }>
    }

    return {
      isAvailable: data.is_available,
      balances: (data.balance_infos || []).map(b => ({
        currency: b.currency,
        totalBalance: b.total_balance,
        grantedBalance: b.granted_balance,
        toppedUpBalance: b.topped_up_balance,
      })),
      lastUpdated: new Date().toISOString(),
    }
  } catch (err: any) {
    return {
      lastUpdated: new Date().toISOString(),
      error: err?.message || String(err),
    }
  }
}
