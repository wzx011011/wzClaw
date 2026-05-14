#!/usr/bin/env node
// ============================================================
// wzxclaw-hand CLI 入口点
// 解析命令行参数，创建 HandConnection + LocalToolExecutor
// 启动 Hand 服务并连接到 agent-server
// ============================================================

import { HandConnection } from './connection.js'
import { LocalToolExecutor } from './tool-executor.js'
import type { HandConfig } from './types.js'
import { HandStatus } from './types.js'

// ---- 参数解析 ----

/** 解析后的 CLI 参数 */
export interface ParsedArgs {
  /** Agent server WebSocket URL */
  server?: string
  /** 认证 token */
  token?: string
  /** Hand 唯一标识符 */
  id?: string
  /** 心跳间隔（毫秒） */
  heartbeat?: number
  /** 是否显示帮助 */
  help?: boolean
}

/**
 * 解析命令行参数
 *
 * 支持: --server, --token, --id, --heartbeat, --help/-h
 * 优先级: CLI 参数 > 环境变量
 *
 * @param argv - process.argv（前两个元素被跳过）
 * @returns 解析后的参数
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {}

  // 跳过 node 和脚本路径
  const args = argv.slice(2)

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--server':
        result.server = args[++i]
        break
      case '--token':
        result.token = args[++i]
        break
      case '--id':
        result.id = args[++i]
        break
      case '--heartbeat': {
        const val = parseInt(args[++i], 10)
        if (!isNaN(val) && val > 0) {
          result.heartbeat = val
        }
        break
      }
      case '--help':
      case '-h':
        result.help = true
        break
    }
  }

  // 环境变量回退（CLI 参数优先）
  if (!result.server) {
    result.server = process.env.SERVER_URL
  }
  if (!result.token) {
    result.token = process.env.AUTH_TOKEN
  }
  if (!result.id) {
    result.id = process.env.HAND_ID
  }

  return result
}

// ---- usage 帮助信息 ----

/** usage 帮助文本 */
const USAGE_TEXT = `
Usage: wzxclaw-hand --server <url> --token <token> [--id <hand-id>] [--heartbeat <ms>]

Options:
  --server    Agent server WebSocket URL (env: SERVER_URL)
  --token     Authentication token (env: AUTH_TOKEN)
  --id        Hand unique ID (auto-generated if not set, env: HAND_ID)
  --heartbeat Heartbeat interval in ms (default: 15000)
  --help, -h  Show this help message

Environment variables:
  SERVER_URL   Agent server WebSocket URL
  AUTH_TOKEN   Authentication token
  HAND_ID      Hand unique ID
`.trim()

// ---- URL 验证 ----

/**
 * 验证 server URL 格式
 * 必须以 ws:// 或 wss:// 开头
 */
function isValidServerUrl(url: string): boolean {
  return url.startsWith('ws://') || url.startsWith('wss://')
}

// ---- 主入口 ----

/**
 * CLI 主函数
 *
 * 流程:
 * 1. 解析参数（CLI args > 环境变量）
 * 2. 验证必需参数（server, token）
 * 3. 创建 LocalToolExecutor，注册内置工具
 * 4. 创建 HandConnection，绑定回调
 * 5. 注册 SIGINT/SIGTERM 信号处理
 * 6. 调用 connection.connect()
 */
export async function runCli(): Promise<void> {
  const args = parseArgs(process.argv)

  // 显示帮助
  if (args.help) {
    console.log(USAGE_TEXT)
    process.exit(0)
  }

  // 验证必需参数
  if (!args.server || !args.token) {
    if (!args.server && !args.token) {
      console.error('错误: 缺少 --server 和 --token 参数')
    } else if (!args.server) {
      console.error('错误: 缺少 --server 参数')
    } else {
      console.error('错误: 缺少 --token 参数')
    }
    console.error('')
    console.error(USAGE_TEXT)
    process.exit(1)
  }

  // 验证 server URL 格式
  if (!isValidServerUrl(args.server)) {
    console.error('错误: --server URL 必须以 ws:// 或 wss:// 开头')
    console.error(`  收到: ${args.server}`)
    process.exit(1)
  }

  // 验证 token 非空
  if (!args.token.trim()) {
    console.error('错误: --token 不能为空')
    process.exit(1)
  }

  // 构建 HandConfig
  const config: HandConfig = {
    serverUrl: args.server,
    authToken: args.token,
    handId: args.id,
    heartbeatIntervalMs: args.heartbeat,
  }

  // 创建工具执行器，注册内置工具
  const executor = new LocalToolExecutor()
  executor.addBuiltinTools()

  console.log(`[wzxclaw-hand] 启动中...`)
  console.log(`[wzxclaw-hand] 服务器: ${config.serverUrl}`)
  console.log(`[wzxclaw-hand] 工具: ${executor.getCapabilities().join(', ')}`)

  // 创建连接，绑定回调
  const connection = new HandConnection(config, {
    // 收到工具执行请求：执行工具并回传结果
    async onExecute(data) {
      console.log(`[wzxclaw-hand] 执行工具: ${data.name} (callId: ${data.callId})`)
      const result = await executor.execute(data.name, data.input, data.context)
      connection.sendResult(data.callId, result.output, result.isError)
      console.log(`[wzxclaw-hand] 工具完成: ${data.name} (isError: ${result.isError})`)
    },

    // 连接断开
    onDisconnect() {
      console.log('[wzxclaw-hand] 连接断开，正在重连...')
    },

    // 状态变更
    onStatusChange(status) {
      const statusNames: Record<HandStatus, string> = {
        [HandStatus.Disconnected]: '未连接',
        [HandStatus.Connecting]: '正在连接',
        [HandStatus.Registering]: '正在注册',
        [HandStatus.Connected]: '已连接',
        [HandStatus.Reconnecting]: '正在重连',
      }
      console.log(`[wzxclaw-hand] 状态: ${statusNames[status] || status}`)
    },
  })

  // 优雅退出：SIGINT/SIGTERM 信号处理
  const cleanup = () => {
    console.log('\n[wzxclaw-hand] 正在关闭...')
    connection.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // 建立连接
  connection.connect()
  console.log('[wzxclaw-hand] 已启动，按 Ctrl+C 退出')
}
