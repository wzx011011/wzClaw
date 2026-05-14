---
project: "wzxClaw"
milestone: "Brain-Hands-Session 全架构迁移"
status: "executing"
created: "2026-05-14"
last_activity: "2026-05-14"
branch: "feat/agent-server-migration"
---

# Project State

## Current Phase
Phase 4: 共享 Web UI — React SPA (in-progress)

## Phase History
| Phase | Status | Date |
|-------|--------|------|
| 1 | complete (4/4 plans, human verification deferred) | 2026-05-14 |
| 2 | complete (3/3 plans, 88 tests) | 2026-05-14 |
| 3 | complete (2/2 plans, 55 tests) | 2026-05-14 |
| 4 | in-progress (3/5 plans, 19 tests) | 2026-05-14 |
| 5 | planned | - |
| 6 | planned | - |
| 7 | planned | - |

## Key Decisions
- React + TypeScript 全栈，废弃 Flutter
- Capacitor 套壳替代 Flutter 手机端
- NAS 运行 Brain（Docker 部署）
- Hand 独立 npm 包，可插拔
- HandTool 简化接口（无 requiresApproval/requiresSnapshot）
- CLI 入口 parseArgs 支持环境变量回退
- Session 用 SQLite（多客户端共享）
- 桌面保留本地回退模式
