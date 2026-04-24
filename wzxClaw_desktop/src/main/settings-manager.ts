/**
 * SettingsManager — Persistent settings with Electron safeStorage encryption
 * for API keys (per D-66).
 *
 * Settings (non-sensitive) stored as JSON in userData/settings.json.
 * API keys (sensitive) encrypted via safeStorage and stored in userData/keys.enc.
 */

import { safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { getSettingsPath, getKeysPath, getBackupsDir } from './paths'

interface StoredSettings {
  provider: string
  model: string
  baseURL?: string
  systemPrompt?: string
  relayToken?: string
  lastWorkspacePath?: string
  recentWorkspaces?: string[]
  lastSessionId?: string
  alwaysAllowRules?: string[]
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'
}

interface EncryptedKeys {
  [provider: string]: string // base64-encoded encrypted buffer
}

export interface SettingsResponse {
  provider: string
  model: string
  hasApiKey: boolean
  baseURL?: string
  systemPrompt?: string
  relayToken?: string
  thinkingDepth?: string
}

export interface FullConfig {
  provider: string
  model: string
  apiKey: string | undefined
  baseURL?: string
  systemPrompt?: string
  thinkingDepth?: string
}

export class SettingsManager {
  private settingsPath: string
  private keysPath: string
  private settings: StoredSettings
  private decryptedKeys: Map<string, string> = new Map()

  constructor() {
    this.settingsPath = getSettingsPath()
    this.keysPath = getKeysPath()
    this.settings = {
      provider: 'anthropic',
      model: 'glm-5.1',
      baseURL: 'https://open.bigmodel.cn/api/anthropic'
    }
    // No default API key — users must configure their own via the Settings UI
  }

  /**
   * Load settings from disk. Call once at app startup.
   */
  load(): void {
    // Load non-sensitive settings
    if (fs.existsSync(this.settingsPath)) {
      try {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8')
        const parsed = JSON.parse(raw) as StoredSettings
        this.settings = {
          provider: parsed.provider ?? 'anthropic',
          model: parsed.model ?? 'glm-5.1',
          baseURL: parsed.baseURL,
          systemPrompt: parsed.systemPrompt,
          relayToken: parsed.relayToken,
          lastWorkspacePath: parsed.lastWorkspacePath,
          recentWorkspaces: parsed.recentWorkspaces,
          lastSessionId: parsed.lastSessionId,
          alwaysAllowRules: parsed.alwaysAllowRules,
          thinkingDepth: parsed.thinkingDepth
        }
      } catch (err) {
        console.error('Failed to load settings.json:', err)
      }
    }

    // Load encrypted API keys
    if (fs.existsSync(this.keysPath)) {
      try {
        const raw = fs.readFileSync(this.keysPath, 'utf-8')
        const encrypted: EncryptedKeys = JSON.parse(raw)

        for (const [provider, base64Encrypted] of Object.entries(encrypted)) {
          try {
            const encryptedBuf = Buffer.from(base64Encrypted, 'base64')
            if (safeStorage.isEncryptionAvailable()) {
              const plaintext = safeStorage.decryptString(encryptedBuf)
              this.decryptedKeys.set(provider, plaintext)
            } else {
              // Fallback: on systems without safeStorage, keys are stored as plaintext
              console.warn(
                `safeStorage unavailable — API key for ${provider} may be stored insecurely`
              )
              this.decryptedKeys.set(provider, base64Encrypted)
            }
          } catch (decryptErr) {
            console.error(`Failed to decrypt API key for ${provider}:`, decryptErr)
          }
        }
      } catch (err) {
        console.error('Failed to load keys.enc:', err)
      }
    }
  }

  /**
   * Rotate settings backup — keep last 5 copies in backups/.
   * Called before each save. Failures are silently ignored.
   */
  private rotateBackup(): void {
    try {
      if (!fs.existsSync(this.settingsPath)) return
      const backupsDir = getBackupsDir()
      if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true })
      }
      const dest = path.join(backupsDir, `settings-${Date.now()}.json`)
      fs.copyFileSync(this.settingsPath, dest)

      // Prune old backups — keep newest 5
      const entries = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('settings-') && f.endsWith('.json'))
        .sort()
      if (entries.length > 5) {
        for (const old of entries.slice(0, entries.length - 5)) {
          try { fs.unlinkSync(path.join(backupsDir, old)) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore backup errors */ }
  }

  /**
   * Save current settings and encrypted keys to disk.
   */
  save(): void {
    this.rotateBackup()
    // Save non-sensitive settings
    try {
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save settings.json:', err)
    }

    // Save encrypted API keys
    try {
      const encrypted: EncryptedKeys = {}
      for (const [provider, plaintext] of this.decryptedKeys.entries()) {
        if (safeStorage.isEncryptionAvailable()) {
          const encryptedBuf = safeStorage.encryptString(plaintext)
          encrypted[provider] = encryptedBuf.toString('base64')
        } else {
          // Fallback: store as plaintext (base64 of the key string)
          console.warn(`safeStorage unavailable — storing API key for ${provider} as plaintext`)
          encrypted[provider] = Buffer.from(plaintext, 'utf-8').toString('base64')
        }
      }
      fs.writeFileSync(this.keysPath, JSON.stringify(encrypted, null, 2), 'utf-8')
    } catch (err) {
      console.error('Failed to save keys.enc:', err)
    }
  }

  /**
   * Get settings for the renderer (no API key exposed).
   */
  getSettings(): SettingsResponse {
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      hasApiKey: !!this.getApiKey(this.settings.provider),
      baseURL: this.settings.baseURL,
      systemPrompt: this.settings.systemPrompt,
      relayToken: this.settings.relayToken,
      thinkingDepth: this.settings.thinkingDepth
    }
  }

  /**
   * Update settings from the renderer.
   */
  updateSettings(request: {
    provider?: string
    model?: string
    apiKey?: string
    baseURL?: string
    systemPrompt?: string
    relayToken?: string
    thinkingDepth?: string
  }): void {
    if (request.provider !== undefined) this.settings.provider = request.provider
    if (request.model !== undefined) this.settings.model = request.model
    // 空字符串表示用户主动清除自定义 URL，存为 undefined
    if (request.baseURL !== undefined) this.settings.baseURL = request.baseURL || undefined
    if (request.systemPrompt !== undefined) this.settings.systemPrompt = request.systemPrompt
    if (request.relayToken !== undefined) this.setRelayToken(request.relayToken)
    if (request.thinkingDepth !== undefined) this.settings.thinkingDepth = request.thinkingDepth as StoredSettings['thinkingDepth']

    if (request.apiKey) {
      this.decryptedKeys.set(this.settings.provider, request.apiKey)
    }

    this.save()
  }

  /**
   * Get decrypted API key for a specific provider.
   * Falls back to environment variables when no key is stored:
   *   anthropic: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY
   *   openai:    OPENAI_API_KEY
   */
  getApiKey(provider: string): string | undefined {
    const stored = this.decryptedKeys.get(provider)
    if (stored) return stored
    // Env var fallback
    if (provider === 'anthropic') {
      return process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
    }
    return process.env.OPENAI_API_KEY
  }

  getRelayToken(): string | undefined {
    return this.settings.relayToken
  }

  setRelayToken(token: string): void {
    this.settings.relayToken = token
    this.save()
  }

  getLastWorkspacePath(): string | undefined {
    return this.settings.lastWorkspacePath
  }

  setLastWorkspacePath(wsPath: string): void {
    this.settings.lastWorkspacePath = wsPath
    this.addRecentWorkspace(wsPath)
  }

  getLastSessionId(): string | undefined {
    return this.settings.lastSessionId
  }

  setLastSessionId(sessionId: string): void {
    this.settings.lastSessionId = sessionId
    this.save()
  }

  getRecentWorkspaces(): string[] {
    return this.settings.recentWorkspaces ?? []
  }

  addRecentWorkspace(wsPath: string): void {
    const recent = this.settings.recentWorkspaces ?? []
    // Remove if already exists (will re-add at front)
    const filtered = recent.filter(p => p !== wsPath)
    filtered.unshift(wsPath)
    // Keep at most 10
    this.settings.recentWorkspaces = filtered.slice(0, 10)
    this.save()
  }

  getAlwaysAllowRules(): string[] {
    return this.settings.alwaysAllowRules ?? []
  }

  saveAlwaysAllowRules(rules: string[]): void {
    this.settings.alwaysAllowRules = rules
    this.save()
  }

  /**
   * Get full configuration for LLM gateway (includes API key).
   */
  getCurrentConfig(): FullConfig {
    const provider = this.settings.provider
    const baseURL = this.settings.baseURL
      || (provider === 'anthropic' ? process.env.ANTHROPIC_BASE_URL : undefined)
    return {
      provider,
      model: this.settings.model,
      apiKey: this.getApiKey(provider),
      baseURL,
      systemPrompt: this.settings.systemPrompt,
      thinkingDepth: this.settings.thinkingDepth
    }
  }
}
