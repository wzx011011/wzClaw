// ============================================================
// Admin Config Handler — GET/PUT /admin/config/:name
// 远程读写 ~/.wzxclaw/ 下的配置文件
// ============================================================

import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'fs'
import path from 'path'
import { authenticate } from '../auth.js'
import { getConfigDir } from '../instructions/instruction-loader.js'
import type { AgentServer } from '../server.js'

/** 允许远程读写的配置文件名 */
const ALLOWED_CONFIG_FILES = new Set([
  'api-keys.json',
  'hand.config.json',
  'mcp.json',
  'MEMORY.md',
])

/** 允许远程读写的配置目录 */
const ALLOWED_CONFIG_DIRS = new Set([
  'skills',
  'commands',
])

/**
 * 处理 GET/PUT /admin/config/:name 请求
 *
 * 支持的 :name:
 * - hand.config.json, mcp.json, MEMORY.md — 直接读写
 * - skills/:filename, commands/:filename — 目录下文件读写
 */
export function handleConfig(req: IncomingMessage, res: ServerResponse, server?: AgentServer): void {
  // 认证检查
  const token = extractToken(req)
  const authResult = authenticate(token)
  if (!authResult.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: authResult.reason }))
    return
  }

  const url = req.url || ''
  // 提取 /admin/config/ 后面的路径
  const prefix = '/admin/config/'
  if (!url.startsWith(prefix)) {
    res.writeHead(400)
    res.end('Invalid config path')
    return
  }

  const configName = decodeURIComponent(url.slice(prefix.length))

  // 验证路径安全
  const configDir = getConfigDir()
  const resolvedPath = path.resolve(configDir, configName)
  if (!resolvedPath.startsWith(path.resolve(configDir))) {
    res.writeHead(403)
    res.end('Path traversal denied')
    return
  }

  // 验证文件名合法性
  const parts = configName.split('/')
  if (parts.length === 1) {
    // 顶层文件
    if (!ALLOWED_CONFIG_FILES.has(parts[0])) {
      res.writeHead(404)
      res.end(`Config file "${parts[0]}" not allowed. Allowed: ${[...ALLOWED_CONFIG_FILES].join(', ')}`)
      return
    }
  } else if (parts.length === 2) {
    // 子目录文件（skills/foo.md, commands/bar.md）
    if (!ALLOWED_CONFIG_DIRS.has(parts[0])) {
      res.writeHead(404)
      res.end(`Config directory "${parts[0]}" not allowed. Allowed: ${[...ALLOWED_CONFIG_DIRS].join(', ')}`)
      return
    }
    if (!parts[1].endsWith('.md')) {
      res.writeHead(400)
      res.end('Only .md files allowed in skills/commands directories')
      return
    }
  } else {
    res.writeHead(400)
    res.end('Nested paths not supported')
    return
  }

  // 路由请求方法
  if (req.method === 'GET') {
    handleGetConfig(resolvedPath, res)
  } else if (req.method === 'PUT') {
    handlePutConfig(req, resolvedPath, res, configName, server)
  } else {
    res.writeHead(405)
    res.end('Method not allowed')
  }
}

function handleGetConfig(filePath: string, res: ServerResponse): void {
  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ content }))
  } catch {
    res.writeHead(404)
    res.end('File not found')
  }
}

function handlePutConfig(req: IncomingMessage, filePath: string, res: ServerResponse, configName: string, server?: AgentServer): void {
  let body = ''
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString()
  })
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed.content !== 'string') {
        res.writeHead(400)
        res.end('Request body must have a "content" string field')
        return
      }

      // 确保父目录存在
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, parsed.content, 'utf-8')

      // api-keys.json 写入后热重载 gateway
      if (configName === 'api-keys.json' && server) {
        server.reloadApiKeys()
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      res.writeHead(500)
      res.end(`Write failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

function extractToken(req: IncomingMessage): string {
  const authHeader = req.headers['authorization']
  if (authHeader) {
    if (authHeader.startsWith('Bearer ')) return authHeader.slice('Bearer '.length)
    return authHeader
  }
  return ''
}
