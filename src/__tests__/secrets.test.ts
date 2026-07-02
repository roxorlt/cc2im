import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEnvFile, getSecret } from '../shared/secrets.js'
import { parseAllowedUsers } from '../plugins/weixin/connection.js'

function tmpEnvFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc2im-secrets-'))
  const path = join(dir, 'keys.env')
  writeFileSync(path, content)
  return path
}

describe('parseEnvFile', () => {
  it('parses KEY=value lines', () => {
    const path = tmpEnvFile('FOO=bar\nBAZ=qux\n')
    expect(parseEnvFile(path)).toEqual({ FOO: 'bar', BAZ: 'qux' })
    rmSync(path, { force: true })
  })

  it('skips comments and blank lines', () => {
    const path = tmpEnvFile('# comment\n\nFOO=bar\n  # indented comment\n')
    expect(parseEnvFile(path)).toEqual({ FOO: 'bar' })
    rmSync(path, { force: true })
  })

  it('strips surrounding quotes', () => {
    const path = tmpEnvFile('A="quoted"\nB=\'single\'\n')
    expect(parseEnvFile(path)).toEqual({ A: 'quoted', B: 'single' })
    rmSync(path, { force: true })
  })

  it('keeps = inside values', () => {
    const path = tmpEnvFile('URL=https://x.com/?a=1&b=2\n')
    expect(parseEnvFile(path)).toEqual({ URL: 'https://x.com/?a=1&b=2' })
    rmSync(path, { force: true })
  })

  it('returns empty object for missing file', () => {
    expect(parseEnvFile('/nonexistent/keys.env')).toEqual({})
  })
})

describe('getSecret', () => {
  afterEach(() => {
    delete process.env.CC2IM_TEST_SECRET
  })

  it('prefers process.env over file', () => {
    const path = tmpEnvFile('CC2IM_TEST_SECRET=from-file\n')
    process.env.CC2IM_TEST_SECRET = 'from-env'
    expect(getSecret('CC2IM_TEST_SECRET', path)).toBe('from-env')
    rmSync(path, { force: true })
  })

  it('falls back to file when env unset', () => {
    const path = tmpEnvFile('CC2IM_TEST_SECRET=from-file\n')
    expect(getSecret('CC2IM_TEST_SECRET', path)).toBe('from-file')
    rmSync(path, { force: true })
  })

  it('returns undefined when neither set', () => {
    const path = tmpEnvFile('OTHER=x\n')
    expect(getSecret('CC2IM_TEST_SECRET', path)).toBeUndefined()
    rmSync(path, { force: true })
  })

  it('treats whitespace-only env as unset', () => {
    const path = tmpEnvFile('CC2IM_TEST_SECRET=from-file\n')
    process.env.CC2IM_TEST_SECRET = '   '
    expect(getSecret('CC2IM_TEST_SECRET', path)).toBe('from-file')
    rmSync(path, { force: true })
  })
})

describe('parseAllowedUsers', () => {
  it('splits comma-separated ids and trims', () => {
    expect(parseAllowedUsers('a@im.wechat, b@im.wechat')).toEqual(['a@im.wechat', 'b@im.wechat'])
  })

  it('drops empty segments', () => {
    expect(parseAllowedUsers('a@im.wechat,,')).toEqual(['a@im.wechat'])
  })

  it('returns [] for undefined or empty', () => {
    expect(parseAllowedUsers(undefined)).toEqual([])
    expect(parseAllowedUsers('')).toEqual([])
  })
})
