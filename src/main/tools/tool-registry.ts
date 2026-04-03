import type { Tool } from './tool-interface'
import type { ToolDefinition } from '../../shared/types'
import { toDefinition } from './tool-interface'

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

export function createDefaultTools(workingDirectory: string): ToolRegistry {
  // Stub - not implemented yet
  return new ToolRegistry()
}
