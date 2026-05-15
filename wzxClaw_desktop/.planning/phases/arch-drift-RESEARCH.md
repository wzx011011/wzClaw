# Phase: Architecture Drift Audit - Research

**Researched:** 2026-05-15
**Domain:** Brain-Hands-Session architecture migration readiness
**Confidence:** HIGH (all findings verified by reading actual source code from git HEAD)

## Summary

The wzxClaw project is mid-migration from a monolithic Desktop-centric architecture to a distributed Brain-Hands-Session model. Three packages (`@wzxclaw/brain`, `@wzxclaw/hand`, `@wzxclaw/agent-server`) and a `web-ui` package have been created, and the Desktop already depends on `@wzxclaw/brain` and `@wzxclaw/hand` via `file:` links. However, the migration is only partially complete: the Desktop still contains full duplicates of nearly every Brain module, the Hand package only has 4 basic tools (vs. 25+ in Desktop), the agent-server has a working wire protocol but its AgentLoop factory throws by default, and the mobile client still routes through the old relay-to-desktop path rather than connecting to agent-server directly.

**Primary recommendation:** The codebase is at the "scaffolded but not switched over" stage. Brain and agent-server have the right structure but lack feature parity with Desktop. The migration should proceed in two stages: (1) finish extracting missing Desktop context modules into Brain, (2) switch Desktop and Mobile to connect through agent-server as the primary path.

## Intended Architecture

```
                    +-----------------+
                    |   Agent Server  | (NAS Docker)
                    |   (WS Server)   |
                    +--------+--------+
                             |
              +--------------+--------------+
              |                             |
     +--------+--------+          +---------+--------+
     |      Brain      |          |    HandsRouter   |
     | (AgentLoop, LLM,|          | (routes tools to |
     |  Context, etc.) |          |  connected Hands)|
     +-----------------+          +---------+--------+
                                           |
                              +------------+------------+
                              |                         |
                    +---------+--------+      +---------+--------+
                    |   Desktop Hand     |      |   NAS Hand       |
                    |   (25+ tools)      |      |   (4 tools:      |
                    |   WS client        |      |    FileRead/Write |
                    |                    |      |    FileList,      |
                    +--------------------+      |    ShellExecute)  |
                                                +-------------------+

    Clients (thin UI only):
    - Desktop (Electron) → IPC to local, or WS to agent-server
    - Mobile (Flutter) → WS to agent-server
    - Web-UI (React SPA) → WS to agent-server or IPC in Electron
```

**Key principle:** Brain owns ALL AI/LLM logic. Hands own ALL tool execution. Clients are thin UI channels.

## Architectural Responsibility Map

| Capability | Intended Tier | Current State | Rationale |
|------------|--------------|---------------|-----------|
| Agent loop orchestration | Brain (agent-server) | Split: Brain has DI version, Desktop has original | AI reasoning lifecycle belongs in Brain |
| LLM streaming/calls | Brain | Split: both have full copies | LLM API access belongs in Brain |
| Tool execution (local) | Hand | Desktop still executes directly | Tool execution is environment-specific |
| Context management | Brain | Split: both have copies | Token counting/compaction is AI-logic |
| Session persistence | Brain (agent-server) | Desktop has JSONL, agent-server has SQLite | Session state belongs with Brain |
| Permission management | Client-side (Desktop) | Desktop only | Approval UI must be client-side |
| UI rendering | Client | Correct in all clients | Each client is its own UI |
| System prompt building | Brain | Desktop has full version, Brain has stub | Prompt assembly is Brain logic |
| MCP tool management | Client-side Hand | Desktop only | MCP servers are environment-local |
| Observability | Brain | Desktop has Langfuse | Tracing belongs near AI logic |

## Current State Per Component

### A. @wzxclaw/brain (packages/brain/) -- 2,931 lines

**Status:** Core modules extracted, DI-based, zero Electron dependency. Feature-incomplete.

| Module | Lines | Parity with Desktop | Notes |
|--------|-------|---------------------|-------|
| agent/agent-loop.ts | 428 | ~97% | DI version, drops Electron deps |
| agent/turn-manager.ts | 200 | ~50% | Desktop has 388 lines with more tool execution logic |
| agent/stream-phase.ts | 248 | ~92% | Nearly identical |
| agent/conversation-manager.ts | 222 | 100% | Identical |
| agent/system-prompt-builder.ts | 31 | **STUB** | Desktop has 169 lines with full prompt assembly |
| agent/loop-detector.ts | 51 | 100% | Identical |
| agent/message-builder.ts | 249 | 100% | Identical |
| agent/streaming-tool-executor.ts | 114 | 100% | Identical |
| agent/runtime-config.ts | 101 | 100% | Identical |
| llm/gateway.ts | 69 | 100% | Identical |
| llm/anthropic-adapter.ts | 245 | ~99% | Nearly identical |
| llm/openai-adapter.ts | 124 | 100% | Identical |
| llm/retry.ts | 269 | 100% | Identical |
| llm/cost-tracker.ts | 78 | 100% | Identical |
| context/context-manager.ts | 295 | ~97% | Nearly identical |
| context/token-counter.ts | 58 | 100% | Identical |
| context/microcompact.ts | 262 | 100% | Identical |
| context/tool-result-budget.ts | 117 | 100% | Identical |
| context/tool-result-storage.ts | 171 | Desktop has 154 | Brain has slightly different version |
| context/turn-attachments.ts | 108 | 100% | Identical |
| context/compact-file-restore.ts | 194 | 100% | Identical |
| interfaces.ts | 140 | N/A | DI interfaces (unique to Brain) |
| channels.ts | 16 | N/A | Brain-specific event channels |
| constants.ts | ~60 | Subset | Shares model presets with Desktop |

**Missing from Brain (Desktop-only):**
- `context/compact-prompt.ts` (81 lines) -- compaction prompt template
- `context/compact-attachments.ts` (100 lines) -- attachment compaction
- `context/compact-warning-state.ts` (24 lines) -- compaction warning tracking
- `context/post-compact-cleanup.ts` (17 lines) -- post-compact cleanup
- `context/ptl-recovery.ts` (91 lines) -- PTL recovery logic
- `context/session-memory-compact.ts` (78 lines) -- memory compaction
- `context/env-info.ts` (121 lines) -- environment info for system prompt
- `context/grouping.ts` (102 lines) -- message grouping
- `context/instruction-loader.ts` (234 lines) -- WZXCLAW.md instruction loading
- `context/message-utils.ts` (76 lines) -- message utilities
- `agent/system-prompt-builder.ts` -- full version (Desktop has 169 lines with git context, memory, instructions)
- `memory/` -- memory management module
- `observability/` -- Langfuse integration
- `permission/` -- permission management
- `tools/tool-registry.ts` -- tool registration and execution

### B. @wzxclaw/hand (packages/hand/) -- ~1,200 lines

**Status:** Clean WebSocket client + protocol + local tool executor. Only 4 NAS-specific tools.

| Module | Lines | Purpose |
|--------|-------|---------|
| src/connection.ts | ~280 | WebSocket lifecycle (connect/register/heartbeat/reconnect) |
| src/protocol.ts | ~120 | Message encode/decode (hand:register, hand:result, hand:heartbeat) |
| src/tool-executor.ts | ~120 | Local tool registry + execution framework |
| src/cli.ts | ~170 | CLI entry point (wzxclaw-hand command) |
| src/types.ts | ~50 | Type definitions |
| tools/file-read.ts | ~80 | NAS file read tool |
| tools/file-write.ts | ~75 | NAS file write tool |
| tools/file-list.ts | ~100 | NAS directory listing tool |
| tools/shell-execute.ts | ~100 | NAS shell execution tool |
| docker-entry.ts | ~50 | Docker-specific Hand entry point |
| Dockerfile + docker-compose | ~30 | Docker deployment config |

**What Hand has (NAS Docker tools):** FileRead, FileWrite, FileList, ShellExecute -- 4 basic tools.

**What Desktop has (25+ tools NOT in Hand):**
- Bash (305 lines) -- shell command execution with security
- FileEdit (159 lines) -- targeted file editing
- MultiEdit (178 lines) -- multi-location editing
- Glob (182 lines) -- file pattern search
- Grep (178 lines) -- content search
- Ls (134 lines) -- directory listing
- WebFetch (196 lines) -- web page fetching
- WebSearch (192 lines) -- web search
- BrowserTools (183 lines) -- browser automation (6 sub-tools)
- SemanticSearch (129 lines) -- codebase semantic search
- SymbolNav (297 lines) -- symbol navigation
- AgentTool (207 lines) -- sub-agent spawning
- AskUser (120 lines) -- user interaction tool
- TodoWrite (186 lines) -- todo management
- CreateStep/UpdateStep (138 lines) -- step management
- TaskOutputTool (43 lines) -- task output
- ToolSearchTool (43 lines) -- tool discovery
- MCPResourceTool (96 lines) -- MCP resource access
- PlanMode (162 lines) -- plan mode tools
- BashReadonly (200 lines) -- read-only bash
- BashSecurity (102 lines) -- bash security analysis
- FileUtils (307 lines) -- file utility helpers

**Desktop HandBridge** (`src/main/hand-bridge.ts`, ~300 lines): Already connects Desktop as a Hand to agent-server using `@wzxclaw/hand` protocol. Adapts all 25+ Desktop tools via `DesktopToolAdapter`.

### C. @wzxclaw/agent-server (packages/agent-server/) -- ~900 lines

**Status:** Wire protocol works. AgentLoop integration is incomplete (factory throws by default).

| Module | Lines | Purpose |
|--------|-------|---------|
| src/server.ts | ~150 | HTTP + WebSocket server, connection routing |
| src/client-handler.ts | ~280 | Client WS handler, AgentLoop bridge, event mapping |
| src/hands-router.ts | ~160 | Hand registration, routing, health checking |
| src/hand-aware-tool-executor.ts | ~150 | Routes tool calls to Hands via WS |
| src/session-sqlite.ts | ~174 | SQLite-based session persistence |
| src/auth.ts | ~40 | Token authentication |
| src/types.ts | ~40 | Type definitions |

**AgentLoop integration gap:** `AgentServer` constructor creates `ClientHandler` with a factory function that throws: `() => { throw new Error('AgentLoop factory not configured') }`. The server needs `gateway`, `contextManager`, etc. injected to actually create AgentLoop instances.

**Session storage:** Uses SQLite (`better-sqlite3`) instead of Desktop's JSONL files.

### D. Desktop (wzxClaw_desktop/src/main/) -- the primary drift source

**Status:** Still the monolith. Contains full copies of Brain modules AND all tool implementations.

#### Brain logic still in Desktop (duplicated with packages/brain):

| File | Lines | Should Be In |
|------|-------|--------------|
| agent/agent-loop.ts | 438 | Brain (already there as DI version) |
| agent/turn-manager.ts | 388 | Brain (200 lines there) |
| agent/stream-phase.ts | 270 | Brain (248 lines there) |
| agent/conversation-manager.ts | 222 | Brain (identical) |
| agent/system-prompt-builder.ts | 169 | Brain (only 31-line stub there) |
| agent/loop-detector.ts | 51 | Brain (identical) |
| agent/message-builder.ts | 249 | Brain (identical) |
| agent/streaming-tool-executor.ts | 114 | Brain (identical) |
| agent/runtime-config.ts | 101 | Brain (identical) |
| agent/interfaces.ts | varies | Brain (Brain has its own) |
| llm/gateway.ts | 69 | Brain (identical) |
| llm/anthropic-adapter.ts | 246 | Brain (identical) |
| llm/openai-adapter.ts | 124 | Brain (identical) |
| llm/retry.ts | 269 | Brain (identical) |
| llm/cost-tracker.ts | 78 | Brain (identical) |
| llm/model-cost.ts | 51 | Brain (identical) |
| llm/types.ts | 38 | Brain (identical) |
| context/context-manager.ts | 305 | Brain (295 lines there) |
| context/token-counter.ts | 58 | Brain (identical) |
| context/microcompact.ts | 262 | Brain (identical) |
| context/tool-result-budget.ts | 117 | Brain (identical) |
| context/tool-result-storage.ts | 154 | Brain (171 lines there) |
| context/turn-attachments.ts | 108 | Brain (identical) |
| context/compact-file-restore.ts | 194 | Brain (identical) |

#### Desktop-only context modules (NOT yet extracted to Brain):

| File | Lines | Purpose |
|------|-------|---------|
| context/compact-prompt.ts | 81 | Compaction prompt template |
| context/compact-attachments.ts | 100 | Attachment compaction |
| context/compact-warning-state.ts | 24 | Compaction warning tracking |
| context/post-compact-cleanup.ts | 17 | Post-compact cleanup |
| context/ptl-recovery.ts | 91 | PTL recovery |
| context/session-memory-compact.ts | 78 | Memory compaction |
| context/env-info.ts | 121 | Environment info (paths, OS) |
| context/grouping.ts | 102 | Message grouping logic |
| context/instruction-loader.ts | 234 | WZXCLAW.md loading |
| context/message-utils.ts | 76 | Message utilities |

#### Desktop bridge files (connect Desktop to Brain/Hand):

| File | Lines | Purpose |
|------|-------|---------|
| brain-bridge.ts | ~250 | DesktopAgentLoop wrapper around Brain's AgentLoop |
| brain-adapters.ts | ~280 | Electron adapters (DesktopEventSender, DesktopToolExecutor, etc.) |
| hand-bridge.ts | ~300 | HandBridge -- Desktop as Hand to agent-server |
| tool-hand-adapter.ts | ~100 | DesktopToolAdapter wrapping Tool as HandTool |

#### Tool implementation (should be in Desktop Hand, not Desktop core):

Total: ~3,900 lines across 25+ tool files (see full list in section B above).

#### Other Desktop-only modules:

| File | Lines | Purpose | Migration |
|------|-------|---------|-----------|
| persistence/session-store.ts | 503 | JSONL session persistence | Replace with agent-server SQLite |
| persistence/session-store-manager.ts | 65 | Multi-store management | Remove after migration |
| permission/ | ~200 | Permission management | Stays client-side |
| observability/ | ~200 | Langfuse tracing | Move to Brain |
| hooks/ | ~150 | Hook system | Move to Brain |
| memory/ | ~100 | Memory management | Move to Brain |
| indexing/ | ~400 | Code indexing | Stays client-side (env-local) |
| terminal/ | ~200 | Terminal management | Stays client-side |
| browser/ | ~300 | Browser automation | Stays client-side |
| mcp/ | ~300 | MCP client | Stays client-side (env-local) |
| mobile/ | ~800 | Mobile relay handling | Remove after migration |
| hosts/ | ~600 | SSH/remote host management | Stays client-side |

### E. Mobile Client (wzxClaw_android/)

**Status:** Thin UI client. Routes through relay to Desktop, NOT to agent-server.

Current data flow:
```
Phone --WSS--> NAS Relay (wss://5945.top/relay/) --WS--> Desktop wzxClaw
```

The mobile app:
- Connects via `ConnectionManager` to the relay server
- Uses `WsTransport` interface (abstracted from `ConnectionManager`)
- `ChatStore` singleton manages messages, routes to desktop via relay
- `SessionSyncService` syncs sessions through desktop
- Has its own `ChatDatabase` for local caching
- NO Brain logic embedded (correctly thin)
- NO direct connection to agent-server (migration needed)

**Files:**
- `services/connection_manager.dart` -- WebSocket to relay
- `services/chat_store.dart` -- Message state management
- `services/session_sync_service.dart` -- Session CRUD via relay
- `services/ws_transport.dart` -- Abstract transport interface
- `services/chat_database.dart` -- Local SQLite cache

**Migration need:** Mobile needs a new `AgentServerDataSource` (or switch to web-ui's `WebSocketDataSource`) to connect directly to agent-server instead of going through relay-to-desktop.

### F. Web-UI (packages/web-ui/)

**Status:** Correctly architected. Dual data source (IPC for Electron, WebSocket for remote).

The web-ui has the right architecture:
- `DataSourceProvider` -- React context, manages DataSource lifecycle
- `createDataSource()` -- auto-detects environment (Electron vs browser)
- `IpcDataSource` -- bridges `window.wzxclaw` preload API
- `WebSocketDataSource` -- connects to agent-server via WS
- `DataSource` interface -- clean abstraction over both transports
- Stores (`chat-store`, `settings-store`) depend only on `DataSource` interface

**Gap:** `WebSocketDataSource` connects to `ws://localhost:8082` by default. The agent-server protocol is implemented but `stopGeneration` and `renameSession` throw "not implemented".

### G. Relay Server (relay/)

**Status:** Existing relay server routes Desktop<->Mobile. Will need to coexist with or be replaced by agent-server.

The relay is a simple WebSocket room-based router:
- Token-keyed rooms
- Desktop registers, Mobile joins same room
- Messages forwarded between desktop and mobile
- Offline queue (24h TTL)
- Health checks (30s pings)

After migration, the relay may still be useful for desktop-to-mobile push notifications, but the primary chat/session path should go through agent-server.

## Drift Findings

### Finding 1: Massive Code Duplication (Brain modules)

**Severity:** HIGH

Desktop has ~2,000 lines of agent/ modules and ~1,875 lines of llm/ modules that are duplicated in Brain. The Brain versions use DI interfaces to avoid Electron dependencies, while Desktop versions import Electron-specific types directly.

The Desktop is already wired to use Brain via `brain-bridge.ts` and `brain-adapters.ts`, but the original Desktop `agent/agent-loop.ts` is still imported by:
- `src/main/tools/agent-tool.ts` -- for sub-agent spawning
- `src/main/mobile/mobile-relay-handler.ts` -- for type reference
- `src/main/mobile/mobile-relay-context.ts` -- for type reference

### Finding 2: System Prompt Builder is a Stub in Brain

**Severity:** HIGH

Brain's `system-prompt-builder.ts` is only 31 lines -- a simple cache boundary concatenation. Desktop's version is 169 lines and assembles the full system prompt including git context, environment info, instruction loading, memory, and plan mode. This is critical Brain logic that has not been extracted.

Additionally, 10 Desktop-only context modules (env-info, instruction-loader, grouping, etc., totaling ~1,024 lines) support the system prompt builder and compaction logic but are not in Brain.

### Finding 3: Agent Server Cannot Actually Run AgentLoop

**Severity:** HIGH

The `AgentServer` constructor creates `ClientHandler` with a factory that throws:
```typescript
() => {
  throw new Error('AgentLoop factory not configured')
}
```

The server needs `gateway` (LLM access), `contextManager`, and other dependencies injected before it can actually run conversations. The `setLoopFactory()` method exists for this, but no wiring code populates it.

### Finding 4: Hand Package Has Only 4 Basic Tools

**Severity:** MEDIUM

The `@wzxclaw/hand` package's tools directory has 4 NAS-specific tools (FileRead, FileWrite, FileList, ShellExecute). Desktop has 25+ tools including critical ones like Grep, Glob, FileEdit, Bash, and SemanticSearch.

The Desktop `HandBridge` works around this by adapting ALL Desktop tools into HandTool interface via `DesktopToolAdapter`. This means Desktop can register as a full-featured Hand to agent-server. But for a NAS Docker Hand (without Desktop), only the 4 basic tools are available.

### Finding 5: Mobile Still Routes Through Old Relay

**Severity:** MEDIUM

Mobile connects: `Phone -> NAS Relay -> Desktop`. After migration, it should connect: `Phone -> Agent Server` directly. The web-ui already has a `WebSocketDataSource` that connects to agent-server, so the Flutter app needs an equivalent.

### Finding 6: Desktop Has DesktopAgentLoop as Wrapper, But Still Imports Original

**Severity:** MEDIUM

The Desktop uses `createDesktopAgentLoop()` from `brain-bridge.ts` as its primary agent loop factory (confirmed in `index.ts` line 386). This wraps Brain's DI-based `AgentLoop`. However, `tools/agent-tool.ts` still imports the OLD `AgentLoop` class directly for sub-agent spawning. This creates two AgentLoop instantiation paths.

### Finding 7: Permission Management is Client-Side Only

**Severity:** LOW (by design)

Permission approval requires user interaction (UI dialogs), so it correctly stays client-side. The `DesktopToolExecutor` adapter in `brain-adapters.ts` handles permission checks before executing tools. This pattern is correct for the Brain-Hands model: Hands receive tool execution requests only after Brain has checked permissions.

### Finding 8: Observability and Hooks in Desktop, Not Brain

**Severity:** MEDIUM

Langfuse tracing (`observability/langfuse-observer.ts`) and the hook registry (`hooks/hook-registry.ts`) are Desktop-only. Brain has `IObservability` and `IHookRegistry` interfaces but no implementations. After migration, these should move into Brain (or agent-server provides implementations).

### Finding 9: MCP is Environment-Local (Correctly Stays Client-Side)

**Severity:** LOW (correct)

MCP servers are local processes (stdio transport). They cannot be centralized in Brain. The Desktop `MCPManager` correctly stays in the client/Hand layer. Tools from MCP are registered in the local ToolRegistry and exposed through HandBridge.

### Finding 10: Shared Types Split Between shared/ and Brain

**Severity:** MEDIUM

Brain defines its own `types.ts`, `constants.ts`, and `channels.ts` that duplicate parts of Desktop's `shared/types.ts`, `shared/constants.ts`, and `shared/ipc-channels.ts`. The Desktop `brain-adapters.ts` has to map between these two type systems. This creates ongoing drift risk.

## Dependency Map

### Package Dependencies (verified from package.json):

```
wzxClaw_desktop --> @wzxclaw/brain (file:../packages/brain)
wzxClaw_desktop --> @wzxclaw/hand  (file:../packages/hand)
agent-server    --> @wzxclaw/brain (workspace:*)
agent-server    --> ws, better-sqlite3
hand            --> ws
web-ui          --> react, zustand (no @wzxclaw deps)
brain           --> openai, @anthropic-ai/sdk, js-tiktoken
```

### Desktop Internal Import Graph (Brain-related):

```
index.ts
  ├── brain-bridge.ts (DesktopAgentLoop)
  │     └── @wzxclaw/brain (createAgentLoop, AgentLoop, types)
  │     └── brain-adapters.ts (DesktopEventSender, DesktopToolExecutor, etc.)
  │           └── @wzxclaw/brain (IEventSender, IToolExecutor, etc.)
  │           └── llm/gateway.ts (DesktopStreamProvider wraps)
  │           └── tools/tool-registry.ts
  │           └── permission/permission-manager.ts
  ├── hand-bridge.ts (HandBridge)
  │     └── @wzxclaw/hand (HandConnection, protocol functions, LocalToolExecutor)
  │     └── tool-hand-adapter.ts (DesktopToolAdapter)
  │           └── tools/tool-registry.ts
  ├── agent/agent-loop.ts (ORIGINAL, still used by agent-tool.ts)
  ├── agent/session-runtime-manager.ts (uses DesktopAgentLoop from brain-bridge)
  ├── llm/gateway.ts (original, also wrapped in brain-adapters)
  └── mobile/ (still imports original AgentLoop type)
```

### Cross-Package Type Mapping:

| Desktop (shared/) | Brain (packages/brain/) | Relationship |
|--------------------|--------------------------|--------------|
| shared/types.ts | brain/src/types.ts | Overlapping message types |
| shared/constants.ts | brain/src/constants.ts | Same model presets |
| shared/ipc-channels.ts | brain/src/channels.ts | Different channel names |
| agent/types.ts (AgentEvent) | brain/src/agent/types.ts | Identical events |

## Migration Scope Estimate

### Stage 1: Complete Brain Extraction (estimated ~1,500 lines to move)

| What | Lines | Complexity |
|------|-------|------------|
| Extract full system-prompt-builder to Brain | ~170 | Medium -- needs env-info abstraction |
| Extract 10 context modules to Brain | ~1,024 | Low -- mostly pure logic |
| Extract observability to Brain | ~200 | Medium -- needs interface impl |
| Extract hooks to Brain | ~150 | Low |
| Extract memory management to Brain | ~100 | Low |
| Fix agent-tool.ts to use Brain's AgentLoop | ~20 | Low -- just change import |
| Fix mobile type imports | ~10 | Low |

### Stage 2: Wire Agent Server (estimated ~300 lines)

| What | Lines | Complexity |
|------|-------|------------|
| Create AgentLoop factory in agent-server | ~50 | Medium -- needs gateway config |
| Add settings endpoint to agent-server | ~30 | Low |
| Add stopGeneration to agent-server protocol | ~20 | Low |
| Add renameSession to agent-server protocol | ~20 | Low |
| Deploy and test | 0 | Ops |

### Stage 3: Desktop as Hand (already ~80% done)

| What | Lines | Complexity |
|------|-------|------------|
| Desktop HandBridge already works | 0 | Done |
| DesktopToolAdapter already adapts all tools | 0 | Done |
| Switch Desktop main loop to go through agent-server | ~100 | High -- big behavior change |
| Remove duplicated Brain modules from Desktop | ~2,000 | Low -- delete files, fix imports |

### Stage 4: Mobile Direct Connection (estimated ~400 lines)

| What | Lines | Complexity |
|------|-------|------------|
| Create Flutter AgentServerDataSource | ~200 | Medium |
| Update ChatStore to use new data source | ~100 | Medium |
| Update SessionSyncService | ~50 | Low |
| Update ConnectionManager or replace | ~50 | Medium |

### Stage 5: Remove Old Relay Path (estimated ~100 lines)

| What | Lines | Complexity |
|------|-------|------------|
| Remove mobile relay handler from Desktop | ~50 | Low |
| Simplify Desktop mobile module | ~50 | Low |
| Keep relay server for push notifications | 0 | N/A |

### Total Estimated Migration Scope

| Category | Lines to Write | Lines to Move | Lines to Delete |
|----------|---------------|---------------|-----------------|
| Brain completion | ~200 | ~1,500 | 0 |
| Agent-server wiring | ~120 | 0 | 0 |
| Desktop cleanup | ~100 | 0 | ~2,000 |
| Mobile rewire | ~400 | 0 | ~100 |
| **Total** | **~820** | **~1,500** | **~2,100** |

## Open Questions

1. **agent-server deployment:** Is agent-server currently deployed on NAS Docker alongside relay? Or is it only in the codebase? The `packages/agent-server/Dockerfile` and `packages/agent-server/nginx/agent.conf` suggest Docker deployment is planned but may not be live.

2. **Desktop as Hand vs Desktop as Brain:** The current architecture has Desktop running AgentLoop locally AND connecting as a Hand to agent-server. After full migration, should Desktop ONLY be a Hand (no local AgentLoop)? Or should Desktop keep local fallback?

3. **LLM API keys location:** Currently LLM keys are in Desktop settings (`%APPDATA%/wzxclaw/keys.enc`). After migration, Brain (on NAS) needs access to these keys. How are API keys provided to the agent-server?

4. **MCP servers on NAS:** Desktop connects to MCP servers via stdio. After migration, should agent-server support MCP? Or should MCP stay as a Desktop-Hand-only feature?

5. **Session migration:** Desktop uses JSONL files per session, agent-server uses SQLite. Existing sessions need migration or the two systems need to coexist.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | HandBridge works but agent-server AgentLoop factory is not wired | Agent Server | If already wired in a branch, migration scope is smaller |
| A2 | Mobile does not connect to agent-server | Mobile Client | If mobile already has agent-server support, scope is smaller |
| A3 | Desktop's brain-bridge is the active code path | Desktop Bridge | If brain-bridge is not actually used at runtime, migration is less advanced |

## Sources

### Primary (HIGH confidence)
- Git HEAD source code for all packages (`packages/brain/`, `packages/hand/`, `packages/agent-server/`, `packages/web-ui/`, `wzxClaw_desktop/src/main/`, `wzxClaw_android/lib/`, `relay/`)
- package.json for each package (verified dependencies)
- CLAUDE.md project documentation

### Secondary (MEDIUM confidence)
- None needed -- all findings are from direct source code reading

### Tertiary (LOW confidence)
- None

## Metadata

**Confidence breakdown:**
- Current state analysis: HIGH -- read every relevant source file
- Drift findings: HIGH -- specific file paths and line counts verified
- Migration scope: MEDIUM -- estimates based on current code, may change with design decisions
- Open questions: honest gaps in knowledge

**Research date:** 2026-05-15
**Valid until:** 2026-06-15 (30 days -- stable unless active development)
