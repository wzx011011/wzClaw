---
phase: 04-shared-web-ui
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/web-ui/package.json
  - packages/web-ui/tsconfig.json
  - packages/web-ui/tsconfig.node.json
  - packages/web-ui/vite.config.ts
  - packages/web-ui/index.html
  - packages/web-ui/src/main.tsx
  - packages/web-ui/src/App.tsx
  - packages/web-ui/src/vite-env.d.ts
  - packages/web-ui/src/data-source/types.ts
  - packages/web-ui/src/data-source/websocket-source.ts
  - packages/web-ui/src/data-source/ipc-source.ts
  - packages/web-ui/src/data-source/index.ts
  - packages/web-ui/src/data-source/__tests__/websocket-source.test.ts
  - packages/web-ui/src/data-source/__tests__/ipc-source.test.ts
autonomous: true
requirements:
  - WEBUI-01
  - WEBUI-02
  - WEBUI-03

must_haves:
  truths:
    - "Vite dev server 在 localhost:5173 启动，渲染空白 App 壳"
    - "DataSource 接口定义了 sendMessage, onStreamEvent, listSessions 等核心方法"
    - "WebSocketDataSource 能连接到 agent-server 并收发 chat:send / stream:text 事件"
    - "IpcDataSource 代理到 window.wzxclaw 保持桌面端兼容"
  artifacts:
    - path: "packages/web-ui/package.json"
      provides: "包配置，含 React 19 + Zustand 5 + Vite 依赖"
    - path: "packages/web-ui/src/data-source/types.ts"
      provides: "DataSource 接口定义"
      contains: "interface DataSource"
    - path: "packages/web-ui/src/data-source/websocket-source.ts"
      provides: "WebSocket 实现的 DataSource"
      exports: ["WebSocketDataSource"]
    - path: "packages/web-ui/src/data-source/ipc-source.ts"
      provides: "Electron IPC 实现的 DataSource"
      exports: ["IpcDataSource"]
  key_links:
    - from: "packages/web-ui/src/data-source/websocket-source.ts"
      to: "agent-server ClientHandler protocol"
      via: "WebSocket JSON messages { event, data }"
      pattern: "ws\\.send|ws\\.on\\('message'"
    - from: "packages/web-ui/src/data-source/ipc-source.ts"
      to: "window.wzxclaw preload API"
      via: "window.wzxclaw method calls"
      pattern: "window\\.wzxclaw"
---

<objective>
创建 web-ui 包脚手架 + DataSource 抽象层 + WebSocket 客户端实现。

Purpose: 这是 Phase 4 的基础设施层。DataSource 接口定义了所有 UI 组件与后端通信的统一契约，让同一个 React UI 既能连接远程 NAS agent-server，也能桥接桌面端 Electron IPC。

Output: packages/web-ui/ 可 `npm run dev` 启动 Vite dev server；DataSource 接口 + 两个实现 + 单元测试。
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

Agent-server client protocol (from Phase 2):
@packages/agent-server/src/client-handler.ts
@packages/agent-server/src/types.ts

Desktop preload API (the API surface to mirror):
@wzxClaw_desktop/src/preload/index.ts

Shared types:
@wzxClaw_desktop/src/shared/types.ts
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Package scaffolding + DataSource interface + WebSocket client</name>
  <files>
    packages/web-ui/package.json,
    packages/web-ui/tsconfig.json,
    packages/web-ui/tsconfig.node.json,
    packages/web-ui/vite.config.ts,
    packages/web-ui/index.html,
    packages/web-ui/src/main.tsx,
    packages/web-ui/src/App.tsx,
    packages/web-ui/src/vite-env.d.ts,
    packages/web-ui/src/data-source/types.ts,
    packages/web-ui/src/data-source/websocket-source.ts,
    packages/web-ui/src/data-source/__tests__/websocket-source.test.ts
  </files>
  <behavior>
    - Test 1: WebSocketDataSource 连接 ws server 后调用 onConnectionChange(true)
    - Test 2: WebSocketDataSource 发送 chat:send 并收到 stream:text 事件
    - Test 3: WebSocketDataSource 断线后指数退避重连（mock WebSocket）
    - Test 4: WebSocketDataSource session:list 发送并解析响应
    - Test 5: DataSource 接口类型检查 — WebSocketDataSource implements DataSource
  </behavior>
  <action>
    创建 packages/web-ui/ 完整包脚手架：

    1. **package.json**: name "@wzxclaw/web-ui", type "module", React 19 + Zustand 5 + uuid + vitest。scripts: dev (vite), build (vite build), test (vitest run), typecheck (tsc --noEmit)。不引入 Monaco/xterm/Allotment 等 Electron 重型依赖。

    2. **tsconfig.json**: target ES2022, module ESNext, moduleResolution bundler, jsx react-jsx。Include src/, exclude **/*.test.ts。

    3. **tsconfig.node.json**: 给 vite.config.ts 用的 Node 端 tsconfig。

    4. **vite.config.ts**: React 插件，dev server port 5173，proxy /api 到 agent-server。定义 VITE_AGENT_URL 环境变量（默认 ws://localhost:8082）。

    5. **index.html**: 标准 Vite SPA 入口，div#root。

    6. **src/main.tsx**: React root render, import App。

    7. **src/App.tsx**: 最小壳组件 — 渲染 "wzxClaw Web UI" 标题 + 连接状态指示器。

    8. **src/data-source/types.ts**: 定义 DataSource 接口（per D-01）。核心方法：
       - connect()/disconnect()/isConnected()/onConnectionChange()
       - sendMessage(sessionId, content, options?)
       - stopGeneration(sessionId)
       - onStreamEvent(eventType, callback) — 统一所有 stream 事件订阅
       - listSessions()/loadSession(sessionId)/createSession()/deleteSession(sessionId)/renameSession(sessionId, title)
       - getSettings()/updateSettings(settings)
       同时导出 StreamEventType 联合类型：'text' | 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'done' | 'compacted' | 'tool_progress' | 'turn_end'
       以及各事件 payload 类型，从 @wzxclaw/brain 或桌面端 shared/types.ts 中提取。

    9. **src/data-source/websocket-source.ts**: WebSocketDataSource implements DataSource。
       - 构造参数：url (string), token? (string)
       - connect(): new WebSocket(url, token ? [token] : undefined)，等待 open 事件
       - 内部 _listeners: Map<StreamEventType, Set<Function>> 管理事件订阅
       - on('message') 处理器按 event 字段分发到 _listeners
       - chat:send 映射为 ws.send({ event: 'chat:send', data: { sessionId, message } })
       - session:list/load/create/delete 映射为对应 ws.send，返回 Promise（通过一次性的 message listener 等待响应）
       - 重连逻辑：指数退避 1s→2s→4s→8s→16s→30s cap，重连后触发 onConnectionChange(true)
       - 代码注释用中文

    10. **测试文件**: 用 vitest + mock WebSocket。5 个测试覆盖连接/发送/接收/重连/会话操作。Mock WebSocket 方式：创建一个简单的 FakeWebSocket 类模拟 open/message/close 事件。
  </action>
  <verify>
    <automated>cd packages/web-ui && npm test</automated>
  </verify>
  <done>
    - package.json 存在，dependencies 包含 react, zustand, uuid, vitest
    - DataSource 接口导出所有必要方法签名
    - WebSocketDataSource implements DataSource，5 个测试全部通过
    - npm run dev 启动 Vite dev server 无报错
    - npm run typecheck 通过
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: IpcDataSource (Electron bridge) + DataSource index export</name>
  <files>
    packages/web-ui/src/data-source/ipc-source.ts,
    packages/web-ui/src/data-source/__tests__/ipc-source.test.ts,
    packages/web-ui/src/data-source/index.ts
  </files>
  <behavior>
    - Test 1: IpcDataSource.sendMessage 调用 window.wzxclaw.sendMessage 并传参正确
    - Test 2: IpcDataSource.onStreamEvent('text', cb) 订阅 window.wzxclaw.onStreamText
    - Test 3: IpcDataSource.listSessions 调用 window.wzxclaw.listSessions
    - Test 4: IpcDataSource 检测 window.wzxclaw 不存在时 connect() reject
  </behavior>
  <action>
    创建 IpcDataSource 实现：

    1. **src/data-source/ipc-source.ts**: IpcDataSource implements DataSource。
       - 构造函数检测 `typeof window !== 'undefined' && window.wzxclaw`，不存在则标记为不可用
       - connect(): 检测 window.wzxclaw 存在，resolve；不存在则 reject(new Error('Electron preload API not available'))
       - disconnect()/isConnected(): 无操作（IPC 不需要显式连接管理）
       - sendMessage(): 调用 window.wzxclaw.sendMessage({ conversationId, content, images })
       - onStreamEvent(): 根据 eventType 映射到 window.wzxclaw.onStreamText/onStreamThinking/onStreamToolStart/onStreamToolResult/onStreamEnd/onStreamError 等，统一返回 unsubscribe 函数
       - listSessions/loadSession/createSession/deleteSession/renameSession: 逐一映射到 window.wzxclaw 对应方法，注意参数格式转换（DataSource 接口的简化参数 -> IPC 的 request 对象）
       - getSettings/updateSettings: 映射到 window.wzxclaw.getSettings/updateSettings
       - 代码注释用中文

    2. **测试文件**: 用 vitest，mock window.wzxclaw 全局对象。4 个测试。

    3. **src/data-source/index.ts**: 导出 DataSource interface, WebSocketDataSource, IpcDataSource, 所有 stream event 类型。提供 createDataSource() 工厂函数：检测环境，如果有 window.wzxclaw 返回 IpcDataSource，否则返回 WebSocketDataSource。
  </action>
  <verify>
    <automated>cd packages/web-ui && npm test</automated>
  </verify>
  <done>
    - IpcDataSource implements DataSource，所有方法映射到 window.wzxclaw
    - 4 个测试全部通过
    - createDataSource() 工厂函数根据环境自动选择实现
    - data-source/index.ts 统一导出
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> WebSocket server | WebSocket 连接使用 token 认证，但数据在网络上明文传输（ws://） |
| browser -> Electron IPC | 本地信任边界，preload 脚本受 Electron 安全策略保护 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-01 | I | WebSocketDataSource | mitigate | 连接 URL 必须是 ws:// 或 wss://，拒绝 javascript: 和其他协议 |
| T-04-02 | T | WebSocketDataSource | mitigate | 服务端 token 认证，消息格式校验（JSON parse + event 白名单） |
| T-04-03 | D | IpcDataSource | accept | IPC 通道由 Electron 保护，本地信任环境 |
</threat_model>

<verification>
1. `cd packages/web-ui && npm install && npm run dev` — Vite dev server 启动无报错
2. `cd packages/web-ui && npm test` — 所有测试通过（9 个）
3. `cd packages/web-ui && npm run typecheck` — 类型检查通过
4. 浏览器访问 http://localhost:5173 显示 "wzxClaw Web UI" 标题
</verification>

<success_criteria>
- packages/web-ui/ 包完整脚手架（package.json, tsconfig, vite config, index.html）
- DataSource 接口定义了 15+ 方法的完整契约
- WebSocketDataSource 连接/发送/接收/重连 4 个测试通过
- IpcDataSource 代理到 window.wzxclaw 4 个测试通过
- Vite dev server 可启动
- npm run typecheck 通过
</success_criteria>

<output>
After completion, create `.planning/phases/04-shared-web-ui/04a-SUMMARY.md`
</output>
