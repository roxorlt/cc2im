import { getSecret, SECRETS_FILE } from '../../shared/secrets.js'

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

function readApiKey(): string | null {
  return getSecret('DEEPSEEK_API_KEY') ?? null
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
