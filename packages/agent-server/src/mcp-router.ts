// ============================================================
// mcp-router — MCP 工具 HTTP 路由
//
// GET  /mcp/tools   — 列出所有可用 MCP 工具（mcp_ 前缀）
// POST /mcp/call    — 调用指定 MCP 工具
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HandAwareToolExecutor } from './hand-aware-tool-executor.js'
import type { HandsRouter } from './hands-router.js'

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function jsonOk(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  const body = JSON.stringify({ error: message })
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

export class McpRouter {
  constructor(
    private readonly toolExecutor: HandAwareToolExecutor,
    private readonly handsRouter: HandsRouter,
  ) {}

  /**
   * 判断是否匹配 MCP 路由
   */
  matches(url: string, method: string): boolean {
    return (url === '/mcp/tools' && method === 'GET') ||
           (url === '/mcp/call' && method === 'POST')
  }

  /**
   * 分发请求
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'

    if (url === '/mcp/tools' && method === 'GET') {
      this.handleListTools(res)
    } else if (url === '/mcp/call' && method === 'POST') {
      await this.handleCallTool(req, res)
    } else {
      jsonError(res, 404, 'Not Found')
    }
  }

  private handleListTools(res: ServerResponse): void {
    const defs = this.toolExecutor.getDefinitions()
    const mcpTools = defs.filter((d) => d.name.startsWith('mcp_'))

    // 按 Hand 分组：从 handsRouter 获取 Hand 信息
    const servers = this.handsRouter.getAllHands()
      .filter((h) => this.handsRouter.isHealthy(h))
      .map((h) => ({
        id: h.id,
        tools: h.definitions
          .filter((d) => d.name.startsWith('mcp_'))
          .map((d) => d.name),
      })).filter((s) => s.tools.length > 0)

    jsonOk(res, { tools: mcpTools, servers })
  }

  private async handleCallTool(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      const raw = await readBody(req)
      body = JSON.parse(raw) as Record<string, unknown>
    } catch {
      jsonError(res, 400, 'Invalid JSON body')
      return
    }

    const toolName = body['tool']
    const input = body['input']

    if (typeof toolName !== 'string' || !toolName) {
      jsonError(res, 400, 'Missing "tool" field')
      return
    }

    if (!toolName.startsWith('mcp_')) {
      jsonError(res, 400, `Tool "${toolName}" is not an MCP tool (must start with mcp_)`)
      return
    }

    const toolInput = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>

    try {
      const result = await this.toolExecutor.execute(toolName, toolInput, {
        workingDirectory: process.env.AGENT_WORKDIR ?? '/tmp',
        projectRoots: [process.env.AGENT_WORKDIR ?? '/tmp'],
        abortSignal: AbortSignal.timeout(30_000),
        targetHandId: typeof body['handId'] === 'string' ? body['handId'] : undefined,
      })
      jsonOk(res, { output: result.output, isError: result.isError })
    } catch (err) {
      jsonError(res, 500, err instanceof Error ? err.message : 'Internal error')
    }
  }
}
