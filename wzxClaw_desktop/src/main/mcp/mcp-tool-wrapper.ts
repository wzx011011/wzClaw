// ============================================================
// MCP Tool Wrapper — Wraps MCP tools as wzxClaw Tool interface
// ============================================================

import type { Tool, ToolExecutionContext, ToolExecutionResult } from '../tools/tool-interface'
import type { MCPClient, MCPToolDefinition } from './mcp-client'

/**
 * Wraps an MCP tool as a wzxClaw Tool, so it can be registered
 * in the ToolRegistry and called by the agent loop.
 */
export class MCPToolWrapper implements Tool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly requiresApproval = true // MCP tools are potentially destructive
  readonly isReadOnly = false

  constructor(
    private client: MCPClient,
    private mcpTool: MCPToolDefinition,
    private serverName: string
  ) {
    // Prefix tool name with server name to avoid collisions
    this.name = `mcp_${serverName}_${mcpTool.name}`
    this.description = `[MCP:${serverName}] ${mcpTool.description}`
    this.inputSchema = mcpTool.inputSchema
  }

  async execute(
    input: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    try {
      if (!this.client.isConnected()) {
        return { output: `MCP server "${this.serverName}" is not connected`, isError: true }
      }

      const result = await this.client.callTool(this.mcpTool.name, input)

      // Extract text content from MCP result
      const texts = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
      const output = texts.join('\n') || 'Tool executed successfully (no output)'

      return { output, isError: false }
    } catch (err) {
      return {
        output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      }
    }
  }
}
