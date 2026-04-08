import type { Tool } from './tool-interface'
import type { ToolDefinition } from '../../shared/types'
import { toDefinition } from './tool-interface'
import { FileReadTool } from './file-read'
import { FileWriteTool } from './file-write'
import { FileEditTool } from './file-edit'
import { BashTool } from './bash'
import type { TerminalManager } from '../terminal/terminal-manager'
import { GrepTool } from './grep'
import { GlobTool } from './glob'
import { WebSearchTool } from './web-search'
import { WebFetchTool } from './web-fetch'
import { GoToDefinitionTool, FindReferencesTool, SearchSymbolsTool } from './symbol-nav'
import { CreateTaskTool } from './create-task'
import { UpdateTaskTool } from './update-task'
import { SemanticSearchTool } from './semantic-search'
import type { TaskManager } from '../tasks/task-manager'
import type { IndexingEngine } from '../indexing/indexing-engine'

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
 * Factory that creates a ToolRegistry with all tools.
 * Read-only tools: FileRead, Grep, Glob, WebSearch, WebFetch, SemanticSearch (no approval required)
 * Symbol tools: GoToDefinition, FindReferences, SearchSymbols (no approval required, requires Monaco IPC)
 * Destructive tools: FileWrite, FileEdit, Bash (requires approval per D-32)
 */
export function createDefaultTools(
  workingDirectory: string,
  terminalManager?: TerminalManager,
  getWebContents?: () => Electron.WebContents | null,
  taskManager?: TaskManager,
  indexingEngine?: IndexingEngine
): ToolRegistry {
  const registry = new ToolRegistry()

  // Read-only tools (no approval required)
  registry.register(new FileReadTool())
  registry.register(new GrepTool())
  registry.register(new GlobTool())

  // Semantic search tool (read-only, requires IndexingEngine)
  const semanticSearch = new SemanticSearchTool()
  if (indexingEngine) {
    semanticSearch.setIndexingEngine(indexingEngine)
  }
  registry.register(semanticSearch)

  // Web tools (read-only, no approval required)
  registry.register(new WebSearchTool())
  registry.register(new WebFetchTool())

  // Symbol navigation tools (read-only, requires Monaco IPC)
  if (getWebContents) {
    registry.register(new GoToDefinitionTool(getWebContents))
    registry.register(new FindReferencesTool(getWebContents))
    registry.register(new SearchSymbolsTool(getWebContents))
  }

  // Task tools (no approval required)
  if (taskManager && getWebContents) {
    registry.register(new CreateTaskTool(taskManager, getWebContents))
    registry.register(new UpdateTaskTool(taskManager, getWebContents))
  }

  // Destructive tools (requires approval per D-32)
  registry.register(new FileWriteTool())
  registry.register(new FileEditTool())
  registry.register(new BashTool(workingDirectory, terminalManager))

  return registry
}
