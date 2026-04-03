import type { Tool } from './tool-interface'
import type { ToolDefinition } from '../../shared/types'
import { toDefinition } from './tool-interface'
import { FileReadTool } from './file-read'
import { GrepTool } from './grep'
import { GlobTool } from './glob'

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map(toDefinition)
  }

  getApprovalRequired(): string[] {
    return this.getAll()
      .filter((tool) => tool.requiresApproval)
      .map((tool) => tool.name)
  }
}

/**
 * Factory that creates a ToolRegistry with the 3 read-only tools.
 * FileWrite, FileEdit, and Bash will be added in Plan 02.
 */
export function createDefaultTools(workingDirectory: string): ToolRegistry {
  const registry = new ToolRegistry()

  // Read-only tools (no approval required)
  registry.register(new FileReadTool())
  registry.register(new GrepTool())
  registry.register(new GlobTool())

  return registry
}
