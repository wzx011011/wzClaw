import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  DEFAULT_HAND_CONFIG,
  loadHandConfig,
  getEnabledTools,
  isToolEnabled,
  getToolConfig,
  getConfigDir,
  getHandConfigPath,
  getMcpConfigPath,
} from './hand-config-loader.js'

describe('hand-config-loader', () => {
  describe('getConfigDir', () => {
    const origEnv = process.env.WZXCLAW_CONFIG_DIR

    afterEach(() => {
      if (origEnv === undefined) {
        delete process.env.WZXCLAW_CONFIG_DIR
      } else {
        process.env.WZXCLAW_CONFIG_DIR = origEnv
      }
    })

    it('uses WZXCLAW_CONFIG_DIR env when set', () => {
      process.env.WZXCLAW_CONFIG_DIR = '/custom/config'
      expect(getConfigDir()).toBe('/custom/config')
    })

    it('defaults to ~/.wzxclaw', () => {
      delete process.env.WZXCLAW_CONFIG_DIR
      expect(getConfigDir()).toBe(path.join(os.homedir(), '.wzxclaw'))
    })
  })

  describe('getHandConfigPath', () => {
    it('returns configDir/hand.config.json', () => {
      expect(getHandConfigPath('/data/.wzxclaw')).toBe(path.join('/data/.wzxclaw', 'hand.config.json'))
    })
  })

  describe('getMcpConfigPath', () => {
    it('returns configDir/mcp.json', () => {
      expect(getMcpConfigPath('/data/.wzxclaw')).toBe(path.join('/data/.wzxclaw', 'mcp.json'))
    })
  })

  describe('DEFAULT_HAND_CONFIG', () => {
    it('has FileRead enabled', () => {
      expect(DEFAULT_HAND_CONFIG.builtinTools.FileRead.enabled).toBe(true)
    })

    it('has ShellExecute disabled by default', () => {
      expect(DEFAULT_HAND_CONFIG.builtinTools.ShellExecute.enabled).toBe(false)
    })

    it('has ShellExecute denyPrefixes', () => {
      expect(DEFAULT_HAND_CONFIG.builtinTools.ShellExecute.denyPrefixes).toContain('rm -rf /')
    })
  })

  describe('loadHandConfig', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hand-config-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns default config when file does not exist', () => {
      const config = loadHandConfig(path.join(tmpDir, 'nonexistent.json'))
      expect(config.builtinTools.FileRead.enabled).toBe(true)
    })

    it('returns default config when JSON is invalid', () => {
      const filePath = path.join(tmpDir, 'bad.json')
      fs.writeFileSync(filePath, 'not json {{{')
      const config = loadHandConfig(filePath)
      expect(config.builtinTools.FileRead.enabled).toBe(true)
    })

    it('merges user config with defaults', () => {
      const filePath = path.join(tmpDir, 'config.json')
      fs.writeFileSync(filePath, JSON.stringify({
        builtinTools: {
          ShellExecute: { enabled: true, timeout: 60 },
        },
      }))
      const config = loadHandConfig(filePath)

      // User override
      expect(config.builtinTools.ShellExecute.enabled).toBe(true)
      expect(config.builtinTools.ShellExecute.timeout).toBe(60)
      // Default preserved for tools not overridden
      expect(config.builtinTools.FileRead.enabled).toBe(true)
      // ShellExecute still has denyPrefixes from defaults
      expect(config.builtinTools.ShellExecute.denyPrefixes).toBeDefined()
    })

    it('handles empty builtinTools', () => {
      const filePath = path.join(tmpDir, 'empty.json')
      fs.writeFileSync(filePath, JSON.stringify({ builtinTools: {} }))
      const config = loadHandConfig(filePath)
      // Defaults still applied
      expect(config.builtinTools.FileRead.enabled).toBe(true)
    })

    it('handles missing builtinTools field', () => {
      const filePath = path.join(tmpDir, 'nobuiltin.json')
      fs.writeFileSync(filePath, JSON.stringify({ other: true }))
      const config = loadHandConfig(filePath)
      expect(config.builtinTools.FileRead.enabled).toBe(true)
    })

    it('disables tool when user sets enabled: false', () => {
      const filePath = path.join(tmpDir, 'disabled.json')
      fs.writeFileSync(filePath, JSON.stringify({
        builtinTools: { FileRead: { enabled: false } },
      }))
      const config = loadHandConfig(filePath)
      expect(config.builtinTools.FileRead.enabled).toBe(false)
    })
  })

  describe('getEnabledTools', () => {
    it('returns only enabled tools from default config', () => {
      const enabled = getEnabledTools(DEFAULT_HAND_CONFIG)
      expect(enabled).toContain('FileRead')
      expect(enabled).toContain('FileWrite')
      expect(enabled).toContain('FileList')
      expect(enabled).toContain('Echo')
      expect(enabled).not.toContain('ShellExecute')
    })
  })

  describe('isToolEnabled', () => {
    it('returns true for enabled tools', () => {
      expect(isToolEnabled(DEFAULT_HAND_CONFIG, 'FileRead')).toBe(true)
    })

    it('returns false for disabled tools', () => {
      expect(isToolEnabled(DEFAULT_HAND_CONFIG, 'ShellExecute')).toBe(false)
    })

    it('returns false for unknown tools', () => {
      expect(isToolEnabled(DEFAULT_HAND_CONFIG, 'UnknownTool')).toBe(false)
    })
  })

  describe('getToolConfig', () => {
    it('returns config for known tool', () => {
      const cfg = getToolConfig(DEFAULT_HAND_CONFIG, 'ShellExecute')
      expect(cfg).toBeDefined()
      expect(cfg!.timeout).toBe(30)
    })

    it('returns undefined for unknown tool', () => {
      expect(getToolConfig(DEFAULT_HAND_CONFIG, 'Unknown')).toBeUndefined()
    })
  })
})
