// ============================================================
// commands-router — Skills / Commands / Memory HTTP 路由
//
// GET /commands  — 列出已注册的 commands 文件内容
// GET /skills    — 列出已注册的 skills 文件内容
// GET /memory    — 返回 MEMORY.md 内容
// GET /knowledge — 返回 skills + commands + memory 汇总
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import { loadInstructions, getConfigDir } from './instructions/instruction-loader.js'
import type { HandsRouter } from './hands-router.js'

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

/** 按换行分割、过滤空行，返回条目列表 */
function splitLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

export class CommandsRouter {
  constructor(private readonly handsRouter: HandsRouter) {}

  matches(url: string, method: string): boolean {
    return method === 'GET' && (
      url === '/commands' ||
      url === '/skills' ||
      url === '/memory' ||
      url === '/knowledge'
    )
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/'

    try {
      const configDir = getConfigDir()
      const sections = loadInstructions(configDir)

      if (url === '/commands') {
        jsonOk(res, {
          commands: splitLines(sections.commands),
          raw: sections.commands,
        })
      } else if (url === '/skills') {
        jsonOk(res, {
          skills: splitLines(sections.skills),
          raw: sections.skills,
        })
      } else if (url === '/memory') {
        jsonOk(res, {
          memory: sections.memory,
        })
      } else if (url === '/knowledge') {
        // 汇总：skills + commands + memory + 在线 Hand 工具
        const toolsByHand = this.handsRouter.getAllHands()
          .filter((h) => this.handsRouter.isHealthy(h))
          .map((h) => ({
            handId: h.id,
            tools: h.definitions.map((d) => ({ name: d.name, description: d.description })),
          }))

        jsonOk(res, {
          skills: sections.skills,
          commands: sections.commands,
          memory: sections.memory,
          hands: toolsByHand,
        })
      } else {
        jsonError(res, 404, 'Not Found')
      }
    } catch (err) {
      jsonError(res, 500, err instanceof Error ? err.message : 'Internal error')
    }
  }
}
