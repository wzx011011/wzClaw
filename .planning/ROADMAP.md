---
milestone: 'wzxClaw Brain-Hands-Session 全架构迁移'
status: 'in-progress'
created: '2026-05-14'
---

# ROADMAP: wzxClaw Brain-Hands-Session 全架构迁移

## Milestone Goal

将 wzxClaw 从 Pet 模式（Brain+Hands+Session 耦合在 Electron 中）迁移为 Cattle 模式（NAS 运行 Brain，桌面/手机为客户端，Hand 可插拔），同时统一桌面端和手机端技术栈为 React + TypeScript。

## Architecture Reference

详见 `.planning/phases/01-brain-hands-separation/01-PLAN.md`

---

## Phase 1: 提取 Brain 核心 ✓

- **Status**: complete
- **Goal**: AgentLoop + LLM Gateway + Context 成为独立 Node.js 包，脱离 Electron 依赖
- **Deliverable**: `packages/brain/` 可在 Node.js 环境独立运行，桌面端通过适配器桥接保持功能正常
- **Completed**: 2026-05-14
- **Plans:** 4/4 complete

Plans:

- [x] 01a-PLAN.md — 包脚手架 + 核心接口定义 + 纯逻辑模块
- [x] 01b-PLAN.md — LLM 层 + Context 管理层复制
- [x] 01c-PLAN.md — AgentLoop/TurnManager/StreamPhase 核心解耦（移除 Electron 依赖）
- [x] 01d-PLAN.md — 桌面端适配器桥接 + 功能验证（人工验证推迟）

## Phase 2: Agent 服务器 — NAS 部署 ✓

- **Status**: complete
- **Goal**: Brain 包作为 WebSocket 服务器部署到 NAS Docker，支持客户端和 Hand 双通道连接
- **Depends on**: Phase 1
- **Deliverable**: `packages/agent-server/` Docker 部署，`wss://5945.top/agent/` 可用
- **Completed**: 2026-05-14
- **Plans:** 3/3 complete

Plans:

- [x] 02a-PLAN.md — 包脚手架 + Token 认证 + SQLite SessionStore
- [x] 02b-PLAN.md — HandsRouter + HandAwareToolExecutor（Hand 路由 + 工具执行）
- [x] 02c-PLAN.md — ClientHandler + 服务器入口 + Docker + nginx

## Phase 3: Hand 服务 — 独立 npm 包 ✓

- **Status**: complete
- **Goal**: `wzxclaw-hand` 独立包，任何机器一行命令注册为 Brain 的 Hand
- **Depends on**: Phase 2
- **Deliverable**: `packages/hand/`，`npx wzxclaw-hand` 可连接 Brain 并执行工具
- **Completed**: 2026-05-14
- **Plans:** 2/2 complete

Plans:

- [x] 03a-PLAN.md — 包脚手架 + 协议层 + WebSocket 连接管理（注册/心跳/重连）
- [x] 03b-PLAN.md — 工具执行框架 + CLI 入口 + npx 支持

## Phase 4: 共享 Web UI — React SPA

- **Status**: complete
- **Goal**: 从桌面端 Renderer 提取共享 UI 层，支持 Electron 和 WebSocket 双数据源
- **Depends on**: Phase 2
- **Deliverable**: `packages/web-ui/` 可独立 dev server 运行，连接 NAS Brain 聊天正常
- **Completed**: 2026-05-14
- **Plans:** 5/5 complete

Plans:

- [x] 04a-PLAN.md — 包脚手架 + DataSource 抽象接口 + WebSocket 客户端 + IPC 桥接
- [x] 04b-PLAN.md — Chat store 提取重构 + 核心聊天 UI（MessageList/ChatMessage/ChatPanel）
- [x] 04c-PLAN.md — 会话管理 UI（SessionList CRUD）+ 设置面板 + 连接配置
- [x] 04d-PLAN.md — 工具调用可视化（ToolCard/ToolCallGroup）+ 代码块渲染（CodeBlock）
- [x] 04e-PLAN.md — DataSourceProvider + i18n + 全局样式 + App 组装 + 集成测试

## Phase 5: 桌面端改造 — Electron 壳 + Hand Bridge ✓

- **Status**: complete
- **Goal**: Electron 壳 web-ui，内置 Hand Bridge，连接 NAS Brain
- **Depends on**: Phase 3, Phase 4
- **Deliverable**: `desktop/` 重构完成，NAS Agent + 本地回退双模式
- **Completed**: 2026-05-16
- **Plans:** 4/4 complete

Plans:

- [x] 05-01-PLAN.md — Electron 壳重构（renderer 替换为 web-ui + preload 补充 + IPC 验证）
- [x] 05-02-PLAN.md — Hand Bridge 实现（Tool 适配 + 连接管理 + 工具路由 + 测试）
- [x] 05-03-PLAN.md — 双模式集成（主进程 HandBridge 集成 + 状态转发 + 本地回退保留）
- [x] 05-04-PLAN.md — 构建验证（dev/build:win 链路 + 人工验收 deferred）

## Phase 6: 手机端重建 — Capacitor 壳 ✓

- **Status**: complete
- **Goal**: Capacitor 壳 web-ui 替代 Flutter，直连 NAS Brain
- **Depends on**: Phase 4
- **Deliverable**: `mobile/` Capacitor 项目，APK 体验接近原生
- **Completed**: 2026-05-16
- **Plans:** 3/3 complete (human verification deferred)

Plans:

- [x] 06-01-PLAN.md — Capacitor 项目脚手架 + web-ui 移动端响应式 CSS + Android 项目初始化
- [x] 06-02-PLAN.md — 原生资源（图标/启动画面/状态栏）+ APK 构建链路验证
- [x] 06-03-PLAN.md — 移动端触摸优化 + 人工真机验收 (1/2 tasks automated, awaiting human verify)

## Phase 7: Docker Hand — NAS 本地沙箱 ✓

- **Status**: complete
- **Goal**: NAS 上运行 Docker Hand，桌面离线时手机可独立使用 Agent
- **Depends on**: Phase 3, Phase 6
- **Deliverable**: Docker Hand 启动 + Brain 路由 + 手机离线场景验证通过
- **Completed**: 2026-05-16
- **Plans:** 2/2 complete (NAS deployment verification deferred)

Plans:

- [x] 07-01-PLAN.md — NAS 工具实现（FileRead/FileWrite/FileList/ShellExecute）+ Docker Hand 入口 (50 tests, 105 total)
- [x] 07-02-PLAN.md — Dockerfile + docker-compose + nginx + 集成人工验收 (NAS deploy deferred)

## Phase 8: Hand 可插拔配置 + MCP/Skill 全链打通

- **Status**: in-progress
- **Goal**: Hand 走 "claude-code CLI + 配置文件" 模式；agent-server 注入 Skill/Command；桌面 Settings 作为统一 GUI 入口
- **Depends on**: Phase 7
- **Plans:** 2/5 complete (core done, UI + Docker deferred)

Plans:

- [x] 08-01-PLAN.md — Hand 侧 config-loader + mcp-manager 抽取（共享包）(124 tests)
- [x] 08-02-PLAN.md — agent-server Skill/Command 注入 + /admin/reload + hand:reload 控制帧 (56 tests)
- [ ] 08-03-PLAN.md — web-ui Settings 加 NAS Hand 配置 Tab + 桌面替换本地副本 (deferred)
- [ ] 08-04-PLAN.md — Docker 部署更新（共享 ~/.wzxclaw 挂载）+ 部署文档 (deferred)
- [ ] 08-05-PLAN.md — 端到端测试（L1 本地 docker-compose + L2 NAS ssh nas 真机）(plan exists)

## Phase 9: IDE 体验回归 web-ui

- **Status**: planned
- **Goal**: 把 master 桌面端的 IDELayout（Monaco/xterm/Preview/FileExplorer/Task/CommandPalette）迁到共享 web-ui，capability-driven 启用
- **Depends on**: Phase 4, Phase 8
- **Plans:** 5 planned

Plans:

- [ ] 09-01-PLAN.md — DataSource fs/terminal/preview 子接口 + capability hook
- [ ] 09-02-PLAN.md — Monaco EditorPanel + TabBar + diff/tab store
- [ ] 09-03-PLAN.md — xterm Terminal + FileExplorer + ActivityBar + Sidebar
- [ ] 09-04-PLAN.md — PreviewPanel + CommandPalette + StatusBar + TitleBar
- [ ] 09-05-PLAN.md — TaskHomePage + WorkspaceDetailPage 回归

## Phase 10: 手机端体验回归 Flutter 等价

- **Status**: planned
- **Goal**: Capacitor web-ui mobile 补齐原 Flutter 的 FileBrowser/DesktopPicker/MicButton/浮动 Bar/微动效
- **Depends on**: Phase 6, Phase 7, Phase 8
- **Plans:** 5 planned

Plans:

- [ ] 10-01-PLAN.md — MobileShell 布局 + BottomTabBar 4 Tab 导航
- [ ] 10-02-PLAN.md — FileBrowserPage + FileViewerPage（基于 NAS Hand FileList/Read）
- [ ] 10-03-PLAN.md — DesktopPicker + 浮动 PermissionBar/PlanModeBar
- [ ] 10-04-PLAN.md — Capacitor 原生能力：MicButton/Haptics/StatusBar/Keyboard
- [ ] 10-05-PLAN.md — 微动效 + 视觉一致性（10-VISUAL.md 截图对照）

---

## Phase 11: Brain 包补全（架构漂移纠正 Wave 1）

- **Status**: planned
- **Goal**: 补齐 Brain 包中缺失的模块（system-prompt-builder 完整版、10 个 context 模块、observability/hooks/memory、permission 逻辑），让 agent-server 能完整运行，无 Electron 依赖
- **Depends on**: Phase 1
- **Deliverable**: `packages/brain/` 包含完整 Agent 运行时所需的全部逻辑，Desktop 通过 DI 接口注入 Electron 实现
- **Plans:** 4 planned

Plans:

- [ ] 11-01-PLAN.md — 提取 system-prompt-builder 完整版到 Brain（169 行，抽象 IFileReader/IEnvInfoProvider）
- [ ] 11-02-PLAN.md — 提取 10 个缺失 context 模块到 Brain（~1024 行移动 + 接口抽象）
- [ ] 11-03-PLAN.md — 提取 observability/langfuse-observer + hooks/hook-registry + memory/ 到 Brain（~450 行）
- [ ] 11-04-PLAN.md — 提取 permission 判断逻辑到 Brain（IPermissionHandler 接口，UI 弹窗留 Desktop）

## Phase 12: Agent Server 全接线（架构漂移纠正 Wave 2）

- **Status**: planned
- **Goal**: 让 agent-server 能真正运行 AgentLoop：创建真实工厂接线、API Key NAS 环境变量管理、补全 WebSocket 协议端点、统一 Desktop/Brain 类型系统
- **Depends on**: Phase 11
- **Deliverable**: agent-server 启动后客户端可连接并正常对话，所有 WebSocketDataSource 方法可用
- **Plans:** 4 planned

Plans:

- [ ] 12-01-PLAN.md — AgentLoop 工厂接线：注入 gateway/contextManager/systemPromptBuilder，替换 throw stub（~100 行）
- [ ] 12-02-PLAN.md — API Key 管理：agent-server 从 NAS 环境变量/~/.wzxclaw/keys.json 读取，不依赖 Desktop
- [ ] 12-03-PLAN.md — 补全 agent-server 协议端点：stopGeneration/renameSession + WebSocketDataSource 完整实现（~80 行）
- [ ] 12-04-PLAN.md — 统一类型系统：Brain/Desktop 共享类型改为 @wzxclaw/shared，消除重复定义（~200 行重构）

## Phase 13: Desktop 完全瘦身（架构漂移纠正 Wave 3）

- **Status**: planned
- **Goal**: 删除 Desktop 所有已迁移到 Brain 的重复代码（~3900 行），Desktop 改为通过 agent-server 通信，Hand Bridge 成为唯一工具执行路径
- **Depends on**: Phase 12, Phase 5
- **Deliverable**: Desktop 不含任何 Brain 逻辑，启动后通过 WS 连接 agent-server，作为 Hand 注册并执行工具
- **Plans:** 4 planned

Plans:

- [ ] 13-01-PLAN.md — 删除 Desktop 重复 Brain 模块：agent/_.ts（15 文件）+ context/_.ts（7 文件）+ llm/\*.ts（6 文件）
- [ ] 13-02-PLAN.md — Desktop 主进程改为 agent-server WS 客户端（brain-bridge.ts 变为 WS 适配器，~200 行）
- [ ] 13-03-PLAN.md — Hand Bridge 成为唯一工具执行路径（hand-bridge.ts 开机自启 + 自动重连，~50 行）
- [ ] 13-04-PLAN.md — 清理 Desktop mobile relay 代码（src/main/mobile/ 大幅简化，~800 行删除）

## Phase 14: Mobile Capacitor 完成（架构漂移纠正 Wave 4）

- **Status**: planned
- **Goal**: Capacitor 壳复用 web-ui 替代 Flutter，直连 NAS agent-server，Flutter 项目归档
- **Depends on**: Phase 12, Phase 6
- **Deliverable**: Capacitor Android APK 可用，web-ui 在手机浏览器和 Capacitor 中响应式正常，Flutter 标注 deprecated
- **Plans:** 3 planned

Plans:

- [ ] 14-01-PLAN.md — 创建 Capacitor 项目（基于 web-ui webDir，Android 平台，WS 连接 agent-server，Android 权限）
- [ ] 14-02-PLAN.md — web-ui 移动端适配（响应式布局/触摸交互/移动端导航，~500 行 CSS + 组件）
- [ ] 14-03-PLAN.md — 弃用 Flutter：wzxClaw_android/ README 标注 deprecated，移除构建脚本引用

## Phase 15: 部署与端到端验证（架构漂移纠正 Wave 5）

- **Status**: planned
- **Goal**: NAS Docker 部署 agent-server，端到端验证完整流程（Desktop/Mobile → Brain → Hand → 工具执行 → 结果），更新架构文档
- **Depends on**: Phase 13, Phase 14, Phase 7
- **Deliverable**: agent-server 在 wss://agent.5945.top 可用，7 个 E2E 场景全部通过，CLAUDE.md/docs 更新
- **Plans:** 3 planned

Plans:

- [ ] 15-01-PLAN.md — NAS agent-server Docker 部署：Dockerfile/docker-compose/nginx/环境变量配置
- [ ] 15-02-PLAN.md — 端到端集成测试：7 场景（Desktop/Mobile 连接、Brain AgentLoop、HandsRouter 路由、NAS Hand 工具、Session SQLite）
- [ ] 15-03-PLAN.md — 更新架构文档：CLAUDE.md + docs/architecture.html + .planning/codebase/ARCHITECTURE.md
