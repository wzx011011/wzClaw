---
phase: 04-shared-web-ui
plan: 02
type: execute
wave: 2
depends_on: ["04a"]
files_modified:
  - packages/web-ui/src/stores/chat-store.ts
  - packages/web-ui/src/stores/chat-store-utils.ts
  - packages/web-ui/src/stores/streaming-batcher.ts
  - packages/web-ui/src/stores/__tests__/chat-store.test.ts
  - packages/web-ui/src/components/chat/MessageList.tsx
  - packages/web-ui/src/components/chat/ChatMessage.tsx
  - packages/web-ui/src/components/chat/ThinkingIndicator.tsx
  - packages/web-ui/src/components/chat/ChatPanel.tsx
  - packages/web-ui/src/styles/chat.css
autonomous: true
requirements:
  - WEBUI-04
  - WEBUI-05
  - WEBUI-06

must_haves:
  truths:
    - "用户在输入框输入文字并发送，消息出现在消息列表中"
    - "助手回复以流式文本逐字显示，带光标闪烁动画"
    - "发送消息时自动创建用户气泡 + 流式助手气泡"
    - "消息列表自动滚动到底部，用户上滚时暂停自动滚动"
    - "聊天 store 通过 DataSource 发送消息，不直接调用 window.wzxclaw"
  artifacts:
    - path: "packages/web-ui/src/stores/chat-store.ts"
      provides: "重构后的 chat store，使用 DataSource 替代 IPC"
      contains: "dataSource"
      min_lines: 200
    - path: "packages/web-ui/src/stores/streaming-batcher.ts"
      provides: "流式文本 rAF 合并批处理"
      contains: "StreamingBatcher"
    - path: "packages/web-ui/src/components/chat/ChatPanel.tsx"
      provides: "聊天主面板 — 输入框 + 消息列表 + 工具栏"
    - path: "packages/web-ui/src/components/chat/MessageList.tsx"
      provides: "消息列表渲染组件"
    - path: "packages/web-ui/src/components/chat/ChatMessage.tsx"
      provides: "单条消息渲染 — Markdown + 流式文本"
  key_links:
    - from: "packages/web-ui/src/stores/chat-store.ts"
      to: "packages/web-ui/src/data-source/types.ts"
      via: "DataSource.sendMessage / DataSource.onStreamEvent"
      pattern: "dataSource\\.sendMessage|dataSource\\.onStreamEvent"
    - from: "packages/web-ui/src/components/chat/ChatPanel.tsx"
      to: "packages/web-ui/src/stores/chat-store.ts"
      via: "useChatStore hook"
      pattern: "useChatStore"
---

<objective>
实现核心聊天 UI — 消息列表 + 输入框 + 流式显示，使用 DataSource 抽象层替代直接 IPC 调用。

Purpose: 这是 web-ui 的核心价值。用户可以在浏览器中输入消息，通过 WebSocket 连接到 NAS agent-server，实时看到 AI 回复以流式文本显示。chat-store 从桌面端提取并重构为 DataSource 驱动。

Output: 可交互的聊天界面，发送消息 -> 流式接收回复。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-shared-web-ui/04-CONTEXT.md
@.planning/phases/04-shared-web-ui/04a-SUMMARY.md

Desktop source files to extract from:
@wzxClaw_desktop/src/renderer/stores/chat-store.ts
@wzxClaw_desktop/src/renderer/stores/chat-store-utils.ts
@wzxClaw_desktop/src/renderer/stores/streaming-batcher.ts
@wzxClaw_desktop/src/renderer/components/chat/ChatPanel.tsx
@wzxClaw_desktop/src/renderer/components/chat/ChatMessage.tsx
@wzxClaw_desktop/src/renderer/components/chat/MessageList.tsx
@wzxClaw_desktop/src/renderer/components/chat/ThinkingIndicator.tsx
@wzxClaw_desktop/src/renderer/styles/chat.css

DataSource interface (from Plan 04a):
@packages/web-ui/src/data-source/types.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Chat store extraction + StreamingBatcher + chat-store-utils</name>
  <files>
    packages/web-ui/src/stores/chat-store.ts,
    packages/web-ui/src/stores/chat-store-utils.ts,
    packages/web-ui/src/stores/streaming-batcher.ts,
    packages/web-ui/src/stores/__tests__/chat-store.test.ts
  </files>
  <behavior>
    - Test 1: createChatStore(dataSource) 创建 store，初始状态 messages=[]
    - Test 2: store.sendMessage("hello") 调用 dataSource.sendMessage 并创建 user+assistant 消息
    - Test 3: dataSource 触发 stream:text 事件后，assistant 消息 content 更新
    - Test 4: dataSource 触发 stream:done 事件后，isStreaming 变为 false
    - Test 5: store.createSession() 重置 messages 和 conversationId
    - Test 6: store.stopGeneration() 调用 dataSource.stopGeneration
  </behavior>
  <action>
    从桌面端提取并重构 chat-store：

    1. **streaming-batcher.ts**: 直接复制 `wzxClaw_desktop/src/renderer/stores/streaming-batcher.ts`。这是纯逻辑模块，不依赖任何 Electron API。功能：通过 requestAnimationFrame 合并高频流式文本更新，避免逐 token 重渲染。

    2. **chat-store-utils.ts**: 从 `wzxClaw_desktop/src/renderer/stores/chat-store-utils.ts` 提取 `updateMessageById` 和 `buildChatMessagesFromRaw` 工具函数。不依赖 Electron。

    3. **chat-store.ts**: 重构为工厂模式。
       - `export function createChatStore(dataSource: DataSource)` 返回 Zustand store
       - 核心状态接口 ChatState 保持不变（messages, conversationId, isStreaming, isWaitingForResponse, error, streamingMessageId 等）
       - `init()` 方法：通过 `dataSource.onStreamEvent('text', cb)` 等订阅所有 stream 事件，返回 unsubscribe 函数。每个事件回调中的逻辑与桌面端相同（会话过滤、batcher append、message update）
       - `sendMessage()`: 调用 `dataSource.sendMessage(conversationId, content)` 替代 `window.wzxclaw.sendMessage()`
       - `stopGeneration()`: 调用 `dataSource.stopGeneration(conversationId)` 替代 `window.wzxclaw.stopGeneration()`
       - `createSession()`: 调用 `dataSource.createSession()` 获取新 sessionId，替代客户端 uuid 生成
       - 暂时不实现 loadSession/switchSession/deleteSession（留给 Plan 04c）
       - 暂时不实现 workspaceStore 依赖（web-ui 没有 workspace 概念，activeWorkspaceId 传 undefined）
       - 代码注释用中文

    4. **测试**: 6 个测试用例，mock DataSource 接口。验证 store 与 DataSource 的交互逻辑。
  </action>
  <verify>
    <automated>cd packages/web-ui && npx vitest run src/stores/__tests__/chat-store.test.ts</automated>
  </verify>
  <done>
    - createChatStore(dataSource) 工厂函数导出
    - StreamingBatcher 从桌面端提取，无 Electron 依赖
    - sendMessage 通过 DataSource 发送，不调用 window.wzxclaw
    - stream 事件通过 DataSource.onStreamEvent 订阅
    - 6 个测试全部通过
  </done>
</task>

<task type="auto">
  <name>Task 2: Chat UI components — MessageList, ChatMessage, ThinkingIndicator, ChatPanel</name>
  <files>
    packages/web-ui/src/components/chat/MessageList.tsx,
    packages/web-ui/src/components/chat/ChatMessage.tsx,
    packages/web-ui/src/components/chat/ThinkingIndicator.tsx,
    packages/web-ui/src/components/chat/ChatPanel.tsx,
    packages/web-ui/src/styles/chat.css
  </files>
  <action>
    从桌面端提取核心聊天 UI 组件：

    1. **ThinkingIndicator.tsx**: 直接复制，纯 UI 组件无外部依赖。显示脉冲动画 + "Thinking..." 文字。

    2. **ChatMessage.tsx**: 从桌面端提取，做以下调整：
       - 移除 MentionPicker 相关渲染（web-ui 没有 @文件功能）
       - 保留 ReactMarkdown + remark-gfm + rehype-raw 的 Markdown 渲染
       - 保留流式文本渲染（StreamingText 组件）
       - 保留 ToolCallGroup 渲染（但 ToolCallGroup 本身留给 Plan 04d，先用占位符显示工具名）
       - 保留 thinkingContent 折叠显示
       - 移除 rewind 按钮引用（web-ui 暂不支持）
       - CSS class 名称保持与桌面端一致，复用 chat.css

    3. **MessageList.tsx**: 从桌面端提取，做以下调整：
       - 保留历史窗口化逻辑（history-window 模块 — 从桌面端一并提取）
       - 保留自动滚动逻辑（userScrolledUp 状态 + scrollAnchorKey）
       - 保留流式文本更新时的自动滚动
       - 移除 rewindToMessage 功能（暂不支持）
       - 需要提取 history-window.ts 工具函数

    4. **ChatPanel.tsx**: 从桌面端提取核心聊天面板，大幅简化：
       - 保留：消息输入框（textarea + 发送按钮 + Enter 发送 / Shift+Enter 换行）
       - 保留：isStreaming 时禁用发送按钮，显示停止按钮
       - 保留：模型标签显示（从 settingsStore 读取）
       - 保留：连接状态指示器（从 DataSource.onConnectionChange 读取）
       - 移除：@Mention 相关（MentionPicker）
       - 移除：Slash commands 相关（SlashCommandPicker）
       - 移除：Thinking depth / Permission mode 选择器（简化为固定配置）
       - 移除：DiffPreview 集成
       - 移除：PluginManager 集成
       - 移除：StepPanel 集成
       - 移除：Settings 内嵌面板（留独立页面，Plan 04c）
       - ChatPanel 大约从 964 行简化到 ~300 行

    5. **history-window.ts**: 从桌面端 `components/chat/history-window.ts` 直接复制。纯逻辑函数。

    6. **chat.css**: 从桌面端 `styles/chat.css` 提取聊天相关样式。包含：
       - .chat-panel, .messages-container, .chat-input-area
       - .chat-message, .user-message, .assistant-message
       - .streaming-text, .thinking-content
       - .thinking-indicator
       - 响应式布局
       - 暗色主题（跟随桌面端的 CSS 变量方案）

    注意事项：
    - 组件中 import 的 store 使用 web-ui 版本的 chat-store（工厂创建的全局实例）
    - 需要在 stores/chat-store.ts 底部导出一个全局实例：`export const useChatStore = createChatStore(globalDataSource)`
    - 需要安装 react-markdown, remark-gfm, rehype-raw 依赖
    - 所有组件代码注释用中文
  </action>
  <verify>
    <automated>cd packages/web-ui && npm run typecheck && npm run build</automated>
  </verify>
  <done>
    - ChatPanel 渲染输入框 + MessageList
    - 输入文字按 Enter 可发送消息
    - 消息列表显示用户消息气泡
    - 流式助手消息逐字显示带光标动画
    - chat.css 暗色主题正确应用
    - npm run build 构建通过
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| user input -> chat store | 用户输入文本进入系统，需要防止 XSS |
| chat store -> DataSource | store 构建的消息内容通过 DataSource 发送 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-04 | S | ChatPanel input | mitigate | ReactMarkdown 使用 rehype-raw 时限制允许的 HTML 标签，防止注入 |
| T-04-05 | I | MessageList | accept | 消息内容来自受信的 agent-server，显示层不做额外校验 |
</threat_model>

<verification>
1. `cd packages/web-ui && npm test` — chat-store 6 个测试通过
2. `cd packages/web-ui && npm run typecheck` — 类型检查通过
3. `cd packages/web-ui && npm run build` — 构建输出 dist/
4. 启动 dev server，浏览器可看到聊天界面
</verification>

<success_criteria>
- chat-store 使用 DataSource 工厂模式，6 个测试通过
- ChatPanel + MessageList + ChatMessage + ThinkingIndicator 组件可用
- 输入框可输入文字并发送
- 流式消息通过 StreamingBatcher 批量更新
- chat.css 样式正确
- npm run build 构建成功
</success_criteria>

<output>
After completion, create `.planning/phases/04-shared-web-ui/04b-SUMMARY.md`
</output>
