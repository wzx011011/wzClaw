# Phase 07 Code Review: Core Interaction

**Reviewer**: Automated Review (Standard Depth)
**Date**: 2026-04-08
**Files Reviewed**: 21 files across main process, preload, renderer, and shared layers

---

## Summary

Phase 07 implements the core interaction layer connecting the AI agent loop to the desktop GUI. The codebase demonstrates solid architectural patterns: clear separation between IPC channel definitions, store logic, and UI components; Zod-based input validation on IPC boundaries; and a clean event-driven streaming model. The session persistence via JSONL, the diff store with LCS-based hunk computation, and the multi-session tab system are all well-structured.

That said, the review identified **12 issues** across security, correctness, performance, and maintainability categories. Three are rated CRITICAL, four MEDIUM, and five LOW.

---

## Issue Table

| # | Severity | File | Category | Summary |
|---|----------|------|----------|---------|
| 1 | CRITICAL | `ipc-handlers.ts` | Security | `file:apply-hunk` writes arbitrary absolute paths without validation |
| 2 | CRITICAL | `ipc-handlers.ts` | Security | `file:save` handler passes unvalidated filePath to workspaceManager |
| 3 | CRITICAL | `session-store.ts` | Reliability | `appendMessage` uses synchronous I/O on every agent message, blocking main process |
| 4 | MEDIUM | `diff-store.ts` | Correctness | LCS diff has O(n*m) memory; large files will exhaust heap |
| 5 | MEDIUM | `chat-store.ts` | Correctness | `switchSession` uses stale `conversationId` after `loadSession` mutates state |
| 6 | MEDIUM | `ipc-handlers.ts` | Correctness | `workspace:open_folder` re-registers `onFileChange` listener every call, leaking handlers |
| 7 | MEDIUM | `session-store.ts` | Correctness | `renameSession` is not atomic; crash mid-write corrupts the session file |
| 8 | LOW | `MentionPicker.tsx` | Performance | `fuzzyMatch` called twice per file during render (once for filtering, once for highlighting) |
| 9 | LOW | `ChatMessage.tsx` | Correctness | `displayContent` splitting heuristic `[Context from` is fragile and locale-dependent |
| 10 | LOW | `chat-store.ts` | Memory | `sessionsCache` grows unboundedly; no eviction strategy |
| 11 | LOW | `EditorPanel.tsx` | Maintainability | Diff decorations stored on editor instance via `(editor as unknown as Record<string, ...>).__diffDecorations` |
| 12 | LOW | `command-store.ts` | UX | `view.toggle-sidebar` uses DOM query (`document.querySelector`) instead of store-driven state |

---

## Detailed Findings

### Issue 1: CRITICAL -- Unvalidated File Path in `file:apply-hunk`

**File**: `src/main/ipc-handlers.ts`, lines 302-312

The `file:apply-hunk` handler destructures `filePath` and `modifiedContent` directly from the IPC request and writes to disk. Unlike `file:read-content` which validates via Zod schema and resolves relative paths against the workspace root, this handler:

- Accepts any absolute path (e.g., `C:\Windows\System32\config`)
- Does not validate that `filePath` is within the workspace root
- Does not use the workspace manager for path resolution
- Has no Zod schema validation

The preload script exposes `applyHunk` to the renderer, meaning a compromised renderer process could overwrite arbitrary system files.

**Recommendation**: Add Zod schema validation, resolve the path relative to workspace root, and verify the resolved path stays within the workspace boundary before writing.

---

### Issue 2: CRITICAL -- Unvalidated File Path in `file:save`

**File**: `src/main/ipc-handlers.ts`, lines 267-269

The `file:save` handler passes `request.filePath` and `request.content` directly to `workspaceManager.saveFile` without any schema validation or workspace boundary check. The same class of vulnerability as Issue 1 applies here. A compromised renderer could save arbitrary content to any file path.

**Recommendation**: Add Zod schema validation and workspace boundary enforcement, consistent with `file:read-content`.

---

### Issue 3: CRITICAL -- Synchronous File I/O in Main Process

**File**: `src/main/persistence/session-store.ts`, lines 56-70

Both `appendMessage` and `appendMessages` use `fs.appendFileSync`, which blocks the Electron main process event loop. After an agent turn completes, `ipc-handlers.ts` line 136-137 iterates all messages and calls `appendMessage` for each one synchronously. For a long conversation with many messages, this introduces noticeable UI freezes.

The `listSessions` method (lines 103-161) is even worse: it reads every `.jsonl` file in the project directory synchronously (`fs.readFileSync`) to extract metadata. With many sessions, this is a blocking operation that can freeze the entire application for seconds.

**Recommendation**: Convert `appendMessage`/`appendMessages` to async using `fs.promises.appendFile`. Batch-write messages in a single file operation. Make `listSessions` async and consider caching session metadata rather than re-reading all files on every call.

---

### Issue 4: MEDIUM -- LCS Diff Memory Complexity

**File**: `src/renderer/stores/diff-store.ts`, lines 32-131

The `computeHunks` function builds a full DP table of size `(m+1) * (n+1)` where m and n are line counts of original and modified content. For a file with 10,000 lines, this allocates ~100 million entries (a 2D array of numbers), consuming approximately 800MB of memory. This will crash the renderer process.

The tests only cover small files (3-8 lines). There is no guard in `addDiff` or in `ToolCard` to limit diff computation by file size.

**Recommendation**: Either: (a) add a line-count limit (e.g., skip diff for files over 1000 lines, matching `MAX_DIFF_FILE_LINES` in constants), or (b) switch to a streaming diff algorithm (Myers diff with O(ND) complexity) for large files. At minimum, guard `addDiff` with a size check before calling `computeHunks`.

---

### Issue 5: MEDIUM -- Stale `conversationId` in `switchSession`

**File**: `src/renderer/stores/chat-store.ts`, lines 394-421

In `switchSession`, the code captures `conversationId` at line 395, then calls `get().loadSession(sessionId)` at line 415. The `loadSession` method (line 326-347) calls `set({ conversationId: sessionId, ... })`, which updates the store state. After `loadSession` returns, the code at line 418 sets `activeSessionId: sessionId` but does not update `conversationId` again. This is actually fine in the current implementation because `loadSession` already set `conversationId`. However, the problem is at line 402: `newCache[conversationId]` uses the captured (pre-mutation) value, which is correct. The real issue is a subtler race: if `loadSession` fails (catch at line 343), `conversationId` will not be updated but `activeSessionId` will still be set to the new session, creating an inconsistency between the two IDs.

**Recommendation**: After the `loadSession` call, verify it succeeded before updating `activeSessionId`. Alternatively, restructure so both `conversationId` and `activeSessionId` are set in the same `set()` call after load completes.

---

### Issue 6: MEDIUM -- Leaking File Change Listeners

**File**: `src/main/ipc-handlers.ts`, lines 189-193

Inside the `workspace:open_folder` handler, `workspaceManager.onFileChange` is called to register a listener. Every time the user opens a folder, a new listener is added. There is no cleanup of the previous listener. Over repeated folder-open operations, the listeners accumulate, causing duplicate `file:changed` events to be sent to all windows.

**Recommendation**: Store the unsubscribe function from the previous `onFileChange` call and invoke it before registering a new one. Alternatively, register the listener once during initialization and have it forward events whenever the workspace is active.

---

### Issue 7: MEDIUM -- Non-Atomic Session Rename

**File**: `src/main/persistence/session-store.ts`, lines 182-215

The `renameSession` method reads the entire file into memory, modifies lines, then writes the full content back with `fs.writeFileSync`. If the process crashes between the read and write (e.g., power failure, OOM kill during a large session), the file will be truncated or empty, losing all session data.

**Recommendation**: Use atomic write: write to a temporary file in the same directory, then rename it over the original. The `fs.renameSync` operation is atomic on most filesystems.

---

### Issue 8: LOW -- Double Fuzzy Match in MentionPicker

**File**: `src/renderer/components/chat/MentionPicker.tsx`

The `filteredFiles` memo at line 81-98 calls `fuzzyMatch` for each file to build the filtered list. Then `renderPath` at line 167-183 calls `fuzzyMatch` again for each visible file to compute highlight indices. For large workspaces, this means each visible file's fuzzy match is computed twice.

**Recommendation**: Cache the match indices in `filteredFiles` (store `{ entry, indices }` tuples) and pass the pre-computed indices to `renderPath`.

---

### Issue 9: LOW -- Fragile Display Content Heuristic

**File**: `src/renderer/components/chat/ChatMessage.tsx`, lines 52-54

The `displayContent` logic strips lines starting with `[Context from` by splitting on double newlines and filtering. This is fragile because:

- If the user's actual message starts with `[Context from`, it will be silently stripped
- The heuristic is tightly coupled to the format string in `chat-store.ts` line 246
- Any change to the mention format string will break the display silently

**Recommendation**: Store the original user message text separately from the formatted mention-augmented content (e.g., add an `originalContent` field to the `ChatMessage` type for user messages). Use `originalContent` for display and `content` for the LLM.

---

### Issue 10: LOW -- Unbounded sessionsCache

**File**: `src/renderer/stores/chat-store.ts`, line 41

The `sessionsCache: Record<string, ChatMessage[]>` grows indefinitely as the user creates and switches between sessions. There is no eviction logic. For a long-running IDE session with many conversations, this can consume significant memory.

**Recommendation**: Add an LRU eviction policy (e.g., keep only the last 10 cached sessions). When a session is evicted from cache, it can be reloaded from the JSONL file via IPC on demand.

---

### Issue 11: LOW -- Type-Unsafe Decoration Storage on Editor

**File**: `src/renderer/components/ide/EditorPanel.tsx`, lines 60-62, 107-109

Monaco editor decorations are stored on the editor instance via `(editor as unknown as Record<string, string[]>).__diffDecorations`. This bypasses TypeScript's type system and relies on mutating a host object. If the editor instance is recreated (e.g., file switch), the stale decorations array will be lost, causing the old decorations to not be properly cleaned up.

**Recommendation**: Store decoration IDs in a React ref (`useRef<string[]>([])`) instead of on the editor instance. This is type-safe and survives correctly across renders.

---

### Issue 12: LOW -- DOM-Based Sidebar Toggle

**File**: `src/renderer/stores/command-store.ts`, lines 120-124

The `view.toggle-sidebar` command toggles a CSS class via `document.querySelector('.sidebar-pane')`. This is imperative DOM manipulation that circumvents React's rendering cycle. If the sidebar component is refactored or the class name changes, this command silently breaks.

**Recommendation**: Add a `sidebarVisible` boolean to a store (e.g., workspace store), toggle it from the command, and have the sidebar component read from that store.

---

## Positive Observations

1. **IPC channel architecture** (`src/shared/ipc-channels.ts`): The centralized channel name constants, typed payload maps, and Zod schemas provide strong type safety at the IPC boundary. This is a well-executed pattern.

2. **Preload script** (`src/preload/index.ts`): Clean, minimal API surface. Each event listener returns an unsubscribe function. No unnecessary exposure of Electron APIs.

3. **Multi-session tab system** (`SessionTabs.tsx`, `chat-store.ts`): The tab bar with rename, close, close-others, and confirmation-before-delete is polished UX. The cache-first, IPC-fallback strategy for session switching is sound.

4. **Diff system design** (`diff-store.ts`, `DiffPreview.tsx`, `EditorPanel.tsx`): The per-hunk accept/reject workflow with Monaco decorations is well-architected. The separation between the store logic, the toolbar UI, and the editor decoration management is clean.

5. **Chat streaming model** (`chat-store.ts` `init` method): Subscribing to all 5 stream events in a single `init()` call with a combined unsubscribe function is elegant and prevents listener leaks on remount.

6. **Test coverage** (`chat-store.test.ts`, `diff-store.test.ts`, `ipc-channels.test.ts`): 22 test cases across three test files covering the critical paths: session CRUD, hunk computation, accept/reject flows, and schema validation. The tests are well-structured with proper setup/teardown.

---

## Architecture Assessment

### Strengths
- Clear three-layer separation: shared types/channels, main process handlers, renderer stores/components
- Zod validation at IPC boundaries prevents malformed data from crossing process boundaries
- Event-driven streaming (main pushes events, renderer subscribes) is the correct Electron pattern
- Store logic is centralized in Zustand stores, keeping components thin

### Risks
- All file-path accepting handlers need consistent validation (Issues 1, 2)
- Synchronous I/O in the main process (Issue 3) will degrade as session count grows
- The LCS diff algorithm will break on large files (Issue 4) -- needs a size guard before production use
- Listener leak on repeated folder open (Issue 6) is a subtle bug that will manifest over time

---

## File Reference Index

| File | Lines | Role |
|------|-------|------|
| `src/main/ipc-handlers.ts` | 342 | IPC handler registration, agent event forwarding, file/session ops |
| `src/main/persistence/session-store.ts` | 217 | JSONL-based session persistence with SHA-256 project isolation |
| `src/preload/index.ts` | 89 | Context bridge API for renderer-to-main communication |
| `src/renderer/components/chat/ChatMessage.tsx` | 156 | Message rendering with markdown, code blocks, tool cards, mentions |
| `src/renderer/components/chat/ChatPanel.tsx` | 270 | Full chat interface with input, model selector, settings |
| `src/renderer/components/chat/DiffPreview.tsx` | 140 | Inline diff toolbar with Accept/Reject per hunk |
| `src/renderer/components/chat/MentionPicker.tsx` | 201 | Fuzzy file picker triggered by @ in chat input |
| `src/renderer/components/chat/SessionTabs.tsx` | 199 | Multi-session tab bar with rename and delete |
| `src/renderer/components/chat/ToolCard.tsx` | 149 | Tool call visualization with Review Changes button |
| `src/renderer/components/ide/EditorPanel.tsx` | 153 | Monaco Editor wrapper with diff decorations |
| `src/renderer/components/ide/IDELayout.tsx` | 129 | Root layout with global keyboard shortcuts and event wiring |
| `src/renderer/stores/__tests__/chat-store.test.ts` | 227 | 8 tests for multi-session CRUD operations |
| `src/renderer/stores/__tests__/diff-store.test.ts` | 362 | 11 tests for diff hunk computation and accept/reject |
| `src/renderer/stores/chat-store.ts` | 526 | Chat state management with streaming, sessions, mentions |
| `src/renderer/stores/command-store.ts` | 153 | Command palette registry with 8 built-in commands |
| `src/renderer/stores/diff-store.ts` | 290 | Diff state with LCS-based hunk computation |
| `src/renderer/styles/chat.css` | 1476 | Complete styling for chat panel, tools, diffs, tabs, mentions |
| `src/shared/__tests__/ipc-channels.test.ts` | 122 | 10 tests for channel constants, schemas, and mention types |
| `src/shared/constants.ts` | 49 | Model presets, default system prompt, size limits |
| `src/shared/ipc-channels.ts` | 176 | Channel name constants, payload types, Zod schemas |
| `src/shared/types.ts` | 230 | Shared type definitions for messages, tools, diffs, sessions |
