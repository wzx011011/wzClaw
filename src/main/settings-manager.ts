/**
 * SettingsManager — Persistent settings with Electron safeStorage encryption
 * for API keys (per D-66).
 *
 * Settings (non-sensitive) stored as JSON in userData/settings.json.
 * API keys (sensitive) encrypted via safeStorage and stored in userData/keys.enc.
 */

import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'

interface StoredSettings {
  provider: string
  model: string
  baseURL?: string
  systemPrompt?: string
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
}

export interface FullConfig {
  provider: string
  model: string
  apiKey: string | undefined
  baseURL?: string
  systemPrompt?: string
}

export class SettingsManager {
  private settingsPath: string
  private keysPath: string
  private settings: StoredSettings
  private decryptedKeys: Map<string, string> = new Map()

  constructor() {
    const userDataPath = app.getPath('userData')
    this.settingsPath = path.join(userDataPath, 'settings.json')
    this.keysPath = path.join(userDataPath, 'keys.enc')
    this.settings = {
      provider: 'openai',
      model: 'gpt-4o'
    }
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
          provider: parsed.provider ?? 'openai',
          model: parsed.model ?? 'gpt-4o',
          baseURL: parsed.baseURL,
          systemPrompt: parsed.systemPrompt
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
   * Save current settings and encrypted keys to disk.
   */
  save(): void {
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
      hasApiKey: this.decryptedKeys.has(this.settings.provider),
      baseURL: this.settings.baseURL,
      systemPrompt: this.settings.systemPrompt
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
  }): void {
    if (request.provider !== undefined) this.settings.provider = request.provider
    if (request.model !== undefined) this.settings.model = request.model
    if (request.baseURL !== undefined) this.settings.baseURL = request.baseURL
    if (request.systemPrompt !== undefined) this.settings.systemPrompt = request.systemPrompt

    if (request.apiKey) {
      this.decryptedKeys.set(this.settings.provider, request.apiKey)
    }

    this.save()
  }

  /**
   * Get decrypted API key for a specific provider.
   */
  getApiKey(provider: string): string | undefined {
    return this.decryptedKeys.get(provider)
  }

  /**
   * Get full configuration for LLM gateway (includes API key).
   */
  getCurrentConfig(): FullConfig {
    return {
      provider: this.settings.provider,
      model: this.settings.model,
      apiKey: this.getApiKey(this.settings.provider),
      baseURL: this.settings.baseURL,
      systemPrompt: this.settings.systemPrompt
    }
  }
}
