// ============================================================
// Docker Hand 入口点
// 组装 NAS 工具集，创建 HandConnection 连接到 agent-server
// 容器启动时通过 docker-compose 环境变量注入配置
// ============================================================

import { HandConnection } from './src/connection.js'
import { LocalToolExecutor } from './src/tool-executor.js'
import type { HandConfig } from './src/types.js'
import { createNasTools } from './tools/index.js'

// ---- 类型定义 ----

/** createDockerHand 返回的 Docker Hand 实例 */
export interface DockerHandInstance {
  /** Hand 连接管理器 */
  connection: HandConnection
  /** 工具执行器 */
  executor: LocalToolExecutor
}

/** Docker Hand 回调配置 */
export interface DockerHandCallbacks {
  /** WebSocket 工厂（用于测试注入） */
  wsFactory?: (url: string, protocols?: string | string[]) => unknown
}

// ---- 默认配置 ----

/** 默认 agent-server 地址（同宿主机 localhost） */
const DEFAULT_SERVER_URL = 'ws://localhost:8082/'

// ---- createDockerHand ----

/**
 * createDockerHand — 创建 Docker Hand 实例
 *
 * 功能:
 * - 创建 LocalToolExecutor 并注册 4 个 NAS 工具 + Echo 内置工具
 * - 创建 HandConnection 连接到 agent-server
 * - 设置 onExecute 回调：工具执行结果通过 connection.sendResult 回传
 *
 * @param config - Hand 连接配置
 * @param callbacks - 回调配置（wsFactory 用于测试注入）
 * @returns Docker Hand 实例（connection + executor）
 */
export function createDockerHand(
  config: HandConfig,
  callbacks?: DockerHandCallbacks,
): DockerHandInstance {
  // 创建工具执行器
  const executor = new LocalToolExecutor()

  // 注册 NAS 工具（FileRead, FileWrite, FileList, ShellExecute）
  const nasTools = createNasTools()
  for (const tool of nasTools) {
    executor.register(tool)
  }

  // 注册内置 Echo 工具（测试/调试用）
  executor.addBuiltinTools()

  // 构建 HandConnection 回调
  const wsFactory = callbacks?.wsFactory
    ? (url: string, protocols?: string | string[]) =>
        callbacks.wsFactory!(url, protocols) as import('./src/connection.js').IWebSocket
    : undefined

  // 创建 Hand 连接
  const connection = new HandConnection(config, {
    wsFactory,
    // 收到工具执行请求：执行并回传结果
    async onExecute(data) {
      console.log(`[docker-hand] 执行工具: ${data.name} (callId: ${data.callId})`)
      const result = await executor.execute(data.name, data.input, data.context)
      connection.sendResult(data.callId, result.output, result.isError)
      console.log(`[docker-hand] 工具完成: ${data.name} (isError: ${result.isError})`)
    },
    // 连接断开
    onDisconnect() {
      console.log('[docker-hand] 连接断开，正在重连...')
    },
    // 状态变更
    onStatusChange(status) {
      const statusNames: Record<string, string> = {
        disconnected: '未连接',
        connecting: '正在连接',
        registering: '正在注册',
        connected: '已连接',
        reconnecting: '正在重连',
      }
      console.log(`[docker-hand] 状态: ${statusNames[status] || status}`)
    },
  })

  return { connection, executor }
}

// ---- runDockerHand（模块级入口）----

/**
 * runDockerHand — 从环境变量读取配置，创建并启动 Docker Hand
 *
 * 环境变量:
 * - SERVER_URL: agent-server WebSocket 地址（默认 ws://localhost:8082/）
 * - AUTH_TOKEN: 认证 token（必需）
 *
 * 启动流程:
 * 1. 读取环境变量
 * 2. 校验 AUTH_TOKEN（缺失时退出）
 * 3. 生成 Hand ID（hand-docker-nas-{timestamp}）
 * 4. 创建 Docker Hand 实例
 * 5. 注册 SIGINT/SIGTERM 信号处理（优雅关闭）
 * 6. 启动连接
 */
export function runDockerHand(): void {
  // 读取环境变量
  const serverUrl = process.env.SERVER_URL || DEFAULT_SERVER_URL
  const authToken = process.env.AUTH_TOKEN

  // 校验 token
  if (!authToken || !authToken.trim()) {
    console.error('[docker-hand] 错误: 缺少 AUTH_TOKEN 环境变量')
    console.error('[docker-hand] 请在 docker-compose 或 docker run 中设置 AUTH_TOKEN')
    process.exit(1)
  }

  // 生成 Hand ID
  const handId = `hand-docker-nas-${Date.now()}`

  // 构建 HandConfig
  const config: HandConfig = {
    serverUrl,
    authToken,
    handId,
  }

  // 创建 Docker Hand 实例
  const { connection, executor } = createDockerHand(config)

  console.log(`[docker-hand] 启动中...`)
  console.log(`[docker-hand] 服务器: ${serverUrl}`)
  console.log(`[docker-hand] Hand ID: ${handId}`)
  console.log(`[docker-hand] 工具: ${executor.getCapabilities().join(', ')}`)

  // 优雅退出：SIGINT/SIGTERM 信号处理
  const cleanup = () => {
    console.log('\n[docker-hand] 正在关闭...')
    connection.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // 建立连接
  connection.connect()
  console.log('[docker-hand] 已启动，等待连接...')
}

// ---- 模块级 main 检测 ----

// 当作为入口脚本运行时自动启动（与 cli.ts 模式一致）
if (process.argv[1]?.includes('docker-entry')) {
  runDockerHand()
}
