import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// We test saveCredentials / loadCredentials by overriding the module-level
// CRED_DIR and CRED_PATH constants at runtime.  Since those are plain `const`
// bindings (not re-assignable), we use a dynamic import trick: we patch
// `os.homedir()` before importing so the module computes paths under our tmp dir.

let saveCredentials: typeof import('../plugins/weixin/qr-login.js').saveCredentials
let loadCredentials: typeof import('../plugins/weixin/qr-login.js').loadCredentials
let CRED_DIR: string
let CRED_PATH: string
let tmpHome: string

beforeEach(async () => {
  // Create an isolated temp dir that acts as $HOME for this test run
  tmpHome = join(tmpdir(), `cc2im-test-${randomUUID()}`)
  mkdirSync(tmpHome, { recursive: true })

  // Dynamically import with a unique query param so each test gets a fresh module
  // We need to mock homedir — vitest module mocking is the cleanest way.
  const { vi } = await import('vitest')
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os')
    return { ...actual, homedir: () => tmpHome }
  })

  // Force fresh import of qr-login so it picks up the mocked homedir
  const mod = await import('../plugins/weixin/qr-login.js')
  saveCredentials = mod.saveCredentials
  loadCredentials = mod.loadCredentials
  CRED_DIR = join(tmpHome, '.weixin-bot')
  CRED_PATH = join(CRED_DIR, 'credentials.json')
})

afterEach(async () => {
  const { vi } = await import('vitest')
  vi.restoreAllMocks()
  vi.resetModules()
  // Clean up temp dir
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
})

const fakeCreds = {
  token: 'tok_abc',
  baseUrl: 'https://example.com',
  accountId: 'acct_1',
  userId: 'usr_1',
}

const fakeCreds2 = {
  token: 'tok_xyz',
  baseUrl: 'https://example.com',
  accountId: 'acct_2',
  userId: 'usr_2',
}

describe('saveCredentials', () => {
  it('writes global credentials.json when no channelId', () => {
    saveCredentials(fakeCreds)
    expect(existsSync(CRED_PATH)).toBe(true)
    const saved = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
    expect(saved).toEqual(fakeCreds)
  })

  it('writes both global and per-channel file when channelId provided', () => {
    saveCredentials(fakeCreds, 'weixin-roxor')
    // Global file written
    expect(existsSync(CRED_PATH)).toBe(true)
    const globalSaved = JSON.parse(readFileSync(CRED_PATH, 'utf8'))
    expect(globalSaved).toEqual(fakeCreds)
    // Per-channel file written
    const channelPath = join(CRED_DIR, 'credentials-weixin-roxor.json')
    expect(existsSync(channelPath)).toBe(true)
    const channelSaved = JSON.parse(readFileSync(channelPath, 'utf8'))
    expect(channelSaved).toEqual(fakeCreds)
  })

  it('creates .weixin-bot directory if not exists', () => {
    expect(existsSync(CRED_DIR)).toBe(false)
    saveCredentials(fakeCreds)
    expect(existsSync(CRED_DIR)).toBe(true)
  })
})

describe('loadCredentials', () => {
  it('returns null when no credentials exist', () => {
    expect(loadCredentials()).toBeNull()
    expect(loadCredentials('weixin-roxor')).toBeNull()
  })

  it('returns global credentials when no channelId', () => {
    saveCredentials(fakeCreds)
    const loaded = loadCredentials()
    expect(loaded).toEqual(fakeCreds)
  })

  it('returns per-channel credentials when channelId has its own file', () => {
    // Save different creds for channel vs global
    saveCredentials(fakeCreds)
    saveCredentials(fakeCreds2, 'weixin-family')
    // Channel-specific load should return channel creds, not global
    const loaded = loadCredentials('weixin-family')
    expect(loaded).toEqual(fakeCreds2)
  })

  it('falls back to global when per-channel file does not exist', () => {
    saveCredentials(fakeCreds)
    // No per-channel file for 'weixin-missing'
    const loaded = loadCredentials('weixin-missing')
    expect(loaded).toEqual(fakeCreds)
  })

  it('per-channel file takes priority over global', () => {
    // Global gets overwritten by second save, but per-channel stays
    saveCredentials(fakeCreds, 'weixin-roxor')
    saveCredentials(fakeCreds2, 'weixin-family')
    // Global now has fakeCreds2 (last write wins)
    const globalLoaded = loadCredentials()
    expect(globalLoaded).toEqual(fakeCreds2)
    // Per-channel for roxor still has fakeCreds
    const roxorLoaded = loadCredentials('weixin-roxor')
    expect(roxorLoaded).toEqual(fakeCreds)
    // Per-channel for family has fakeCreds2
    const familyLoaded = loadCredentials('weixin-family')
    expect(familyLoaded).toEqual(fakeCreds2)
  })
})
