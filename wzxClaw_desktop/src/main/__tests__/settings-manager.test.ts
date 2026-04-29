import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsManager } from '../settings-manager'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/wzxclaw-settings-test'),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8')),
  },
}))

describe('SettingsManager DeepSeek API key handling', () => {
  let manager: SettingsManager

  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN

    manager = new SettingsManager()
    vi.spyOn(manager, 'save').mockImplementation(() => {})
  })

  it('does not send an Anthropic key to the DeepSeek Anthropic-compatible endpoint', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = { provider: 'anthropic', model: 'deepseek-v4-pro' }
    internals.decryptedKeys.set('anthropic', 'anthropic-key')
    internals.decryptedKeys.set('openai', 'legacy-deepseek-key')

    const config = manager.getCurrentConfig()

    expect(config.provider).toBe('anthropic')
    expect(config.baseURL).toBe('https://api.deepseek.com/anthropic')
    expect(config.apiKey).toBe('legacy-deepseek-key')
  })

  it('prefers the dedicated DeepSeek key over legacy OpenAI-compatible storage', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = { provider: 'anthropic', model: 'deepseek-v4-flash' }
    internals.decryptedKeys.set('deepseek', 'deepseek-key')
    internals.decryptedKeys.set('openai', 'legacy-key')
    internals.decryptedKeys.set('anthropic', 'anthropic-key')

    expect(manager.getCurrentConfig().apiKey).toBe('deepseek-key')
  })

  it('stores a submitted DeepSeek V4 key in the dedicated DeepSeek slot', () => {
    manager.updateSettings({
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      apiKey: 'new-deepseek-key',
    })

    const internals = manager as unknown as { decryptedKeys: Map<string, string> }

    expect(internals.decryptedKeys.get('deepseek')).toBe('new-deepseek-key')
    expect(internals.decryptedKeys.get('anthropic')).toBeUndefined()
  })

  it('does not report an Anthropic key as configured for DeepSeek V4', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = { provider: 'anthropic', model: 'deepseek-v4-pro' }
    internals.decryptedKeys.set('anthropic', 'anthropic-key')

    expect(manager.getSettings().hasApiKey).toBe(false)
  })
})