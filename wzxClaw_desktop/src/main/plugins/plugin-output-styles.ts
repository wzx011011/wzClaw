// ============================================================
// Plugin Output Styles — load CSS/style definitions from plugins
// Modeled after Claude Code's output style loading
// ============================================================

import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import type { LoadedPlugin } from '../../shared/types-plugin'

/**
 * A loaded output style from a plugin.
 */
export interface OutputStyle {
  /** Unique name: pluginName:styleName */
  name: string
  /** Display name */
  displayName: string
  /** Plugin source */
  pluginName: string
  /** CSS content */
  css: string
  /** File path */
  filePath: string
}

export interface OutputStyleResult {
  styles: OutputStyle[]
  errors: Array<{ path: string; error: string }>
}

/**
 * Load all output styles from a plugin's output-styles/ directory.
 *
 * Supports:
 * - .css files (loaded as-is)
 * - .json files with { "css": "..." } structure
 */
export function loadOutputStyles(plugin: LoadedPlugin): OutputStyleResult {
  const errors: Array<{ path: string; error: string }> = []
  const styles: OutputStyle[] = []
  const pluginName = plugin.name

  if (!plugin.outputStylesPath || !existsSync(plugin.outputStylesPath)) {
    return { styles, errors }
  }

  const styleFiles = walkDirForStyles(plugin.outputStylesPath)

  for (const filePath of styleFiles) {
    try {
      const style = loadStyleFile(filePath, plugin.outputStylesPath!, pluginName)
      if (style) {
        styles.push(style)
      }
    } catch (err) {
      errors.push({ path: filePath, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { styles, errors }
}

/**
 * Load a single style file.
 */
function loadStyleFile(
  filePath: string,
  baseDir: string,
  pluginName: string,
): OutputStyle | null {
  const fileName = basename(filePath)
  const ext = fileName.split('.').pop()?.toLowerCase()

  if (ext === 'css') {
    const css = readFileSync(filePath, 'utf-8')
    const styleName = fileName.replace(/\.css$/i, '')
    return {
      name: `${pluginName}:${styleName}`,
      displayName: styleName,
      pluginName,
      css,
      filePath,
    }
  }

  if (ext === 'json') {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const css = parsed.css ?? parsed.styles ?? ''
      if (typeof css !== 'string' || !css.trim()) return null
      const styleName = fileName.replace(/\.json$/i, '')
      return {
        name: `${pluginName}:${styleName}`,
        displayName: parsed.name ?? styleName,
        pluginName,
        css,
        filePath,
      }
    } catch {
      return null
    }
  }

  return null
}

/**
 * Get all output styles from all enabled plugins, merged into a single CSS string.
 * This is the main entry point for the renderer to consume.
 */
export function getAllOutputStylesCss(plugins: LoadedPlugin[]): { css: string; styleNames: string[] } {
  const allCss: string[] = []
  const styleNames: string[] = []

  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    const result = loadOutputStyles(plugin)
    for (const style of result.styles) {
      allCss.push(`/* Plugin: ${style.pluginName} — Style: ${style.displayName} */\n${style.css}`)
      styleNames.push(style.name)
    }
  }

  return { css: allCss.join('\n\n'), styleNames }
}

// ---- Helpers ----

function walkDirForStyles(dir: string): string[] {
  const results: string[] = []

  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return results
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    let stat: { isDirectory(): boolean }
    try {
      stat = statSync(fullPath)
    } catch {
      continue
    }

    if (stat.isDirectory()) {
      results.push(...walkDirForStyles(fullPath))
    } else if (entry.endsWith('.css') || entry.endsWith('.json')) {
      results.push(fullPath)
    }
  }

  return results
}
