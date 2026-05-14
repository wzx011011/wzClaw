---
phase: 03-hand-service
plan: 02
subsystem: hand
tags: [cli, tool-executor, npx, barrel-exports]
dependency_graph:
  requires: [03a-protocol-layer, 03a-connection-manager]
  provides: [local-tool-executor, cli-entry, barrel-exports]
  affects: [packages/hand]
tech_stack:
  added: []
  patterns: [TDD red-green, CLI arg parsing with env var fallback, barrel exports]
key_files:
  created:
    - packages/hand/src/tool-executor.ts
    - packages/hand/src/tool-executor.test.ts
    - packages/hand/src/cli.ts
    - packages/hand/src/cli.test.ts
    - packages/hand/src/index.ts
  modified: []
decisions:
  - HandTool interface simplified (no requiresApproval/requiresSnapshot -- Brain-side concerns only)
  - parseArgs() extracted as pure function for testability, env var fallback built-in
  - Server URL validation enforces ws:// or wss:// prefix (threat model T-03b-01)
  - Tool execution errors caught and returned as {output, isError:true} (threat model T-03b-02)
  - SIGINT/SIGTERM handlers for graceful shutdown
  - EchoTool as the only built-in tool (start minimal, more tools in future phases)
metrics:
  duration: 488s
  completed: "2026-05-14T11:04:47Z"
  tasks: 2
  files: 5
  tests: 55
---

# Phase 03 Plan 02: Hand Service — Tool Executor + CLI Entry Summary

工具执行框架 + CLI 入口点，使 Hand 服务完整可用。`npx wzxclaw-hand --server wss://5945.top/agent/ --token xxx` 可启动 Hand 并连接 Brain。

## Commits

| Hash | Message |
|------|---------|
| e446e59 | feat(03-03b): add LocalToolExecutor -- local tool registration and execution framework |
| 9b5a165 | feat(03-03b): add CLI entry point + barrel exports for @wzxclaw/hand |

## Tasks Completed

### Task 1: LocalToolExecutor -- 本地工具注册和执行框架 (TDD)

- `tool-executor.ts`: HandTool interface + LocalToolExecutor class
  - Map-based registry with register/getDefinitions/getCapabilities/hasTool/execute
  - Unified error handling: tool-not-found and exceptions return `{output, isError:true}`
  - addBuiltinTools() registers EchoTool (echoes input as JSON)
- `tool-executor.test.ts`: 14 tests covering all behaviors

### Task 2: CLI 入口 + npx 支持 + barrel exports (TDD)

- `cli.ts`: parseArgs() + runCli() functions
  - Arg parsing: --server, --token, --id, --heartbeat, --help/-h
  - Env var fallback: SERVER_URL, AUTH_TOKEN, HAND_ID
  - URL validation (ws:// or wss:// required)
  - Creates HandConnection + LocalToolExecutor, wires onExecute callback
  - SIGINT/SIGTERM graceful shutdown
- `cli.test.ts`: 13 tests covering arg parsing, env vars, defaults, help flag
- `index.ts`: barrel exports for all public API (types, protocol, connection, executor, CLI)
- `package.json`: bin field `{ "wzxclaw-hand": "./dist/cli.js" }` already set in Wave 1

## Deviations from Plan

None -- plan executed exactly as written.

## Verification Results

```
packages/hand $ npx tsc --noEmit   # PASS (0 errors)
packages/hand $ npx vitest run     # PASS (55 tests, 4 files)
```

## Threat Model Compliance

| Threat ID | Status | Notes |
|-----------|--------|-------|
| T-03b-01 | mitigated | Server URL validation enforces ws:// or wss:// prefix |
| T-03b-02 | mitigated | Tool execution wrapped in try-catch, errors returned as isError:true |
| T-03b-03 | accepted | Local service, DoS only affects local machine |
| T-03b-04 | accepted | Env vars from trusted local environment |

## Self-Check: PASSED

All files verified present:
- packages/hand/src/tool-executor.ts -- FOUND
- packages/hand/src/tool-executor.test.ts -- FOUND
- packages/hand/src/cli.ts -- FOUND
- packages/hand/src/cli.test.ts -- FOUND
- packages/hand/src/index.ts -- FOUND

All commits verified in git log:
- e446e59 -- FOUND
- 9b5a165 -- FOUND
