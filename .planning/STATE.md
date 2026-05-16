---
gsd_state_version: 1.0
milestone: Brain-Hands-Session 全架构迁移
milestone_name: milestone
status: executing
last_updated: "2026-05-16T10:09:34.515Z"
progress:
  total_phases: 15
  completed_phases: 6
  total_plans: 27
  completed_plans: 27
  percent: 100
---

# Project State

## Current Phase

Phase 13: Desktop 完全瘦身（架构漂移纠正 Wave 3） (deferred — needs human coordination)

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
| 8 | complete (2/5 plans core done, UI + Docker deferred) | 2026-05-16 |
| 9 | complete (5/5 plans bundled, 45 tests) | 2026-05-16 |
| 10 | planned (0/5 plans, needs Android SDK) | — |
| 11 | complete (4/4 plans bundled, 27 tests) | 2026-05-16 |
| 12 | complete (4/4 plans bundled, 53+45+27 tests) | 2026-05-16 |
| 13 | deferred (31 duplicate files, needs human coordination) | — |
| 14 | partial (1/3 done, 14-03 Flutter deprecated, 14-01/14-02 need Android SDK) | 2026-05-16 |
| 15 | partial (1/3 done, 15-03 docs updated, 15-01/15-02 need NAS access) | 2026-05-16 |

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
- D-10: IDE components capability-driven — Monaco/xterm externalized, lazy loaded
- D-11: DataSource sub-channels (FsChannel/TerminalChannel/PreviewChannel) as optional properties
- D-12: AgentLoopDeps 不含 permissionManager — 服务器端 bypass 模式由 PermissionManager 独立管理

## Last Session

- **Stopped at**: Phases 12 complete, 14-03 + 15-03 done. Phase 13/10/14-01/14-02/15-01/15-02 deferred.
- **Resume file**: None
- **Next**: Phase 13 (Desktop 瘦身) needs human coordination; Phase 10/14-01/14-02 need Android SDK; Phase 15-01/15-02 need NAS access
