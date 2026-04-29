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
    delete process.env.GLM_API_KEY
    delete process.env.ZHIPU_API_KEY
    delete process.env.BIGMODEL_API_KEY
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
    expect(config.apiKey).toBeUndefined()
  })

  it('only reuses the OpenAI-compatible key for DeepSeek when the legacy base URL is DeepSeek', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string; baseURL?: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = {
      provider: 'openai',
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
    }
    internals.decryptedKeys.set('openai', 'legacy-deepseek-key')

    expect(manager.getCurrentConfig().apiKey).toBe('legacy-deepseek-key')
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

describe('SettingsManager GLM API key handling', () => {
  let manager: SettingsManager

  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.GLM_API_KEY
    delete process.env.ZHIPU_API_KEY
    delete process.env.BIGMODEL_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_AUTH_TOKEN

    manager = new SettingsManager()
    vi.spyOn(manager, 'save').mockImplementation(() => {})
  })

  it('forces GLM-5 models to use the GLM Anthropic-compatible endpoint', () => {
    manager.updateSettings({
      provider: 'anthropic',
      model: 'glm-5.1',
      baseURL: 'https://api.deepseek.com/anthropic',
      apiKey: 'glm-key',
    })

    const config = manager.getCurrentConfig()

    expect(config.provider).toBe('anthropic')
    expect(config.baseURL).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(config.apiKey).toBe('glm-key')
  })

  it('stores submitted GLM-5 keys in the dedicated GLM slot', () => {
    manager.updateSettings({
      provider: 'anthropic',
      model: 'glm-5-turbo',
      apiKey: 'new-glm-key',
    })

    const internals = manager as unknown as { decryptedKeys: Map<string, string> }

    expect(internals.decryptedKeys.get('glm')).toBe('new-glm-key')
    expect(internals.decryptedKeys.get('anthropic')).toBeUndefined()
  })

  it('does not report an Anthropic key as configured for GLM unless it is a legacy GLM config', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string; baseURL?: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = { provider: 'anthropic', model: 'glm-5.1' }
    internals.decryptedKeys.set('anthropic', 'anthropic-key')

    expect(manager.getSettings().hasApiKey).toBe(false)
  })

  it('keeps existing GLM users working when the old Anthropic slot was paired with the GLM base URL', () => {
    const internals = manager as unknown as {
      settings: { provider: string; model: string; baseURL?: string }
      decryptedKeys: Map<string, string>
    }
    internals.settings = {
      provider: 'anthropic',
      model: 'glm-5.1',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
    }
    internals.decryptedKeys.set('anthropic', 'legacy-glm-key')

    expect(manager.getCurrentConfig().apiKey).toBe('legacy-glm-key')
  })
})
