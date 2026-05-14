---
milestone: "wzxClaw Brain-Hands-Session 全架构迁移"
status: "in-progress"
created: "2026-05-14"
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

## Phase 2: Agent 服务器 — NAS 部署

- **Status**: planned
- **Goal**: Brain 包作为 WebSocket 服务器部署到 NAS Docker，支持客户端和 Hand 双通道连接
- **Depends on**: Phase 1
- **Deliverable**: `packages/agent-server/` Docker 部署，`wss://5945.top/agent/` 可用
- **Plans:** 3 plans

Plans:
- [x] 02a-PLAN.md — 包脚手架 + Token 认证 + SQLite SessionStore
- [ ] 02b-PLAN.md — HandsRouter + HandAwareToolExecutor（Hand 路由 + 工具执行）
- [ ] 02c-PLAN.md — ClientHandler + 服务器入口 + Docker + nginx

## Phase 3: Hand 服务 — 独立 npm 包

- **Status**: planned
- **Goal**: `wzxclaw-hand` 独立包，任何机器一行命令注册为 Brain 的 Hand
- **Depends on**: Phase 2
- **Deliverable**: `packages/hand/`，`npx wzxclaw-hand` 可连接 Brain 并执行工具

## Phase 4: 共享 Web UI — React SPA

- **Status**: planned
- **Goal**: 从桌面端 Renderer 提取共享 UI 层，支持 Electron 和 WebSocket 双数据源
- **Depends on**: Phase 2
- **Deliverable**: `packages/web-ui/` 可独立 dev server 运行，连接 NAS Brain 聊天正常

## Phase 5: 桌面端改造 — Electron 壳 + Hand Bridge

- **Status**: planned
- **Goal**: Electron 套 web-ui，内置 Hand Bridge，连接 NAS Brain
- **Depends on**: Phase 3, Phase 4
- **Deliverable**: `desktop/` 重构完成，NAS Agent + 本地回退双模式

## Phase 6: 手机端重建 — Capacitor 壳

- **Status**: planned
- **Goal**: Capacitor 套 web-ui 替代 Flutter，直连 NAS Brain
- **Depends on**: Phase 4
- **Deliverable**: `mobile/` Capacitor 项目，APK 体验接近原生

## Phase 7: Docker Hand — NAS 本地沙箱

- **Status**: planned
- **Goal**: NAS 上运行 Docker Hand，桌面离线时手机可独立使用 Agent
- **Depends on**: Phase 3, Phase 6
- **Deliverable**: Docker Hand 启动 + Brain 路由 + 手机离线场景验证通过
