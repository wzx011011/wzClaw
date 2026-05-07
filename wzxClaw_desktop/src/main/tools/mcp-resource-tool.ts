// ============================================================
// MCP Resource Tools — 列出和读取 MCP 服务器提供的资源
// ============================================================

import type { Tool, ToolExecutionResult } from './tool-interface'
import type { MCPManager } from '../mcp/mcp-manager'

/**
 * 列出所有已连接 MCP 服务器提供的资源。
 * 无参数，返回资源列表（URI、名称、描述）。
 */
export class MCPListResourcesTool implements Tool {
  readonly name = 'MCPListResources'
  readonly description = 'List all resources provided by connected MCP servers. Returns a list of available resources with their URIs, names, and descriptions. Use MCPReadResource to read a specific resource by URI.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      serverName: {
        type: 'string',
        description: 'Optional: only list resources from this specific MCP server. If omitted, lists from all servers.',
      },
    },
  }

  constructor(private mcpManager: MCPManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const { serverName } = input as { serverName?: string }

    try {
      // MCPManager 需要提供 listResources 方法
      const resources = await this.mcpManager.listAllResources(serverName)

      if (resources.length === 0) {
        return { output: 'No resources available from MCP servers.' }
      }

      const lines = resources.map(r =>
        `- [${r.serverName}] ${r.name} (${r.uri})${r.description ? ` — ${r.description}` : ''}${r.mimeType ? ` [${r.mimeType}]` : ''}`
      )
      return { output: `MCP Resources (${resources.length}):\n${lines.join('\n')}` }
    } catch (err) {
      return { output: `Failed to list MCP resources: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}

/**
 * 读取指定 URI 的 MCP 资源内容。
 * 需要 serverName 和 uri 参数。
 */
export class MCPReadResourceTool implements Tool {
  readonly name = 'MCPReadResource'
  readonly description = 'Read the content of an MCP resource by its URI. Use MCPListResources first to discover available resources and their URIs.'
  readonly requiresApproval = false
  readonly isReadOnly = true
  readonly inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: {
      serverName: { type: 'string', description: 'The MCP server name that provides this resource' },
      uri: { type: 'string', description: 'The URI of the resource to read' },
    },
    required: ['serverName', 'uri'],
  }

  constructor(private mcpManager: MCPManager) {}

  async execute(input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const { serverName, uri } = input as { serverName?: string; uri?: string }

    if (!serverName || !uri) {
      return { output: 'Both serverName and uri are required.', isError: true }
    }

    try {
      const contents = await this.mcpManager.readResource(serverName, uri)

      if (contents.length === 0) {
        return { output: `Resource "${uri}" returned no content.` }
      }

      const parts = contents.map(c => {
        const header = `--- Resource: ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ''} ---`
        if (c.text) return `${header}\n${c.text}`
        if (c.blob) return `${header}\n[Binary content, ${c.blob.length} bytes base64]`
        return header
      })

      return { output: parts.join('\n\n') }
    } catch (err) {
      return { output: `Failed to read MCP resource: ${err instanceof Error ? err.message : String(err)}`, isError: true }
    }
  }
}
