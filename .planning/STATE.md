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
Phase 2: Agent 服务器 — NAS 部署 (02a complete, next: 02b)

## Phase History
| Phase | Status | Date |
|-------|--------|------|
| 1 | complete (4/4 plans, human verification deferred) | 2026-05-14 |
| 2 | planned | - |
| 3 | planned | - |
| 4 | planned | - |
| 5 | planned | - |
| 6 | planned | - |
| 7 | planned | - |

## Key Decisions
- React + TypeScript 全栈，废弃 Flutter
- Capacitor 套壳替代 Flutter 手机端
- NAS 运行 Brain（Docker 部署）
- Hand 独立 npm 包，可插拔
- Session 用 SQLite（多客户端共享）
- 桌面保留本地回退模式
