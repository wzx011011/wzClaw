---
phase: 01-brain-hands-separation
plan: 04
subsystem: infra
tags: [brain-package, adapter-pattern, dependency-injection, agent-loop, desktop-bridge]

# Dependency graph
requires:
  - phase: 01-brain-hands-separation
    provides: brain package with DI interfaces (IStreamProvider, IToolExecutor, IEventSender, etc.)
provides:
  - DesktopEventSender, DesktopObservability, DesktopLogger adapters
  - DesktopAgentLoop bridge class wrapping brain AgentLoop
  - createDesktopAgentLoop factory function
  - SessionRuntimeManager wired to DesktopAgentLoop
affects: [02-hand-extraction, 03-session-layer]

# Tech tracking
tech-stack:
  added: ["@wzxclaw/brain as file: dependency"]
  patterns: ["Adapter pattern bridging Electron services to brain DI interfaces", "DesktopAgentLoop as unified wrapper maintaining backward-compatible API"]

key-files:
  created:
    - wzxClaw_desktop/src/main/brain-adapters.ts
    - wzxClaw_desktop/src/main/brain-bridge.ts
  modified:
    - wzxClaw_desktop/src/main/agent/session-runtime-manager.ts
    - wzxClaw_desktop/src/main/index.ts
    - wzxClaw_desktop/src/main/ipc-handlers.ts
    - wzxClaw_desktop/package.json

key-decisions:
  - "DesktopAgentLoop wraps brain AgentLoop and exposes identical public API (run, cancel, reset, getMessages, replaceMessages)"
  - "Sub-agents (AgentTool) still use original desktop AgentLoop -- bridging only for main session loops"
  - "Tool permission approval keeps Electron.WebContents reference via setRawSender() since IEventSender lacks IPC send"
  - "System prompt built by desktop before passing to brain AgentLoop (brain uses config.systemPrompt directly)"

patterns-established:
  - "Adapter pattern: each brain DI interface has a Desktop* implementation delegating to existing Electron services"
  - "Factory function pattern: createDesktopAgentLoop injects all dependencies into brain's AgentLoop"
  - "Backward-compatible API: DesktopAgentLoop.run() matches original AgentLoop.run() signature"

requirements-completed: [INFRA-08, INFRA-09]

# Metrics
duration: 14min
completed: 2026-05-14
---

# Phase 1 Plan 4: Desktop Adapter Bridge Summary

**Desktop adapter layer bridging Electron services to brain package DI interfaces via DesktopAgentLoop wrapper**

## Performance

- **Duration:** 14 min
- **Started:** 2026-05-14T04:08:42Z
- **Completed:** 2026-05-14T04:23:19Z
- **Tasks:** 1 auto + 1 checkpoint
- **Files modified:** 6

## Accomplishments
- Created brain-adapters.ts with 6 adapter classes implementing brain DI interfaces
- Created brain-bridge.ts with DesktopAgentLoop wrapper and factory function
- Wired SessionRuntimeManager, ipc-handlers, and index.ts to use bridge layer
- All 66 desktop tests pass, brain package tests pass (19/19), tsc --noEmit clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Create desktop adapter + bridge layer** - `7a3ff4c` (feat)

## Files Created/Modified
- `wzxClaw_desktop/src/main/brain-adapters.ts` - Adapter classes: DesktopEventSender, DesktopObservability, DesktopLogger, DesktopToolExecutor, DesktopStreamProvider, DesktopPermissionAdapter, DesktopHookRegistry
- `wzxClaw_desktop/src/main/brain-bridge.ts` - DesktopAgentLoop wrapper class, DesktopHookRegistryAdapter, createDesktopAgentLoop factory
- `wzxClaw_desktop/src/main/agent/session-runtime-manager.ts` - Updated to use DesktopAgentLoop type instead of original AgentLoop
- `wzxClaw_desktop/src/main/index.ts` - Updated factory to create DesktopAgentLoop via brain bridge
- `wzxClaw_desktop/src/main/ipc-handlers.ts` - Updated AgentLoop type references to DesktopAgentLoop
- `wzxClaw_desktop/package.json` - Added @wzxclaw/brain as file: dependency

## Decisions Made
- DesktopAgentLoop wraps brain AgentLoop and exposes identical public API, allowing seamless drop-in replacement
- Sub-agents (AgentTool) continue using original desktop AgentLoop for now -- they run in-process with different context
- Permission approval uses raw Electron.WebContents via setRawSender() workaround since brain's IEventSender lacks IPC channel send
- System prompt is still built by desktop code before being passed to brain AgentLoop via config.systemPrompt

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- npm install failed on postinstall (electron-builder install-app-deps / cpu-features node-gyp failure) -- pre-existing issue unrelated to changes. The @wzxclaw/brain package was successfully linked regardless.

## Next Phase Readiness
- Desktop now runs agent sessions through brain package's AgentLoop via adapter bridge
- All brain DI interfaces have desktop implementations, ready for server-side reuse
- Next: verify full desktop functionality manually (checkpoint task 2), then proceed to hand/session extraction phases

---
*Phase: 01-brain-hands-separation*
*Completed: 2026-05-14*
