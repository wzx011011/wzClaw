# Phase 10: 手机端体验回归 Flutter 等价 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-05-16
**Phase:** 10-mobile-parity
**Areas discussed:** Capacitor project location, Execution scope split

---

## Capacitor Project Location

| Option | Description | Selected |
|--------|-------------|----------|
| New `capacitor/` root dir | New top-level directory at repo root. webDir = `../packages/web-ui/dist`. Clean separation from deprecated Flutter. | ✓ |
| Replace wzxClaw_android/ | Delete Flutter contents, reinitialize as Capacitor. | |
| Inside web-ui package | Put Capacitor project inside packages/web-ui/. | |

**User's choice:** New `capacitor/` root dir
**Notes:** Flutter 和 Capacitor 共享 `android/` 子目录，混合会破坏构建系统。独立目录保持清晰分离。

---

## Execution Scope Split

| Option | Description | Selected |
|--------|-------------|----------|
| Execute web-only | Plans 10-01/02/03/05 now, skip 10-04 for later | |
| Defer all until SDK ready | Wait for Android SDK availability | |
| Execute web + scaffold native | Web code + Capacitor scaffolding with no-op fallbacks | |

**User's choice:** 全部可执行 — 本地已安装 Android SDK
**Notes:** wzxClaw_android/android/ 中已有可复用的 Gradle/SDK 配置。所有 5 个 Plan 均可执行。

---

## Claude's Discretion

None — user made all decisions.

## Deferred Ideas

None — all scope within Phase 10 boundary.
