---
gsd_state_version: 1.0
milestone: Brain-Hands-Session 全架构迁移
milestone_name: milestone
status: executing
last_updated: "2026-05-16T22:50:00.000Z"
progress:
  total_phases: 15
  completed_phases: 12
  total_plans: 40
  completed_plans: 39
  percent: 95
---

# Project State

## Current Phase

NAS deployment complete (08-04, 15-01). Agent-server + docker-hand running on NAS at `agent.5945.top`. Remaining: 08-05/15-02 E2E tests (need API key in NAS .env).

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
| 8 | complete (3/5 plans, core + UI done, Docker + E2E deferred for NAS) | 2026-05-16 |
| 9 | complete (5/5 plans bundled, 45 tests) | 2026-05-16 |
| 10 | complete (5/5 plans, 45 tests, build pass) | 2026-05-16 |
| 11 | complete (4/4 plans bundled, 27 tests) | 2026-05-16 |
| 12 | complete (4/4 plans bundled, 53+45+27 tests) | 2026-05-16 |
| 13 | complete (26 files deleted, 19 imports swapped, 596 tests pass) | 2026-05-16 |
| 14 | complete (3/3, Capacitor project + mobile responsive + Flutter deprecated) | 2026-05-16 |
| 15 | partial (1/3 done, 15-03 docs updated, 15-01/15-02 need NAS access) | 2026-05-16 |

## Key Decisions

- React + TypeScript 全栈，废弃 Flutter
- Capacitor 壳套替代 Flutter 手机端
- NAS 运行 Brain（Docker 部署）
- Hand 独立 npm 包，可插拔
- Session 用 SQLite（多客户端共享）
- 桌面保留本地回退模式
- D-01~D-12: (prior decisions preserved)
- D-13: MobileShell layout — useCapabilities.mobileShell flag
- D-14: Capacitor native plugins — no-op fallback on browser
- D-15: File browsing via DataSource.fs channel
- D-16: Capacitor project at mobile/ (existing, with Android platform)
- D-17: DesktopPicker from agent-server GET /admin/hands + targetHandId routing
- D-18: Desktop imports from @wzxclaw/brain (26 duplicates deleted, 3 Desktop-only kept)

## Last Session

- **Stopped at**: NAS deployment done (08-04, 15-01). Agent-server running at agent.5945.top, docker-hand connected with 4 tools.
- **Resume file**: None
- **Next**: Add GLM API key to NAS .env (`ssh nas vi /volume1/docker/wzxclaw-deploy/.env`), then run E2E tests (08-05, 15-02)
