---
phase: 04-shared-web-ui
plan: 03
type: execute
wave: 2
depends_on: ["04a"]
files_modified:
  - packages/web-ui/src/stores/chat-store.ts
  - packages/web-ui/src/components/chat/SessionList.tsx
  - packages/web-ui/src/components/settings/SettingsPage.tsx
  - packages/web-ui/src/components/ui/ContextMenu.tsx
  - packages/web-ui/src/styles/settings.css
autonomous: true
requirements:
  - WEBUI-07
  - WEBUI-08
  - WEBUI-09

must_haves:
  truths:
    - "用户可以看到历史会话列表，按时间分组显示"
    - "点击某个会话可切换到该会话的消息"
    - "可以创建新会话、删除旧会话、重命名会话"
    - "设置页面可配置 agent-server 连接地址和 token"
    - "连接设置保存到 localStorage，刷新后保留"
  artifacts:
    - path: "packages/web-ui/src/components/chat/SessionList.tsx"
      provides: "会话列表组件 — 搜索、时间分组、CRUD"
      min_lines: 100
    - path: "packages/web-ui/src/components/settings/SettingsPage.tsx"
      provides: "设置页面 — 连接配置、语言、主题"
    - path: "packages/web-ui/src/components/ui/ContextMenu.tsx"
      provides: "右键菜单组件（SessionList 使用）"
  key_links:
    - from: "packages/web-ui/src/components/chat/SessionList.tsx"
      to: "packages/web-ui/src/stores/chat-store.ts"
      via: "useChatStore — sessions, switchSession, deleteSession, renameSession"
      pattern: "useChatStore\\(.*s.*s\\.sessions"
    - from: "packages/web-ui/src/components/settings/SettingsPage.tsx"
      to: "localStorage"
      via: "连接配置持久化"
      pattern: "localStorage"
---

<objective>
实现会话管理 UI + 设置面板，完善 chat-store 的 session 操作方法。

Purpose: 会话管理是 IDE 的核心交互。用户需要在多个对话间切换、查看历史、管理会话。设置面板让用户配置 agent-server 连接地址和认证 token，使 web-ui 可独立运行连接 NAS。

Output: 完整的会话列表 + CRUD 操作 + 连接设置页面。
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
@wzxClaw_desktop/src/renderer/components/chat/SessionList.tsx
@wzxClaw_desktop/src/renderer/components/ui/ContextMenu.tsx
@wzxClaw_desktop/src/renderer/components/settings/SettingsPage.tsx
@wzxClaw_desktop/src/renderer/stores/chat-store.ts (switchSession, loadSession, deleteSession, loadSessionList)

DataSource interface:
@packages/web-ui/src/data-source/types.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Complete chat-store session operations + SessionList component</name>
  <files>
    packages/web-ui/src/stores/chat-store.ts,
    packages/web-ui/src/stores/__tests__/chat-store-session.test.ts,
    packages/web-ui/src/components/chat/SessionList.tsx,
    packages/web-ui/src/components/ui/ContextMenu.tsx
  </files>
  <behavior>
    - Test 1: loadSessionList() 调用 dataSource.listSessions() 并更新 sessions 状态
    - Test 2: switchSession(sid) 调用 dataSource.loadSession(sid) 并更新 messages
    - Test 3: deleteSession(sid) 调用 dataSource.deleteSession(sid) 并从 sessions 移除
    - Test 4: renameSession(sid, title) 调用 dataSource.renameSession(sid, title)
  </behavior>
  <action>
    补全 chat-store 的 session 操作方法：

    1. **chat-store.ts 补充方法**（在 Plan 04b 的基础上添加）：
       - `loadSessionList()`: 调用 dataSource.listSessions()，set({ sessions })
       - `loadSession(sessionId)`: 调用 dataSource.loadSession(sessionId)，用 buildChatMessagesFromRaw 转换，更新 messages + conversationId
       - `switchSession(sessionId)`: 缓存当前会话（模块级 Map），加载目标会话（先查缓存再查 IPC），更新 activeSessionId。简化版 — 不做两阶段加载（tail+full），直接 loadSession
       - `deleteSession(sessionId)`: 调用 dataSource.deleteSession()，如果删除的是当前会话则 clearConversation()，刷新列表
       - `renameSession(sessionId, title)`: 调用 dataSource.renameSession()，更新 sessions 数组
       - `init()` 方法补充：启动时调用 loadSessionList()

    2. **ContextMenu.tsx**: 从桌面端 `components/ui/ContextMenu.tsx` 提取。通用右键菜单组件，不依赖 Electron。支持 items 数组（label, onClick, danger, separator）。

    3. **SessionList.tsx**: 从桌面端提取，调整：
       - 保留：搜索过滤、时间分组（today/yesterday/earlier）、右键菜单（删除、重命名、复制）
       - 保留：当前会话高亮、置顶功能
       - 移除：completedSessionIds 角标（简化）
       - 移除：runningSessionIds 指示（简化）
       - 移除：workspaceStore 依赖（无 workspace 概念）
       - 使用 useChatStore 的 sessions/switchSession/deleteSession/renameSession
       - 约 289 行 -> ~180 行

    4. **测试**: 4 个 session 操作测试，mock DataSource。
  </action>
  <verify>
    <automated>cd packages/web-ui && npx vitest run src/stores/__tests__/chat-store-session.test.ts</automated>
  </verify>
  <done>
    - chat-store 支持 loadSessionList/switchSession/deleteSession/renameSession
    - 4 个 session 测试通过
    - SessionList 组件渲染会话列表，支持搜索和分组
    - 右键菜单支持删除和重命名
  </done>
</task>

<task type="auto">
  <name>Task 2: Settings page + connection configuration + localStorage persistence</name>
  <files>
    packages/web-ui/src/components/settings/SettingsPage.tsx,
    packages/web-ui/src/styles/settings.css,
    packages/web-ui/src/hooks/useConnectionConfig.ts
  </files>
  <action>
    创建设置页面：

    1. **useConnectionConfig.ts**: 自定义 hook 管理 agent-server 连接配置。
       - 从 localStorage 读取/保存配置：agentUrl (string), token (string), language (string), themeMode ('dark'|'light')
       - 默认值：agentUrl = 'ws://localhost:8082', token = '', language = 'zh-CN', themeMode = 'dark'
       - saveConfig(config) 写入 localStorage
       - loadConfig() 从 localStorage 读取
       - 当 agentUrl 或 token 变化时，如果 DataSource 是 WebSocketDataSource 则触发 reconnect

    2. **SettingsPage.tsx**: 设置页面组件，包含两个分组：
       - **连接配置**: agent URL 输入框 + token 输入框（password 类型）+ 测试连接按钮（点击后尝试 WebSocketDataSource.connect()，显示成功/失败）
       - **外观**: 主题切换（dark/light）+ 语言切换（中文/英文）
       - 保存按钮将配置写入 localStorage
       - 样式与桌面端设置页面一致（暗色主题，card 布局）

    3. **settings.css**: 设置页面专用样式。暗色背景 + card 布局 + 输入框样式 + 按钮样式。

    4. **App.tsx 更新**: 添加路由逻辑 — 点击齿轮图标显示 SettingsPage，点击返回显示 ChatPanel。简单的状态切换即可（不需要 react-router）。
  </action>
  <verify>
    <automated>cd packages/web-ui && npm run typecheck</automated>
  </verify>
  <done>
    - SettingsPage 渲染连接配置表单
    - agentUrl 和 token 保存到 localStorage
    - 刷新页面后配置保留
    - 测试连接按钮可验证 WebSocket 可达性
    - 主题和语言可切换
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Settings -> localStorage | 连接配置（含 token）存储在浏览器本地 |
| Settings -> WebSocketDataSource | 用户输入的 URL 用于建立 WebSocket 连接 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-06 | I | SettingsPage | mitigate | agentUrl 输入验证：只允许 ws:// 和 wss:// 协议前缀，拒绝其他 |
| T-04-07 | S | localStorage token | accept | token 存储在用户浏览器本地，与 Electron 相同信任级别 |
</threat_model>

<verification>
1. `cd packages/web-ui && npm test` — session 测试 4 个通过 + chat-store 测试 6 个通过
2. `cd packages/web-ui && npm run typecheck` — 通过
3. Dev server 运行，Settings 页面可配置连接
</verification>

<success_criteria>
- chat-store session CRUD 完整（4 个测试通过）
- SessionList 渲染历史会话，支持搜索/分组/删除/重命名
- SettingsPage 配置 agent-server URL + token，保存到 localStorage
- 设置持久化，刷新后保留
</success_criteria>

<output>
After completion, create `.planning/phases/04-shared-web-ui/04c-SUMMARY.md`
</output>
