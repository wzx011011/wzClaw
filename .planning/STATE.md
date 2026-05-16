---
gsd_state_version: 1.0
milestone: Brain-Hands-Session 全架构迁移
milestone_name: milestone
status: executing
last_updated: "2026-05-16T12:00:00.000Z"
progress:
  total_phases: 15
  completed_phases: 7
  total_plans: 44
  completed_plans: 24
  percent: 55
---

# Project State

## Current Phase

Phase 8: Hand 可插拔配置 + MCP/Skill 全链打通 (discuss → plan → execute)

## Phase History

| Phase | Status | Date |
|-------|--------|------|
| 1 | complete (4/4 plans, human verification deferred) | 2026-05-14 |
| 2 | complete (3/3 plans, 88 tests) | 2026-05-14 |
| 3 | complete (2/2 plans, 55 tests) | 2026-05-14 |
| 4 | complete (5/5 plans, 25 tests) | 2026-05-14 |
| 5 | complete (4/4 plans, human verification deferred) | 2026-05-16 |
| 6 | complete (3/3 plans, human verification deferred) | 2026-05-16 |
| 7 | complete (2/2 plans, NAS deployment deferred) | 2026-05-16 |
| 8 | planned (0/5 plans) | — |
| 9 | planned (0/5 plans) | — |
| 10 | planned (0/5 plans) | — |
| 11 | planned (0/4 plans) | — |
| 12 | planned (0/4 plans) | — |
| 13 | planned (0/4 plans) | — |
| 14 | planned (0/3 plans) | — |
| 15 | planned (0/3 plans) | — |

## Key Decisions

- React + TypeScript 全栈，废弃 Flutter
- Capacitor 壳套替代 Flutter 手机端
- NAS 运行 Brain（Docker 部署）
- Hand 独立 npm 包，可插拔
- HandTool 简化接口（无 requiresApproval/requiresSnapshot）
- CLI 入口 parseArgs 支持环境变量回退
- Session 用 SQLite（多客户端共享）
- 桌面保留本地回退模式
- D-01: electron-vite renderer.root 指向 packages/web-ui（无 symlink）
- D-02: 新增 session:create IPC channel（不重用 session:ensure）
- D-03: 未修改 web-ui IpcDataSource（chat-store fallback 处理 createSession throw）
- D-04: HandBridge 自管 WebSocket 生命周期（不使用 HandConnection，因其 handleOpen 发送空注册）
- D-05: 从 Flutter 项目直接复制图标资源（复用已有品牌资产）
- D-06: Gradle wrapper 从 8.11.1 切换到 8.14（网络超时，8.14 已缓存）
- D-07: Capacitor 7 Java 21 降级到 Java 17（开发环境限制）
- D-08: ShellExecute tests use os.tmpdir() for cwd (Windows compat)
- D-09: ShellExecute exit code tests use node -e (cross-platform)

## Last Session

- **Stopped at**: Phases 5-7 marked complete (human verification deferred)
- **Resume file**: None
- **Next**: Phase 8 discuss → plan → execute
