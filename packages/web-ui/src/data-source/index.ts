// ============================================================
// DataSource 统一导出
//
// 提供 DataSource 接口、两个实现、类型定义和工厂函数。
// UI 组件只从此模块导入，不直接引用具体实现。
// ============================================================

export type {
  DataSource,
  StreamEventType,
  StreamEventCallback,
  StreamPayloadMap,
  SessionMeta,
  SessionConfig,
  SessionConfigPatch,
  SessionListOptions,
  CreateSessionOptions,
  RawMessage,
  Workspace,
  Project,
  WorkspaceUpdate,
  RuntimeCapabilities,
  Settings,
  SendMessageOptions,
  TextStreamPayload,
  ThinkingStreamPayload,
  ToolCallStreamPayload,
  ToolResultStreamPayload,
  ErrorStreamPayload,
  DoneStreamPayload,
  CompactedStreamPayload,
  ToolProgressStreamPayload,
  TurnEndStreamPayload,
  FsChannel,
  FileTreeNode,
  FileWatchEvent,
  TerminalChannel,
  TerminalSpawnOptions,
  PreviewChannel,
} from './types'

export { WebSocketDataSource } from './websocket-source'
export { IpcDataSource } from './ipc-source'

import { WebSocketDataSource } from './websocket-source'

/**
 * createDataSource — 自动选择 DataSource 实现
 *
 * 检测运行环境：
 * - 如果 window.wzxclaw 存在（Electron），返回 IpcDataSource
 * - 否则返回 WebSocketDataSource（远程模式）
 *
 * @param webSocketUrl WebSocket 连接地址（远程模式使用，默认从环境变量获取）
 * @param token 认证 token（可选）
 */
export function createDataSource(
  webSocketUrl?: string,
  token?: string,
): import('./types').DataSource {
  // 所有客户端统一通过 WebSocket 连接 agent-server
  // 桌面端 native 能力 (fs/terminal/preview) 通过 agent-server Hand 路由
  const url = webSocketUrl ?? (typeof __VITE_AGENT_URL__ !== 'undefined' ? __VITE_AGENT_URL__ : 'ws://localhost:8082')
  return new WebSocketDataSource(url, token)
}
