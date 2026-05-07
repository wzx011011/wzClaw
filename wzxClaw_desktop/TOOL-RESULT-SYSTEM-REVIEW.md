---
phase: tool-result-system
reviewed: 2026-04-30T08:00:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - src/main/tools/tool-interface.ts
  - src/main/context/tool-result-budget.ts
  - src/main/context/tool-result-storage.ts
  - src/main/tools/file-read.ts
  - src/main/tools/grep.ts
  - src/main/tools/web-fetch.ts
  - src/main/tools/web-search.ts
  - src/shared/constants.ts
  - src/main/paths.ts
  - src/main/agent/runtime-config.ts
  - src/main/agent/turn-manager.ts
  - src/main/agent/agent-loop.ts
  - src/main/agent/conversation-manager.ts
  - src/main/context/context-manager.ts
  - src/main/tools/__tests__/file-read.test.ts
  - src/main/context/__tests__/context-manager.test.ts
findings:
  critical: 1
  warning: 5
  info: 6
  total: 12
status: issues_found
---

# Tool Result System: Code Review Report

**Reviewed:** 2026-04-30T08:00:00Z  
**Depth:** standard  
**Files Reviewed:** 16  
**Status:** issues_found

## Summary

Reviewed the T1–T5 + C0 tool result system implementation across 16 source files. The overall architecture is sound: the `Infinity` bypass pattern, disk persistence with preview, and `ToolResultReplacementState` cache-freeze are clean and well-structured. The `ToolResultReplacementState` logic is correct—null vs undefined disambiguation works correctly.

Two substantive bugs stand out: `GrepTool` accepts an arbitrary `path` parameter with no workspace boundary check (prompt-injection exploitable), and `enforceContextBudget` can silently fail to enforce the budget when all entries are small. Additionally, the `replacementState` parameter on `createExecuteToolFn` is dead code, and there are significant test coverage gaps for the new subsystems.

---

## Critical Issues

### CR-01: GrepTool `path` parameter has no workspace boundary check

**File:** `src/main/tools/grep.ts:60-63`  
**Issue:** The `path` parameter is accepted from the LLM and used directly as the search root without any validation that it is inside the workspace. A prompt injection in a web-fetched page or malicious tool result could cause the model to call `Grep` with `path="C:\\Windows\\System32"` (or any absolute path), recursively reading all accessible files including credentials, private keys, and system files.

```typescript
// Current — no boundary check:
const dir = searchPath || context.workingDirectory
```

**Fix:** Mirror the boundary check already in `FileReadTool`. Reject paths outside `context.workingDirectory`:

```typescript
const rawDir = searchPath || context.workingDirectory
const absoluteDir = path.isAbsolute(rawDir)
  ? rawDir
  : path.resolve(context.workingDirectory, rawDir)

const normalizedWorkspace = path.resolve(context.workingDirectory).toLowerCase()
const normalizedDir = absoluteDir.toLowerCase()
if (!normalizedDir.startsWith(normalizedWorkspace + path.sep) && normalizedDir !== normalizedWorkspace) {
  return { output: `Blocked: Grep target is outside workspace boundary: ${absoluteDir}`, isError: true }
}
const dir = absoluteDir
```

---

## Warnings

### WR-01: `enforceContextBudget` silently fails when all entries are small

**File:** `src/main/context/tool-result-budget.ts:84-104`  
**Issue:** The compaction condition is `chars > maxPerResult / 2` (default: `30000 / 2 = 15000`). If the total budget is exceeded but all individual entries are ≤ 15,000 chars, the `if` block never executes—`excess` stays positive, no entries are compacted, and the function returns the still-over-budget array unchanged. The caller in `turn-manager.ts` then writes over-budget content to the conversation with no further enforcement.

```typescript
// Current — may not compact anything:
if (chars > maxPerResult / 2) {   // ← entries under 15K are never touched
  excess -= chars
  return { ...entry, result: `[Result compacted...]` }
}
return entry  // ← returned untouched even when total is over budget
```

**Fix:** Drop the `maxPerResult / 2` guard. Compact oldest entries unconditionally until `excess <= 0`:

```typescript
const compacted = sorted.map((entry) => {
  if (excess <= 0) return entry
  if (entry.result.startsWith('[Result compacted')) return entry
  const chars = entry.result.length
  excess -= chars
  return {
    ...entry,
    result: `[Result compacted — ${chars} chars removed to fit context budget]`
  }
})
```

---

### WR-02: `sessionId` used unsanitized in `getToolResultsDir` (path traversal)

**File:** `src/main/paths.ts:103-105`, `src/main/context/tool-result-storage.ts:49`  
**Issue:** `getToolResultsDir(sessionId)` calls `path.join(getUserDir(), 'tool-results', sessionId)`. Node's `path.join` normalizes `..` segments, so a crafted `sessionId` like `"../../.ssh/authorized_keys_dir"` would resolve outside `~/.wzxclaw/`. The `sessionId` comes from `config.conversationId`, which originates from the renderer via IPC. A compromised renderer could inject a traversal.

```typescript
// paths.ts — no sanitization:
export function getToolResultsDir(sessionId: string): string {
  return path.join(getUserDir(), 'tool-results', sessionId)
}
```

**Fix:** Apply the same sanitize logic already used for the filename:

```typescript
export function getToolResultsDir(sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200)
  return path.join(getUserDir(), 'tool-results', safeId)
}
```

---

### WR-03: `FileReadTool` workspace boundary check bypassed by symlinks

**File:** `src/main/tools/file-read.ts:70-76`  
**Issue:** The boundary check compares lowercased string paths. If the workspace contains a symlink (e.g., `workspace/link -> /etc/`), `absolutePath` resolves to `workspace/link/passwd`, which passes the `startsWith(normalizedWorkspace)` check. The file read then accesses `/etc/passwd` through the symlink. `fs.promises.readFile` follows symlinks by default.

```typescript
// Current — string comparison doesn't follow symlinks:
const normalizedPath = absolutePath.toLowerCase()
const isWithinWorkspace = normalizedPath.startsWith(normalizedWorkspace + path.sep) ...
```

**Fix:** Resolve the real path before the boundary check (wrap in try-catch for non-existent paths):

```typescript
let realAbsolutePath = absolutePath
try {
  realAbsolutePath = await fs.promises.realpath(absolutePath)
} catch {
  // 文件不存在时继续用 absolutePath，后续 existsSync 会捕获
}
const normalizedPath = realAbsolutePath.toLowerCase()
```

---

### WR-04: `createExecuteToolFn` accepts `replacementState` but never uses it

**File:** `src/main/agent/turn-manager.ts:88-101`  
**Issue:** `replacementState?: ToolResultReplacementState` is declared as a parameter of `createExecuteToolFn` but is not referenced anywhere in the returned closure. The persistence decision logic lives in `executeTurn`, which accesses `input.replacementState` instead. The dead parameter creates confusion about where persistence decisions are made and suggests a design residue from an earlier iteration.

**Fix:** Remove the `replacementState` parameter from `createExecuteToolFn`:

```typescript
createExecuteToolFn(
  toolRegistry: ToolRegistry,
  permissionManager: PermissionManager,
  contextManager: ContextManager,
  hookRegistry: HookRegistry | undefined,
  historyManager: FileHistoryManager | undefined,
  config: AgentConfig,
  abortSignal: AbortSignal,
  sender?: Electron.WebContents,
  workspaceId?: string,
  // ← remove replacementState here; it's accessed via TurnInput in executeTurn
): ExecuteToolFn {
```

And update the call site in `agent-loop.ts` accordingly.

---

### WR-05: `WebFetchTool` module-level cache is shared across all agent sessions

**File:** `src/main/tools/web-fetch.ts:18-40`  
**Issue:** `const cache = new Map<string, CacheEntry>()` is a module-level singleton shared across all sessions and sub-agents within the same Electron process. A URL fetched in one session (potentially with sensitive context in its response) is served from cache to a concurrent session without re-fetching. For the current single-user desktop app this is tolerable, but if sub-agents run concurrently (stream-phase read-only parallel execution), one sub-agent's cached result could be consumed by another. Additionally, expired entries are only purged on the next access to the same URL — they accumulate unboundedly until then (capped at 100 entries by size, not TTL).

**Fix (minimal):** Scope the cache to the `ToolExecutionContext` or pass it in via `context`. If short-term: add a periodic sweep on `setCache` calls:

```typescript
function purgeExpired(): void {
  const now = Date.now()
  for (const [url, entry] of cache.entries()) {
    if (now - entry.timestamp > WEB_FETCH_CACHE_TTL_MS) cache.delete(url)
  }
}

function setCache(url: string, content: string): void {
  purgeExpired()  // 写入时顺带清理过期项
  cache.set(url, { content, timestamp: Date.now() })
  // ...
}
```

---

## Info

### IN-01: `ToolResultReplacementState` has zero test coverage

**File:** `src/main/context/tool-result-storage.ts:93-130`  
**Issue:** The `ToolResultReplacementState` class — including `getCachedDecision`, `recordDecision` idempotency, `reset`, and the `null` vs `undefined` decision-replay semantics — has no unit tests. The null/undefined distinction is subtle enough to warrant explicit coverage.

**Fix:** Add a test file `src/main/context/__tests__/tool-result-storage.test.ts` covering:
- First call returns `undefined` (no decision recorded)
- After `recordDecision(id, null)` → `getCachedDecision` returns `null`  
- After `recordDecision(id, 'ref')` → `getCachedDecision` returns `'ref'`
- Second call to `recordDecision` on same id does not overwrite (idempotency)
- `reset()` clears all decisions

---

### IN-02: `enforceContextBudget` and `truncateToolResult` have no unit tests

**File:** `src/main/context/tool-result-budget.ts`  
**Issue:** Neither function has test coverage. Key untested paths for `enforceContextBudget`: total already within budget (no-op), all entries below the 15K compaction guard (currently buggy, see WR-01), empty array. Key untested paths for `truncateToolResult`: `toolMaxChars = Infinity` bypass, `middle` strategy output format, `toolMaxChars < maxChars` (Math.min branch).

---

### IN-03: `maybePersistLargeToolResult` has no unit tests

**File:** `src/main/context/tool-result-storage.ts:42-68`  
**Issue:** The persistence path (content above threshold → file written → placeholder returned) and the pass-through path (content below threshold → null returned) have no tests. The file-system interaction and the `buildPersistedOutputMessage` template are untested.

---

### IN-04: FileRead workspace boundary traversal attempt not tested

**File:** `src/main/tools/__tests__/file-read.test.ts`  
**Issue:** The existing test suite has no case for path traversal attempts. A test like `execute({ path: '../../etc/passwd' }, { workingDirectory: tempDir })` should assert `isError: true` and the "outside workspace boundary" message. Without this test, a regression in the boundary check would go undetected.

---

### IN-05: Grep tool `path` domain filter uses `includes()` — subdomain bypass possible

**File:** `src/main/tools/web-search.ts:141-149`  
**Issue:** Domain filtering in `WebSearchTool` uses `r.url.includes(d)`. A result URL like `http://evil.com/page?ref=github.com` would match `allowed_domains: ['github.com']`. This is low risk since allowed_domains is user-specified and DuckDuckGo controls the URLs, but it's worth hardening with a proper hostname check.

```typescript
// 建议：用 URL API 检查 hostname 而非 includes
import { URL } from 'url'
function urlMatchesDomain(url: string, domain: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === domain || hostname.endsWith('.' + domain)
  } catch { return false }
}
```

---

### IN-06: `MAX_TOOL_RESULT_CHARS` duplicated between `constants.ts` and `runtime-config.ts`

**File:** `src/shared/constants.ts:83`, `src/main/agent/runtime-config.ts:75`  
**Issue:** `MAX_TOOL_RESULT_CHARS = 30_000` (constants.ts) and `DEFAULT_RUNTIME_CONFIG.maxToolResultChars = 30_000` (runtime-config.ts) are two separate definitions with the same value. `GrepTool` internally truncates at the `constants.ts` value, while `truncateToolResult()` in tool-result-budget.ts uses the runtime-config value. If they ever drift apart, Grep's internal truncation and the upstream budget enforcement will disagree. `GrepTool.maxResultSizeChars = 20_000` adds a third related constant.

**Fix:** Have `GrepTool` import from runtime-config, or canonicalize through a single constant:

```typescript
// In grep.ts, replace the hardcoded MAX_TOOL_RESULT_CHARS reference:
import { DEFAULT_RUNTIME_CONFIG } from '../agent/runtime-config'
// ...
if (output.length > DEFAULT_RUNTIME_CONFIG.maxToolResultChars) {
  output = output.substring(0, DEFAULT_RUNTIME_CONFIG.maxToolResultChars)
}
```

---

_Reviewed: 2026-04-30T08:00:00Z_  
_Reviewer: Claude (gsd-code-reviewer)_  
_Depth: standard_
