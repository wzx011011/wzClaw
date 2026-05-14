# Phase 4 Context: Shared Web UI -- React SPA

## Phase Goal

从桌面端 Renderer 提取共享 UI 层，支持 Electron 和 WebSocket 双数据源。产出 `packages/web-ui/`，可独立 dev server 运行，连接 NAS Brain 聊天正常。

## Source Analysis

### Desktop Renderer Architecture (to extract from)

**Core Stores** (11 Zustand stores):
- `chat-store.ts` (1388 lines) -- 消息、流式状态、会话切换、LRU 缓存、StreamingBatcher
- `settings-store.ts` -- provider/model/theme/language 等设置
- `workspace-store.ts` -- 工作区管理
- `layout-store.ts` -- UI 布局持久化
- `step-store.ts` -- Agent 步骤管理
- `diff-store.ts` -- 差异预览
- `notification-store.ts` -- 通知
- `tab-store.ts` -- 编辑器标签
- `terminal-store.ts` -- 终端面板
- `command-store.ts` -- 命令面板
- `toast-store.ts` -- Toast 提示

**Core Components** (chat/):
- `ChatPanel.tsx` (964 lines) -- 完整聊天界面，输入框、模型选择、权限模式
- `ChatMessage.tsx` (252 lines) -- 单条消息渲染（Markdown、流式文本）
- `MessageList.tsx` (216 lines) -- 消息列表 + 历史窗口化
- `ToolCard.tsx` (725 lines) -- 单个工具调用可视化
- `ToolCallGroup.tsx` (170 lines) -- 工具调用分组容器
- `CodeBlock.tsx` (74 lines) -- 语法高亮代码块
- `SessionList.tsx` (289 lines) -- 会话列表（搜索、分组、右键菜单）
- `ThinkingIndicator.tsx` -- 思考中动画
- `PermissionRequest.tsx` -- 权限请求弹窗
- `DiffPreview.tsx` -- 差异预览
- `MentionPicker.tsx` -- @文件选择器
- `SlashCommandPicker.tsx` -- /命令选择器
- `AskUserQuestion.tsx` -- 用户问题弹窗

**IDE Components** (ide/):
- `IDELayout.tsx` -- ActivityBar + Sidebar + Chat + StatusBar 布局
- `TitleBar.tsx`, `ActivityBar.tsx`, `Sidebar.tsx`, `StatusBar.tsx`
- `EditorPanel.tsx` -- Monaco Editor 面板
- `TerminalPanel.tsx` -- xterm.js 终端面板
- `PreviewPanel.tsx` -- 浏览器预览

**Shared Types** (`src/shared/types.ts`):
- Message types: UserMessage, AssistantMessage, ToolResultMessage
- Content blocks: TextContentBlock, ToolUseContentBlock, ThinkingContentBlock
- Stream events: TextDeltaEvent, ThinkingDeltaEvent, ToolUseStartEvent, ToolUseEndEvent, etc.
- Session types: SessionMeta, SessionTaskState
- Tool types: ToolCall, ToolResult, ToolDefinition

**Styles**:
- `chat.css` -- 聊天组件样式
- `ide.css` -- IDE 布局样式
- `workspaces.css` -- 工作区样式

### Preload API (to abstract)

`window.wzxclaw` exposes ~40 methods across 6 categories:

1. **Agent**: sendMessage, stopGeneration
2. **Stream listeners** (14): onStreamText, onStreamThinking, onStreamToolStart, onStreamToolResult, onStreamToolProgress, onStreamEnd, onStreamTurnEnd, onStreamError, onStreamRetrying, onSubStreamToolStart, onSubStreamToolResult, onSubStreamText, onStreamToolCallPreview, onMobileUserMessage
3. **Session**: listSessions, loadSession, loadSessionTail, deleteSession, renameSession, duplicateSession, ensureSession, saveLastSession, getLastSession, onSessionRestore, onSessionCompacted, onSessionContextRestored, onSessionRunningChanged
4. **Settings**: getSettings, updateSettings
5. **Permission**: onPermissionRequest, sendPermissionResponse
6. **Data sync**: onDataChanged, onTodoUpdated

### Agent-Server Client Protocol (Phase 2 output)

Client -> Server events:
- `chat:send` { sessionId, message }
- `session:list` -> { sessions[] }
- `session:load` { sessionId } -> { messages[] }
- `session:create` -> { sessionId }
- `session:delete` { sessionId }

Server -> Client events:
- `stream:text` { delta }
- `stream:thinking` { content }
- `stream:tool_call` { toolCallId, name, input }
- `stream:tool_result` { toolCallId, name, output, isError }
- `stream:error` { error, recoverable }
- `stream:done` { usage, turnCount }
- `stream:compacted` { beforeTokens, afterTokens }
- `session:list` { sessions[] }
- `session:loaded` { messages[] }
- `session:created` { sessionId }
- `session:deleted` { sessionId }
- `error` { message }

## Design Decisions

### D-01: DataSource 抽象接口

创建 `DataSource` interface 作为统一数据层，两个实现：
- `IpcDataSource` -- 包装 `window.wzxclaw` 调用，Electron 环境使用
- `WebSocketDataSource` -- WebSocket 连接到 agent-server，远程模式使用

```typescript
interface DataSource {
  // 连接生命周期
  connect(): Promise<void>
  disconnect(): void
  isConnected(): boolean
  onConnectionChange(cb: (connected: boolean) => void): () => void

  // Agent 操作
  sendMessage(sessionId: string, content: string, options?: SendMessageOptions): Promise<void>
  stopGeneration(sessionId: string): Promise<void>

  // Stream 事件
  onStreamEvent(event: StreamEventType, cb: (payload: unknown) => void): () => void

  // Session CRUD
  listSessions(): Promise<SessionMeta[]>
  loadSession(sessionId: string): Promise<RawMessage[]>
  createSession(): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string): Promise<void>

  // Settings
  getSettings(): Promise<Settings>
  updateSettings(settings: Partial<Settings>): Promise<void>
}
```

### D-02: Store 重构策略

现有 chat-store.ts 直接调用 `window.wzxclaw`。重构方式：
- Store 构造时接收 DataSource 实例（不硬编码 IPC）
- 使用 Zustand 的 `create` 工厂模式：`createChatStore(dataSource: DataSource)`
- 全局通过 `DataSourceProvider` React Context 提供 DataSource
- Store 内部调用 `dataSource.sendMessage()` 而非 `window.wzxclaw.sendMessage()`

### D-03: 依赖裁剪

web-ui 不引入的重量级依赖：
- Monaco Editor -- 仅桌面端需要，web-ui 用 CodeBlock 做只读代码高亮
- xterm.js -- 仅桌面端需要
- Allotment -- IDE 面板拖拽，web-ui 简化为 flexbox 布局
- Electron 相关 -- 全部通过 DataSource 抽象隔离

web-ui 保留的依赖：
- React 19, ReactDOM
- Zustand 5
- react-markdown + remark-gfm + rehype-raw
- highlight.js (通过 CodeBlock)
- uuid

### D-04: 组件提取范围

Phase 4 提取的核心组件（聊天界面）：
1. ChatPanel -- 聊天主面板（输入框 + 消息列表 + 工具栏）
2. ChatMessage -- 消息渲染（Markdown + 流式文本 + thinking）
3. MessageList -- 消息列表（历史窗口化 + 自动滚动）
4. ToolCard -- 工具调用卡片
5. ToolCallGroup -- 工具调用分组
6. CodeBlock -- 代码块（语法高亮 + 复制）
7. SessionList -- 会话列表（搜索 + 分组 + CRUD）
8. ThinkingIndicator -- 思考动画
9. Toast -- Toast 提示

Phase 4 不提取的组件（留给 Phase 5 桌面端）：
- IDELayout -- 完整 IDE 布局
- EditorPanel / TerminalPanel -- Monaco/xterm
- ActivityBar / Sidebar -- IDE 导航
- DiffPreview -- 文件差异（需要文件系统）
- MentionPicker -- @文件（需要文件系统）
- PermissionRequest -- 权限（远程模式不需要）

### D-05: WebSocket 客户端重连策略

WebSocketDataSource 内建重连：
- 首次连接失败：指数退避重试（1s, 2s, 4s, 8s, 最大 30s）
- 连接断开：自动重连，保持 session 状态
- 重连成功后：重新订阅当前 session 的事件流
- 连接状态：通过 `onConnectionChange` 回调通知 UI

### D-06: 独立 Dev Server

web-ui 包使用 Vite 构建：
- `npm run dev` 启动 Vite dev server（HMR）
- `npm run build` 输出 SPA 静态文件
- 环境变量 `VITE_AGENT_URL` 指定 agent-server WebSocket URL
- 默认 `ws://localhost:8082`（本地开发）

### D-07: i18n 策略

沿用桌面端 i18n 架构：
- 复制 i18n 目录（i18n-store.ts, locales/）
- web-ui 内建中文 + 英文
- 不依赖 Electron IPC 获取语言设置

## Scope Boundaries

### In Scope (Phase 4)
- `packages/web-ui/` 完整 SPA 包
- DataSource 抽象接口 + IPC + WebSocket 两个实现
- 核心聊天组件提取
- 会话管理 UI
- 设置面板（连接配置、语言、主题）
- 独立 dev server
- 单元测试

### Out of Scope (deferred to Phase 5/6)
- Electron 壳整合（Phase 5）
- Capacitor 壳整合（Phase 6）
- Monaco Editor / xterm.js
- 文件树 / 文件操作
- Diff 预览
- 终端面板
- 权限请求流程（远程模式由 agent-server 管理）
- 桌面端回退模式的完整功能
