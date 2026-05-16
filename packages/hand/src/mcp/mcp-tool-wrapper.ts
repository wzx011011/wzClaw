// ============================================================
// MCP Tool Wrapper — 适配 MCP 工具为 HandTool 接口
// ============================================================

import type { MCPClient, MCPToolDefinition } from './mcp-client.js'
import type { HandTool } from '../tool-executor.js'

/**
 * 将 MCP 远程工具包装为 HandTool，可注册到 LocalToolExecutor
 */
export class MCPHandToolWrapper implements HandTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly isReadOnly = false

  constructor(
    private client: MCPClient,
    private mcpTool: MCPToolDefinition,
    private serverName: string,
  ) {
    this.name = `mcp_${serverName}_${mcpTool.name}`
    this.description = `[MCP:${serverName}] ${mcpTool.description}`
    this.inputSchema = mcpTool.inputSchema
  }

  async execute(
    input: Record<string, unknown>,
    _context: { workingDirectory: string; projectRoots: string[] },
  ): Promise<{ output: string; isError: boolean }> {
    try {
      if (!this.client.isConnected()) {
        return { output: `MCP server "${this.serverName}" is not connected`, isError: true }
      }

      const result = await this.client.callTool(this.mcpTool.name, input)

      const texts = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
      const output = texts.join('\n') || 'Tool executed successfully (no output)'

      return { output, isError: false }
    } catch (err) {
      return {
        output: `MCP tool error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
