import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { loadApiKeys, mergeWithEnv } from './api-keys'

describe('loadApiKeys', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-keys-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty object when file does not exist', () => {
    expect(loadApiKeys(tmpDir)).toEqual({})
  })

  it('reads valid api-keys.json', () => {
    const config = {
      anthropic: { apiKey: 'sk-ant-test', baseURL: 'https://api.test.com' },
      openai: { apiKey: 'sk-openai-test' },
    }
    fs.writeFileSync(path.join(tmpDir, 'api-keys.json'), JSON.stringify(config))
    expect(loadApiKeys(tmpDir)).toEqual(config)
  })

  it('returns empty object for malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'api-keys.json'), 'not json')
    expect(loadApiKeys(tmpDir)).toEqual({})
  })

  it('returns empty object for non-object JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'api-keys.json'), '"a string"')
    expect(loadApiKeys(tmpDir)).toEqual({})
  })
})

describe('mergeWithEnv', () => {
  const origEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
      origEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, val] of Object.entries(origEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
  })

  it('returns empty when no file keys and no env vars', () => {
    expect(mergeWithEnv({})).toEqual({})
  })

  it('uses file keys when no env vars', () => {
    const fileKeys = {
      anthropic: { apiKey: 'file-key', baseURL: 'https://file.test.com' },
    }
    expect(mergeWithEnv(fileKeys)).toEqual(fileKeys)
  })

  it('file keys override env vars', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'env-key'
    process.env.ANTHROPIC_BASE_URL = 'https://env.test.com'
    const result = mergeWithEnv({
      anthropic: { apiKey: 'file-key', baseURL: 'https://file.test.com' },
    })
    expect(result.anthropic?.apiKey).toBe('file-key')
    expect(result.anthropic?.baseURL).toBe('https://file.test.com')
  })

  it('ANTHROPIC_API_KEY as fallback when no AUTH_TOKEN', () => {
    process.env.ANTHROPIC_API_KEY = 'fallback-key'
    const result = mergeWithEnv({})
    expect(result.anthropic?.apiKey).toBe('fallback-key')
  })

  it('ANTHROPIC_AUTH_TOKEN takes precedence over ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'primary'
    process.env.ANTHROPIC_API_KEY = 'secondary'
    const result = mergeWithEnv({})
    expect(result.anthropic?.apiKey).toBe('primary')
  })

  it('file baseURL and key are used when env var is also present', () => {
    process.env.OPENAI_API_KEY = 'env-openai'
    const result = mergeWithEnv({
      openai: { apiKey: 'file-openai', baseURL: 'https://file.openai.com' },
    })
    expect(result.openai?.apiKey).toBe('file-openai')
    expect(result.openai?.baseURL).toBe('https://file.openai.com')
  })
})
