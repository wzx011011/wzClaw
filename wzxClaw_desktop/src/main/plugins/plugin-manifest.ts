// ============================================================
// Plugin Manifest — parse and validate plugin.json
// Modeled after Claude Code's schemas.ts + validatePlugin.ts
// ============================================================

import { existsSync, readFileSync } from 'fs'
import { join, isAbsolute } from 'path'
import { z } from 'zod'
import type { PluginManifest, PluginError } from '../../shared/types-plugin'

// ============================================================
// Zod Schemas
// ============================================================

const PluginAuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
})

const UserConfigOptionSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'directory', 'file']),
  title: z.string().min(1),
  description: z.string().min(1),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  multiple: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})

const McpServerConfigSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  transport: z.enum(['stdio', 'sse']).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

const CommandMetadataSchema = z.object({
  source: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
})

const PluginChannelSchema = z.object({
  server: z.string().min(1),
  displayName: z.string().optional(),
  userConfig: z.record(z.string(), UserConfigOptionSchema).optional(),
})

/**
 * Full plugin.json schema.
 * Unknown top-level fields are silently stripped (zod default).
 */
const PluginManifestSchema = z.object({
  name: z.string()
    .min(1, 'Plugin name cannot be empty')
    .refine(n => !n.includes(' '), { message: 'Plugin name cannot contain spaces' }),
  version: z.string().optional(),
  description: z.string().optional(),
  author: PluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),

  commands: z.union([
    z.string(),
    z.array(z.string()),
    z.record(z.string(), CommandMetadataSchema),
  ]).optional(),

  agents: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  outputStyles: z.union([z.string(), z.array(z.string())]).optional(),

  hooks: z.unknown().optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  lspServers: z.record(z.string(), z.unknown()).optional(),

  userConfig: z.record(
    z.string().regex(/^[A-Za-z_]\w*$/, 'Option keys must be valid identifiers'),
    UserConfigOptionSchema,
  ).optional(),

  channels: z.array(PluginChannelSchema).optional(),
  dependencies: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})

// ============================================================
// Parse result
// ============================================================

export interface ManifestParseResult {
  manifest: PluginManifest | null
  errors: PluginError[]
}

/**
 * Parse and validate a plugin.json file.
 *
 * @param pluginPath — absolute path to the plugin root directory
 * @returns parsed manifest or null with error details
 */
export function parsePluginManifest(pluginPath: string): ManifestParseResult {
  const errors: PluginError[] = []
  const manifestPath = join(pluginPath, 'plugin.json')

  // 1. Check file exists
  if (!existsSync(manifestPath)) {
    // Strict mode: plugin.json is required
    // Non-strict mode (marketplace entry with strict: false): return minimal manifest
    return {
      manifest: null,
      errors: [{ type: 'manifest-not-found', message: `plugin.json not found at ${manifestPath}` }],
    }
  }

  // 2. Read and parse JSON
  let rawJson: string
  try {
    rawJson = readFileSync(manifestPath, 'utf-8')
  } catch (err) {
    return {
      manifest: null,
      errors: [{
        type: 'manifest-parse-error',
        message: `Failed to read plugin.json: ${err instanceof Error ? err.message : String(err)}`,
      }],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    return {
      manifest: null,
      errors: [{
        type: 'manifest-parse-error',
        message: `Invalid JSON in plugin.json: ${err instanceof Error ? err.message : String(err)}`,
      }],
    }
  }

  // 3. Validate with zod
  const result = PluginManifestSchema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    return {
      manifest: null,
      errors: [{
        type: 'manifest-validation-error',
        message: `Plugin manifest validation failed`,
        detail,
      }],
    }
  }

  return {
    manifest: result.data as PluginManifest,
    errors,
  }
}

/**
 * Create a minimal manifest for plugins without plugin.json (non-strict mode).
 * Uses directory name as plugin name.
 */
export function createMinimalManifest(pluginPath: string): PluginManifest {
  const { basename } = require('path')
  return {
    name: basename(pluginPath),
    description: undefined,
  }
}

/**
 * Validate a plugin directory has the minimum required structure.
 * A valid plugin must have either:
 * - A plugin.json file, OR
 * - At least one component directory (commands/, skills/, agents/)
 */
export function isValidPluginDirectory(dirPath: string): boolean {
  if (!existsSync(dirPath)) return false

  // Has plugin.json → valid
  if (existsSync(join(dirPath, 'plugin.json'))) return true

  // Has any component directory → valid (non-strict)
  const componentDirs = ['commands', 'skills', 'agents', 'hooks', 'output-styles']
  for (const dir of componentDirs) {
    if (existsSync(join(dirPath, dir))) return true
  }

  // Has .mcp.json → valid
  if (existsSync(join(dirPath, '.mcp.json'))) return true

  return false
}
