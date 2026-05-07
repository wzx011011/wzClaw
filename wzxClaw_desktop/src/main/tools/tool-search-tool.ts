// ============================================================
// ToolSearch Tool — 帮助 LLM 搜索可用工具
// 当注册工具很多时，LLM 可用此工具按关键词查找
// ============================================================

import type { Tool, ToolExecutionResult } from './tool-interface'
import type { ToolRegistry } from './tool-registry'

export class ToolSearchTool implements Tool {
  readonly name = 'ToolSearch'
  readonly description = 'Search available tools by keyword. Returns matching tool names and descriptions. Use this when you need to find the right tool for a task but are unsure which one to use.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword to match against tool names and descriptions' },
    },
    required: ['query'],
  }

  constructor(private toolRegistry: ToolRegistry) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const { query } = input as { query?: string }
    if (!query) return { output: 'Query is required', isError: true }

    const lower = query.toLowerCase()
    const allTools = this.toolRegistry.getAll()
    const matches = allTools.filter(t =>
      t.name.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower)
    )

    if (matches.length === 0) {
      const allNames = allTools.map(t => t.name).join(', ')
      return { output: `No tools matching "${query}". Available tools: ${allNames}` }
    }

    const lines = matches.map(t => `- **${t.name}**: ${t.description}`)
    return { output: `Found ${matches.length} tool(s) matching "${query}":\n${lines.join('\n')}` }
  }
}
