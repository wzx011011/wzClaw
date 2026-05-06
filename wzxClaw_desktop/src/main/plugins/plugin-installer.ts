// ============================================================
// Plugin Installer — install plugins from git/npm/url sources
// Modeled after Claude Code's plugin installation flow
// ============================================================

import { execFile } from 'child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { join, basename } from 'path'
import { getUserPluginsDir } from './plugin-loader'
import type { PluginInstallResult, MarketplacePluginSource } from '../../shared/types-plugin'

/**
 * PluginInstaller handles downloading plugins from various sources
 * and installing them into the appropriate plugins directory.
 */
export class PluginInstaller {
  /**
   * Install a plugin from a marketplace source definition.
   */
  static async fromMarketplaceSource(
    source: MarketplacePluginSource,
    scope: 'user' | 'project' = 'user',
    projectRoot?: string,
  ): Promise<PluginInstallResult> {
    switch (source.source) {
      case 'github':
        return PluginInstaller.fromGitHub(source.repo, source.ref, source.path, scope, projectRoot)
      case 'git':
        return PluginInstaller.fromGit(source.url, source.ref, scope, projectRoot)
      case 'npm':
        return PluginInstaller.fromNpm(source.package, source.version, scope, projectRoot)
      case 'url':
        return PluginInstaller.fromUrl(source.url, scope, projectRoot)
      default:
        return { success: false, message: `Unsupported source type: ${(source as Record<string, unknown>).source}` }
    }
  }

  /**
   * Install a plugin from a GitHub repository.
   * Uses git clone to download the repository.
   */
  static async fromGitHub(
    repo: string,
    ref?: string,
    subPath?: string,
    scope: 'user' | 'project' = 'user',
    projectRoot?: string,
  ): Promise<PluginInstallResult> {
    const url = `https://github.com/${repo}.git`
    return PluginInstaller.fromGit(url, ref, scope, projectRoot, subPath)
  }

  /**
   * Install a plugin from a git repository URL.
   * Clones the repo to a temp directory, then moves the plugin content
   * to the plugins directory.
   */
  static async fromGit(
    url: string,
    ref?: string,
    scope: 'user' | 'project' = 'user',
    projectRoot?: string,
    subPath?: string,
  ): Promise<PluginInstallResult> {
    const pluginsDir = PluginInstaller.getTargetDir(scope, projectRoot)
    const repoName = PluginInstaller.extractRepoName(url)
    const tempDir = join(pluginsDir, `.tmp-${repoName}-${Date.now()}`)

    try {
      // Ensure plugins directory exists
      mkdirSync(pluginsDir, { recursive: true })

      // Clone the repository
      const cloneArgs = ['clone', '--depth', '1']
      if (ref) {
        cloneArgs.push('--branch', ref)
      }
      cloneArgs.push(url, tempDir)

      await PluginInstaller.exec('git', cloneArgs)

      // Determine source directory
      const sourceDir = subPath ? join(tempDir, subPath) : tempDir
      if (!existsSync(sourceDir)) {
        throw new Error(`Path "${subPath}" not found in repository`)
      }

      // Determine plugin name from plugin.json or directory name
      const pluginName = await PluginInstaller.resolvePluginName(sourceDir, repoName)
      const targetDir = join(pluginsDir, pluginName)

      // Check if plugin already exists
      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }

      // Move plugin to target directory
      renameSync(sourceDir, targetDir)

      // Cleanup temp directory
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }

      return {
        success: true,
        message: `Plugin '${pluginName}' installed from ${url}`,
        pluginName,
        scope,
      }
    } catch (err) {
      // Cleanup on failure
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return {
        success: false,
        message: `Failed to install from git: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Install a plugin from an npm package.
   * Uses npm pack to download the package tarball, then extracts it.
   */
  static async fromNpm(
    packageName: string,
    version?: string,
    scope: 'user' | 'project' = 'user',
    projectRoot?: string,
  ): Promise<PluginInstallResult> {
    const pluginsDir = PluginInstaller.getTargetDir(scope, projectRoot)
    const packageSpec = version ? `${packageName}@${version}` : packageName
    const tempDir = join(pluginsDir, `.tmp-npm-${Date.now()}`)

    try {
      mkdirSync(pluginsDir, { recursive: true })
      mkdirSync(tempDir, { recursive: true })

      // Download package using npm pack
      await PluginInstaller.exec('npm', ['pack', packageSpec, '--pack-destination', tempDir])

      // Find the tarball
      const { readdirSync } = require('fs')
      const files = readdirSync(tempDir).filter((f: string) => f.endsWith('.tgz'))
      if (files.length === 0) {
        throw new Error('npm pack did not produce a tarball')
      }

      // Extract tarball
      const tarball = join(tempDir, files[0])
      await PluginInstaller.exec('tar', ['-xzf', tarball, '-C', tempDir])

      // npm pack extracts to "package/" subdirectory
      const extractedDir = join(tempDir, 'package')
      if (!existsSync(extractedDir)) {
        throw new Error('npm package did not contain expected directory structure')
      }

      const pluginName = await PluginInstaller.resolvePluginName(extractedDir, packageName.replace(/^@[^/]+\//, ''))
      const targetDir = join(pluginsDir, pluginName)

      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }

      renameSync(extractedDir, targetDir)
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }

      return {
        success: true,
        message: `Plugin '${pluginName}' installed from npm (${packageSpec})`,
        pluginName,
        scope,
      }
    } catch (err) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return {
        success: false,
        message: `Failed to install from npm: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  /**
   * Install a plugin from a URL (downloads a zip/tar archive).
   */
  static async fromUrl(
    url: string,
    scope: 'user' | 'project' = 'user',
    projectRoot?: string,
  ): Promise<PluginInstallResult> {
    // 安全检查：验证 URL 合法性，防止 SSRF
    const blocked = ['169.254.', '10.', '172.16.', '172.17.', '172.18.', '172.19.',
      '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
      '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
      '192.168.', '127.', '0.', 'localhost', '[::1]']
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { success: false, message: `Unsupported URL scheme: ${parsed.protocol}` }
      }
      if (blocked.some(prefix => parsed.hostname === prefix || parsed.hostname.startsWith(prefix))) {
        return { success: false, message: 'Cannot install from internal/local URLs' }
      }
    } catch {
      return { success: false, message: `Invalid URL: ${url}` }
    }

    const pluginsDir = PluginInstaller.getTargetDir(scope, projectRoot)
    const tempDir = join(pluginsDir, `.tmp-url-${Date.now()}`)
    const isZip = url.endsWith('.zip')
    const archiveName = isZip ? 'archive.zip' : 'archive.tar.gz'
    const archivePath = join(tempDir, archiveName)

    try {
      mkdirSync(pluginsDir, { recursive: true })
      mkdirSync(tempDir, { recursive: true })

      // Download using curl
      await PluginInstaller.exec('curl', ['-fsSL', '-o', archivePath, url])

      // Extract — zip 用 unzip，tar.gz 用 tar
      if (isZip) {
        await PluginInstaller.exec('unzip', ['-o', archivePath, '-d', tempDir])
      } else {
        await PluginInstaller.exec('tar', ['-xzf', archivePath, '-C', tempDir])
      }

      // Find the plugin directory (could be in a subdirectory)
      const { readdirSync } = require('fs')
      const entries = readdirSync(tempDir).filter((f: string) => f !== archiveName)
      const sourceDir = entries.length === 1 && existsSync(join(tempDir, entries[0]))
        ? join(tempDir, entries[0])
        : tempDir

      const pluginName = await PluginInstaller.resolvePluginName(sourceDir, basename(url).replace(/\.(zip|tar\.gz|tgz)$/, ''))
      const targetDir = join(pluginsDir, pluginName)

      if (existsSync(targetDir)) {
        rmSync(targetDir, { recursive: true, force: true })
      }

      renameSync(sourceDir, targetDir)
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }

      return {
        success: true,
        message: `Plugin '${pluginName}' installed from ${url}`,
        pluginName,
        scope,
      }
    } catch (err) {
      try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* ignore */ }
      return {
        success: false,
        message: `Failed to install from URL: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // ---- Helpers ----

  private static getTargetDir(scope: 'user' | 'project', projectRoot?: string): string {
    if (scope === 'project' && projectRoot) {
      return join(projectRoot, '.wzxclaw', 'plugins')
    }
    return getUserPluginsDir()
  }

  private static extractRepoName(url: string): string {
    // Extract name from https://github.com/user/repo.git or similar
    const match = url.match(/\/([^\/]+?)(\.git)?$/)
    return match?.[1] ?? 'plugin'
  }

  private static async resolvePluginName(dir: string, fallback: string): Promise<string> {
    const manifestPath = join(dir, 'plugin.json')
    if (existsSync(manifestPath)) {
      try {
        const { readFileSync } = require('fs')
        const raw = readFileSync(manifestPath, 'utf-8')
        const manifest = JSON.parse(raw)
        if (manifest.name && typeof manifest.name === 'string') {
          return manifest.name
        }
      } catch { /* use fallback */ }
    }
    return fallback
  }

  private static exec(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() ? `\n${stderr.trim().slice(0, 500)}` : ''
          reject(new Error(`${command} ${args.join(' ')} failed: ${error.message}${detail}`))
        } else {
          resolve()
        }
      })
    })
  }
}
