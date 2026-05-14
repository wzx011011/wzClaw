---
phase: 04-shared-web-ui
plan: 05
type: execute
wave: 4
depends_on: ["04b", "04c", "04d"]
files_modified:
  - packages/web-ui/src/App.tsx
  - packages/web-ui/src/providers/DataSourceProvider.tsx
  - packages/web-ui/src/i18n/i18n-store.ts
  - packages/web-ui/src/i18n/locales/zh-CN.ts
  - packages/web-ui/src/i18n/locales/en-US.ts
  - packages/web-ui/src/i18n/useT.ts
  - packages/web-ui/src/stores/settings-store.ts
  - packages/web-ui/src/styles/global.css
  - packages/web-ui/src/styles/variables.css
autonomous: true
requirements:
  - WEBUI-12
  - WEBUI-13
  - WEBUI-14

must_haves:
  truths:
    - "Dev server 启动后浏览器可访问完整聊天界面"
    - "配置 NAS agent-server URL 后，发送消息可收到流式回复"
    - "会话列表显示历史会话，可切换"
    - "连接断开时 UI 显示断开状态，重连后自动恢复"
    - "i18n 支持中文和英文切换"
    - "npm run build 输出可部署的静态文件"
  artifacts:
    - path: "packages/web-ui/src/App.tsx"
      provides: "应用主入口 — 路由 + DataSourceProvider"
    - path: "packages/web-ui/src/providers/DataSourceProvider.tsx"
      provides: "React Context 提供 DataSource 实例"
    - path: "packages/web-ui/src/i18n/i18n-store.ts"
      provides: "Zustand i18n store"
    - path: "packages/web-ui/src/i18n/locales/zh-CN.ts"
      provides: "中文翻译"
    - path: "packages/web-ui/src/i18n/locales/en-US.ts"
      provides: "英文翻译"
    - path: "packages/web-ui/src/styles/variables.css"
      provides: "CSS 变量（颜色、间距、字体）"
  key_links:
    - from: "packages/web-ui/src/App.tsx"
      to: "packages/web-ui/src/providers/DataSourceProvider.tsx"
      via: "React Context 包裹整个应用"
      pattern: "DataSourceProvider"
    - from: "packages/web-ui/src/providers/DataSourceProvider.tsx"
      to: "packages/web-ui/src/data-source/types.ts"
      via: "创建并管理 DataSource 实例"
      pattern: "WebSocketDataSource|IpcDataSource"
    - from: "packages/web-ui/src/App.tsx"
      to: "packages/web-ui/src/i18n/i18n-store.ts"
      via: "initLocale 初始化语言"
      pattern: "initLocale"
---

<objective>
组装完整 SPA — DataSourceProvider + i18n + 全局样式 + 应用入口路由 + 独立 dev server 验证。

Purpose: 将前 4 个 plan 的产出整合为可运行的完整 SPA。DataSourceProvider 作为 React Context 向所有组件注入 DataSource 实例。i18n 提供中英文切换。全局 CSS 变量统一主题。最终 dev server 启动后可连接 NAS agent-server 进行完整聊天测试。

Output: 完整可运行的 web-ui SPA，`npm run dev` 启动后浏览器可正常使用。
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
@.planning/phases/04-shared-web-ui/04b-SUMMARY.md
@.planning/phases/04-shared-web-ui/04c-SUMMARY.md
@.planning/phases/04-shared-web-ui/04d-SUMMARY.md

Desktop i18n source:
@wzxClaw_desktop/src/renderer/i18n/i18n-store.ts
@wzxClaw_desktop/src/renderer/i18n/useT.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: DataSourceProvider + i18n system + global CSS + App assembly</name>
  <files>
    packages/web-ui/src/providers/DataSourceProvider.tsx,
    packages/web-ui/src/i18n/i18n-store.ts,
    packages/web-ui/src/i18n/locales/zh-CN.ts,
    packages/web-ui/src/i18n/locales/en-US.ts,
    packages/web-ui/src/i18n/useT.ts,
    packages/web-ui/src/i18n/formatRelativeTime.ts,
    packages/web-ui/src/stores/settings-store.ts,
    packages/web-ui/src/styles/global.css,
    packages/web-ui/src/styles/variables.css,
    packages/web-ui/src/App.tsx
  </files>
  <action>
    创建应用壳和基础设施：

    1. **DataSourceProvider.tsx**: React Context provider。
       - 创建和管理 DataSource 实例（根据环境选择 WebSocket 或 IPC）
       - 从 useConnectionConfig hook 读取连接配置
       - 提供 useDataSource() hook 供子组件获取 DataSource 实例
       - 监听 connectionChange 事件，更新 UI 连接状态指示器
       - 组件挂载时调用 dataSource.connect()，卸载时调用 dataSource.disconnect()
       - 当 agentUrl/token 配置变更时，断开旧连接、创建新 DataSource、重新连接

    2. **i18n 系统**: 从桌面端提取并简化：
       - `i18n-store.ts`: Zustand store，管理 currentLocale 状态。提供 t(key, params?) 翻译函数和 initLocale(language) 初始化。支持嵌套 key（'chat.send' -> obj.chat.send）和参数替换（'{count}' -> value）
       - `locales/zh-CN.ts`: 从桌面端 locales/zh-CN.ts 提取聊天相关翻译（约 100 个 key）。只提取 web-ui 使用的 key：chat.*, session.*, settings.*, tool.*, common.* 等
       - `locales/en-US.ts`: 对应英文翻译
       - `useT.ts`: React hook，返回 t 函数。subscribe to locale changes
       - `formatRelativeTime.ts`: 从桌面端提取。时间相对格式化（"3 分钟前"、"昨天"）

    3. **settings-store.ts**: web-ui 版本的设置 store。
       - 不依赖 IPC，直接读写 localStorage
       - 状态：agentUrl, token, language, themeMode
       - 与 useConnectionConfig hook 协同工作

    4. **CSS 变量和全局样式**:
       - `variables.css`: CSS 自定义属性（暗色主题颜色、间距、圆角、字体、阴影）
       - `global.css`: 全局重置 + body 样式 + 滚动条样式
       - 变量定义与桌面端 ide.css 保持一致（--bg-primary, --bg-secondary, --text-primary, --accent-green 等）

    5. **App.tsx 重写**: 完整应用入口：
       - DataSourceProvider 包裹整个应用
       - 顶部导航栏：wzxClaw logo + 连接状态指示灯（绿色=已连接，红色=断开，灰色=未配置）+ 设置齿轮按钮
       - 主体区域：左侧 SessionList（可折叠）+ 右侧 ChatPanel
       - SettingsPage 作为覆盖层（点击齿轮按钮弹出）
       - 响应式布局：桌面端侧边栏+聊天面板，移动端全屏聊天+底部导航
       - 启动时：读取 localStorage 配置 -> 初始化 DataSource -> 连接 agent-server -> 加载会话列表
  </action>
  <verify>
    <automated>cd packages/web-ui && npm run typecheck && npm run build</automated>
  </verify>
  <done>
    - DataSourceProvider 创建和管理 DataSource 实例
    - i18n 支持中英文，t() 函数正确翻译
    - CSS 变量定义暗色主题
    - App.tsx 渲染完整布局（导航栏 + SessionList + ChatPanel）
    - npm run dev 启动后浏览器显示完整聊天界面
    - npm run build 输出 dist/ 静态文件
  </done>
</task>

<task type="auto">
  <name>Task 2: End-to-end integration test + build verification</name>
  <files>
    packages/web-ui/src/__tests__/integration.test.ts,
    packages/web-ui/vite.config.ts
  </files>
  <action>
    编写集成测试并验证完整构建：

    1. **integration.test.ts**: 端到端集成测试（不依赖真实 agent-server）：
       - 创建 mock WebSocket server (使用 ws 库)
       - 测试完整的消息收发流程：createSession -> sendMessage -> 收到 stream:text -> 收到 stream:done
       - 测试 session CRUD：createSession -> listSessions (包含新 session) -> deleteSession -> listSessions (不包含)
       - 测试连接断开和重连：模拟 ws.close() -> 验证 onConnectionChange(false) -> 模拟重连 -> 验证 onConnectionChange(true)
       - 测试设置持久化：保存 agentUrl -> 重新创建 DataSource -> 验证使用新 URL
       - 共 5 个集成测试

    2. **vite.config.ts 更新**: 确保构建配置正确：
       - 输出目录 dist/
       - chunk 分割策略：vendor (react, react-dom, zustand) + markdown (react-markdown, remark-gfm, rehype-raw) + highlight (highlight.js) + app
       - 环境变量 VITE_AGENT_URL 替换
       - base: './' 使构建产物可部署到任意路径

    3. **验证 npm run build**: 确保构建成功，输出 dist/index.html + JS/CSS chunks。
  </action>
  <verify>
    <automated>cd packages/web-ui && npm test && npm run build</automated>
  </verify>
  <done>
    - 5 个集成测试通过
    - npm run build 构建成功
    - dist/ 包含 index.html + JS/CSS chunks
    - 构建产物可部署到静态服务器
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| browser -> NAS agent-server | 跨网络 WebSocket 连接，需要 wss:// 加密 |
| localStorage -> DataSource | 本地存储的 URL 和 token 用于建立连接 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-10 | T | DataSourceProvider | mitigate | 连接 URL 校验只允许 ws:// 和 wss://，连接状态显示在 UI 上 |
| T-04-11 | E | i18n store | accept | 翻译文件是静态的，不可被外部修改 |
</threat_model>

<verification>
1. `cd packages/web-ui && npm test` — 所有测试通过（单元 + 集成 ~20 个）
2. `cd packages/web-ui && npm run typecheck` — 类型检查通过
3. `cd packages/web-ui && npm run build` — 构建成功
4. `cd packages/web-ui && npm run dev` — Vite dev server 启动，浏览器可访问
5. 浏览器中配置 NAS agent-server URL 后可发送消息并收到流式回复
</verification>

<success_criteria>
- DataSourceProvider 向组件注入 DataSource 实例
- i18n 支持中英文切换
- CSS 变量定义一致的暗色主题
- App.tsx 完整布局：导航栏 + SessionList + ChatPanel
- npm run dev 启动，浏览器显示完整聊天界面
- npm run build 输出可部署静态文件
- 5 个集成测试通过
- 配置 NAS URL 后可完整聊天
</success_criteria>

<output>
After completion, create `.planning/phases/04-shared-web-ui/04e-SUMMARY.md`
</output>
