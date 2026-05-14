// ============================================================
// Brain 包用到的 event channel 名称常量
// 替代从 shared/ipc-channels 引入的 IPC_CHANNELS
// Brain 包不依赖 Electron IPC，channel 名称纯字符串
// ============================================================

export const BRAIN_CHANNELS = {
  /** Todo 列表更新通知 */
  TODO_UPDATED: 'todo:updated',
  /** 会话压缩通知 */
  SESSION_COMPACTED: 'session:compacted',
  /** 子 Agent 工具调用开始 */
  SUB_TOOL_USE_START: 'stream:sub_tool_use_start',
  /** 子 Agent 工具调用结束 */
  SUB_TOOL_USE_END: 'stream:sub_tool_use_end',
  /** 子 Agent 文本输出 */
  SUB_TEXT: 'stream:sub_text',
} as const

export type BrainChannelName = (typeof BRAIN_CHANNELS)[keyof typeof BRAIN_CHANNELS]
