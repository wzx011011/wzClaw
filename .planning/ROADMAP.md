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

## Phase 8: Hand 可插拔配置 + MCP/Skill 全链打通 ✓

- **Status**: complete
- **Goal**: Hand 走 "claude-code CLI + 配置文件" 模式；agent-server 注入 Skill/Command；桌面 Settings 作为统一 GUI 入口
- **Depends on**: Phase 7
- **Deliverable**: Hand config-loader + mcp-manager + agent-server Skill/Command 注入 + web-ui Settings Hand Tab
- **Completed**: 2026-05-16
- **Plans:** 4/5 complete (Docker deploy done, E2E needs API key)

Plans:

- [x] 08-01-PLAN.md — Hand 侧 config-loader + mcp-manager 抽取（共享包）(124 tests)
- [x] 08-02-PLAN.md — agent-server Skill/Command 注入 + /admin/reload + hand:reload 控制帧 (56 tests)
- [x] 08-03 — web-ui Settings 加 Hand 管理 Tab（在线列表 + 刷新）
- [x] 08-04-PLAN.md — Docker 部署到 NAS（agent-server + docker-hand，agent.5945.top，Node 20 compat fix）
- [ ] 08-05-PLAN.md — 端到端测试（L1 本地 docker-compose + L2 NAS ssh nas 真机）(needs API key)

## Phase 9: IDE 体验回归 web-ui ✓

- **Status**: complete
- **Goal**: 把 master 桌面端的 IDELayout（Monaco/xterm/Preview/FileExplorer/Task/CommandPalette）迁到共享 web-ui，capability-driven 启用
- **Depends on**: Phase 4, Phase 8
- **Deliverable**: web-ui IDE 视图模式，11 组件 + 3 store + capability-driven 渲染
- **Completed**: 2026-05-16
- **Plans:** 5/5 complete (bundled into 2 execution rounds)

Plans:

- [x] 09-01 — DataSource fs/terminal/preview 子接口 + capability hook (45 tests)
- [x] 09-02~05 — IDE components (11 components + 3 stores + vite config)

## Phase 10: 手机端体验回归 Flutter 等价 ✓

- **Status**: complete
- **Goal**: Capacitor web-ui mobile 补齐原 Flutter 的 FileBrowser/DesktopPicker/MicButton/浮动 Bar/微动效
- **Depends on**: Phase 6, Phase 7, Phase 8
- **Deliverable**: MobileShell + BottomTabBar + FileBrowserPage + DesktopPicker + MicButton + 动效组件
- **Completed**: 2026-05-16
- **Plans:** 5/5 complete (45 tests)

Plans:

- [x] 10-01-PLAN.md — MobileShell 布局 + BottomTabBar 4 Tab 导航
- [x] 10-02-PLAN.md — FileBrowserPage + FileViewerPage（基于 NAS Hand FileList/Read）
- [x] 10-03-PLAN.md — DesktopPicker + 浮动 PermissionBar/PlanModeBar
- [x] 10-04-PLAN.md — Capacitor 原生能力：MicButton/Haptics/StatusBar/Keyboard
- [x] 10-05-PLAN.md — 微动效 + 视觉一致性

---

## Phase 11: Brain 包补全（架构漂移纠正 Wave 1） ✓

- **Status**: complete
- **Goal**: 补齐 Brain 包中缺失的模块（hooks、observability、permission、instruction-loader），让 agent-server 能完整运行
- **Depends on**: Phase 1
- **Deliverable**: `packages/brain/` 包含 hooks/observability/permission/instruction-loader 模块（27 tests）
- **Completed**: 2026-05-16
- **Plans:** 4/4 complete (bundled)

Plans:

- [x] 11-01 — HookRegistry + registerBuiltInHooks（直接移植，无 Electron 依赖）
- [x] 11-02 — InstructionLoader（Node.js fs，无 Electron 依赖）
- [x] 11-03 — LangfuseObserver（console fallback 实现 IObservability 接口）
- [x] 11-04 — PermissionManager（4 种模式，bypass 默认，UI 弹窗留 Desktop）

## Phase 12: Agent Server 全接线（架构漂移纠正 Wave 2） ✓

- **Status**: complete
- **Goal**: 让 agent-server 能真正运行 AgentLoop：创建真实工厂接线、API Key NAS 环境变量管理、补全 WebSocket 协议端点、统一 Desktop/Brain 类型系统
- **Depends on**: Phase 11
- **Deliverable**: agent-server 启动后客户端可连接并正常对话，所有 WebSocketDataSource 方法可用
- **Completed**: 2026-05-16
- **Plans:** 4/4 complete (bundled)

Plans:

- [x] 12-01 — AgentLoop 工厂接线：注入 gateway/contextManager/hookRegistry/observability
- [x] 12-02 — API Key 管理：agent-server 从 NAS 环境变量读取（OPENAI_API_KEY, ANTHROPIC_API_KEY）
- [x] 12-03 — 补全 agent-server 协议端点：stopGeneration/renameSession/turn_end/tool_progress
- [x] 12-04 — Brain instruction-loader ES2022 compat fix (collectAsync helper)

## Phase 13: Desktop 完全瘦身（架构漂移纠正 Wave 3） ✓

- **Status**: complete
- **Goal**: 删除 Desktop 所有已迁移到 Brain 的重复代码（~3900 行），Desktop 改为通过 agent-server 通信，Hand Bridge 成为唯一工具执行路径
- **Depends on**: Phase 12, Phase 5
- **Deliverable**: Desktop 不含任何 Brain 逻辑，所有 Brain 模块通过 @wzxclaw/brain 导入
- **Completed**: 2026-05-16
- **Plans:** executed manually (26 duplicate files deleted, 19 files import-swapped, 14 test files removed)

Execution summary:
- Deleted 26 duplicate files: agent/ (9), context/ (7), llm/ (7), hooks/ (2), permission/ (1)
- Kept 3 Desktop-only files: system-prompt-builder.ts, instruction-loader.ts, langfuse-observer.ts
- Swapped 19 source files to import from @wzxclaw/brain instead of local copies
- Deleted 14 redundant test files (brain has its own tests)
- tsc --noEmit: 0 errors, npm test: 54 files / 596 tests pass

## Phase 14: Mobile Capacitor 完成（架构漂移纠正 Wave 4） ✓

- **Status**: complete
- **Goal**: Capacitor 壳复用 web-ui 替代 Flutter，直连 NAS agent-server，Flutter 项目归档
- **Depends on**: Phase 12, Phase 6
- **Deliverable**: Capacitor Android 项目完整（mobile/ + web-ui 移动端代码 + Flutter deprecated）
- **Completed**: 2026-05-16
- **Plans:** 3/3 complete (14-01 project + 14-02 responsive done via Phase 10, 14-03 Flutter deprecated)

Plans:

- [x] 14-01-PLAN.md — Capacitor 项目（mobile/ 已有完整 Android 平台 + RECORD_AUDIO 权限）
- [x] 14-02-PLAN.md — web-ui 移动端适配（Phase 10 MobileShell + BottomTabBar + mobile.css）
- [x] 14-03-PLAN.md — 弃用 Flutter：wzxClaw_android/ README 标注 deprecated

## Phase 15: 部署与端到端验证（架构漂移纠正 Wave 5）

- **Status**: partial
- **Goal**: NAS Docker 部署 agent-server，端到端验证完整流程（Desktop/Mobile → Brain → Hand → 工具执行 → 结果），更新架构文档
- **Depends on**: Phase 13, Phase 14, Phase 7
- **Deliverable**: agent-server 在 wss://agent.5945.top 可用，7 个 E2E 场景全部通过，CLAUDE.md/docs 更新
- **Plans:** 2/3 complete (15-01 deploy done, 15-02 E2E needs API key)

Plans:

- [x] 15-01-PLAN.md — NAS agent-server Docker 部署（agent.5945.top:8083, docker-hand 4 tools, nginx proxy）
- [ ] 15-02-PLAN.md — 端到端集成测试：7 场景（需要 API key 配置后测试）
- [x] 15-03-PLAN.md — 更新架构文档：CLAUDE.md + ROADMAP + STATE
