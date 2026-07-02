import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 项目级密钥/本地配置读取。
 * 约定（见 CLAUDE.md）：先读 process.env.X，再 fallback 到 .secrets/keys.env。
 * keys.env 修改后需重启 hub 生效。
 */

// shared/ 在 src(或 dist) 下一层，项目根在两级之上
const PROJECT_ROOT = resolve(import.meta.dirname!, '..', '..')
export const SECRETS_FILE = join(PROJECT_ROOT, '.secrets', 'keys.env')

export function parseEnvFile(path: string): Record<string, string> {
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

/** process.env 优先，fallback 到 keys.env；两处都没有返回 undefined */
export function getSecret(key: string, secretsFile: string = SECRETS_FILE): string | undefined {
  const fromEnv = process.env[key]?.trim()
  if (fromEnv) return fromEnv
  const fromFile = parseEnvFile(secretsFile)[key]?.trim()
  return fromFile || undefined
}
