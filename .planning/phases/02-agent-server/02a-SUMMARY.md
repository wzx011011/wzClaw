---
phase: 02-agent-server
plan: 02a
subsystem: agent-server
tags: [scaffolding, auth, sqlite, session-store]
dependency_graph:
  requires: ["@wzxclaw/brain ISessionStore interface"]
  provides: ["@wzxclaw/agent-server package", "Token auth module", "SessionStoreSqlite"]
  affects: []
tech_stack:
  added: ["better-sqlite3@12.10.0", "ws@^8.18.0", "pnpm workspaces"]
  patterns: ["ESM modules", "timing-safe token comparison", "SQLite WAL mode", "precompiled prepared statements"]
key_files:
  created:
    - packages/agent-server/package.json
    - packages/agent-server/tsconfig.json
    - packages/agent-server/vitest.config.ts
    - packages/agent-server/src/types.ts
    - packages/agent-server/src/auth.ts
    - packages/agent-server/src/auth.test.ts
    - packages/agent-server/src/session-sqlite.ts
    - packages/agent-server/src/session-sqlite.test.ts
    - packages/agent-server/src/index.ts
    - package.json (pnpm workspace root)
    - pnpm-workspace.yaml
  modified: []
decisions:
  - "Upgraded better-sqlite3 from ^11.0.0 to ^12.10.0 for Node 24 prebuilt binary compatibility (node-gyp does not recognize VS 18)"
  - "Created pnpm workspace config (pnpm-workspace.yaml) since no monorepo workspace existed before"
  - "Added id DESC as secondary sort in listSessions for deterministic ordering when timestamps collide"
metrics:
  duration: "16 minutes"
  completed: "2026-05-14"
  tasks: 2
  tests: 26
  files: 11
---

# Phase 2 Plan 02a: Agent Server Scaffolding + Auth + SessionStore Summary

Token auth module with timing-safe comparison and SQLite session store implementing ISessionStore, all within a new @wzxclaw/agent-server package under pnpm monorepo workspace.

## What Was Done

### Task 1: Package scaffolding + Token authentication

Created `packages/agent-server/` with full TypeScript + vitest setup. Ported the relay server's auth logic from CommonJS to ESM TypeScript. Token auth supports:
- Dev mode: when `AUTH_TOKEN` env var is unset, any non-empty token is accepted
- Production mode: timing-safe comparison via `crypto.timingSafeEqual`
- Null/undefined/empty/whitespace tokens always rejected

10 tests covering dev mode, production mode, and boundary cases.

### Task 2: SessionStoreSqlite

Implemented `ISessionStore` from `@wzxclaw/brain` backed by SQLite:
- WAL mode for concurrent read/write performance
- Two tables: `sessions` (id, title, updated_at) and `messages` (session_id, seq, message JSON)
- Precompiled prepared statements for all queries
- Transactional deleteSession for atomicity
- Auto-creates sessions on first message append with title from content (first 50 chars)

16 tests using `:memory:` databases covering CRUD, ordering, title extraction, and atomicity.

## Verification Results

```
TypeScript: npx tsc --noEmit — PASSED (zero errors)
Tests: npx vitest run — 26/26 PASSED
  auth.test.ts: 10/10
  session-sqlite.test.ts: 16/16
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Upgraded better-sqlite3 from ^11.0.0 to ^12.10.0**
- **Found during:** Task 1 dependency installation
- **Issue:** better-sqlite3@11 fails to build native module on Node 24 — node-gyp does not recognize Visual Studio 18 (Insiders channel), and no prebuilt binary exists for Node 24 at v11
- **Fix:** Upgraded to v12.10.0 which includes prebuilt binaries for Node 24
- **Files modified:** packages/agent-server/package.json
- **Commit:** 44abbe2

**2. [Rule 3 - Blocking] Created pnpm monorepo workspace config**
- **Found during:** Task 1 dependency installation
- **Issue:** `workspace:*` protocol in package.json requires a workspace manager, but no root package.json or pnpm-workspace.yaml existed
- **Fix:** Created `package.json` (workspace root) and `pnpm-workspace.yaml` to enable pnpm workspaces
- **Files modified:** package.json, pnpm-workspace.yaml
- **Commit:** 44abbe2

**3. [Rule 1 - Bug] Fixed listSessions deterministic sort order**
- **Found during:** Task 2 test execution
- **Issue:** When two sessions are created in the same millisecond, `ORDER BY updated_at DESC` produces non-deterministic ordering
- **Fix:** Added `id DESC` as secondary sort key
- **Files modified:** packages/agent-server/src/session-sqlite.ts
- **Commit:** ea11abe

## Threat Flags

No additional threat surface beyond the plan's threat model. The token auth module implements T-02a-01 (timing-safe comparison) and T-02a-04 (WAL mode for crash recovery) as specified.

## Commits

| Commit | Message |
|--------|---------|
| 44abbe2 | feat(02-agent-server-02a): initialize agent-server package + token auth |
| ea11abe | feat(02-agent-server-02a): add SQLite session store implementing ISessionStore |

## Self-Check: PASSED

All 12 files verified present. Both commit hashes (44abbe2, ea11abe) verified in git log.
