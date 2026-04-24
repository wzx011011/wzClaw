---
phase: streaming-fix
reviewed: 2026-04-22T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/renderer/stores/chat-store.ts
  - src/renderer/components/chat/ChatMessage.tsx
  - src/renderer/styles/ide.css
  - src/main/agent/stream-phase.ts
  - src/main/agent/streaming-tool-executor.ts
  - src/main/agent/types.ts
  - src/main/ipc-handlers.ts
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase streaming-fix: Code Review Report

**Reviewed:** 2026-04-22
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Reviewed 7 files involved in the streaming output pipeline for an Electron-based AI coding IDE. The codebase is well-structured with clear separation between the agent stream phase, tool executor, IPC handlers, and renderer store. No critical security vulnerabilities or data-loss bugs were found.

The main concerns are: (1) a thinking-delta handler that mutates `content` instead of a dedicated `thinkingContent` field, causing interleaving artifacts; (2) a stale-closure race in the chat store where rapid IPC events can create duplicate assistant messages; (3) inconsistent event channel naming between main process and preload; (4) no concurrent-send guard on the main process IPC handler. There are also several type-safety and cleanup items.

## Critical Issues

None found.

## Warnings

### WR-01: Thinking deltas are appended to `content` instead of a separate field

**File:** `src/renderer/stores/chat-store.ts:164-180`
**Issue:** The `onStreamThinking` handler appends thinking content to `m.content` using string concatenation (`m.content + payload.content`). This means thinking text and regular text deltas both accumulate in the same `content` field. When text deltas arrive after thinking deltas, the rendered output will interleave thinking and normal text with no way to separate them. The change description mentions a `thinkingContent` field was added, but no such field exists on `ChatMessage` (line 19-30).

Additionally, `ChatMessage.tsx` mentions "collapsible thinking block rendering" in the change description, but no thinking-related rendering code exists in the component. The thinking content is currently rendered as plain text mixed into the assistant message body.

**Fix:** Add a `thinkingContent` field to the `ChatMessage` interface and accumulate thinking deltas there separately:

```typescript
// In ChatMessage interface:
export interface ChatMessage {
  // ... existing fields ...
  thinkingContent?: string  // separate from content
}

// In onStreamThinking handler:
if (lastAssistantIdx) {
  set({
    isWaitingForResponse: false,
    messages: messages.map((m, i) =>
      i === lastAssistantIdx.i
        ? { ...m, thinkingContent: (m.thinkingContent ?? '') + payload.content }
        : m
    )
  })
}
```

Then render `thinkingContent` as a collapsible block in `ChatMessage.tsx` when present.

### WR-02: Race condition can create duplicate assistant messages on rapid text deltas

**File:** `src/renderer/stores/chat-store.ts:132-161`
**Issue:** The `onStreamText` handler reads `get().messages` to find the last streaming assistant message. If two text deltas arrive in rapid succession, the second call to `get()` may still see the old `messages` array (before the first `set()` has been processed), causing it to create a new assistant message instead of appending to the existing one. This produces duplicate assistant bubbles in the chat.

The same race applies to `onStreamThinking` (line 164), `onStreamToolStart` (line 183), and `onStreamTurnEnd` (line 291) -- all use the same `get()`-then-`set()` pattern on `messages`.

**Fix:** Use Zustand's `set` with a callback that receives the current state, which guarantees sequential access:

```typescript
const unsubText = window.wzxclaw.onStreamText((payload) => {
  set((state) => {
    const messages = state.messages
    const lastAssistantIdx = [...messages]
      .map((m, i) => ({ m, i }))
      .reverse()
      .find(({ m }) => m.role === 'assistant' && m.isStreaming)

    if (lastAssistantIdx) {
      return {
        isWaitingForResponse: false,
        messages: messages.map((m, i) =>
          i === lastAssistantIdx.i
            ? { ...m, content: m.content + payload.content }
            : m
        )
      }
    }

    const newMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: payload.content,
      timestamp: Date.now(),
      isStreaming: true,
      toolCalls: []
    }
    return { isWaitingForResponse: false, messages: [...messages, newMsg] }
  })
})
```

Apply the same pattern to all stream handlers that read-then-write `messages`.

### WR-03: No concurrent-send guard on agent:send_message IPC handler

**File:** `src/main/ipc-handlers.ts:63-230`
**Issue:** The `agent:send_message` IPC handler has no guard against concurrent invocations. If the user (or a programmatic caller) sends a second message while the first `for await` loop is still running, both loops will forward events to the same renderer window simultaneously. This causes interleaved `stream:text_delta`, `stream:tool_use_start`, and `stream:done` events, producing garbled chat output.

The change description mentions an `isAgentRunning` concurrent guard was added, but no such guard exists in the code.

**Fix:** Add a module-level flag that prevents re-entry:

```typescript
let isAgentRunning = false

ipcMain.handle(IPC_CHANNELS['agent:send_message'], async (event, request) => {
  if (isAgentRunning) {
    throw new Error('Agent is already running. Stop the current generation first.')
  }
  isAgentRunning = true

  try {
    // ... existing for-await loop ...
  } finally {
    isAgentRunning = false
  }
})
```

### WR-04: `onStreamToolResult` preload type is missing `toolName` field

**File:** `src/preload/index.ts:26-29` (cross-referenced from `src/main/ipc-handlers.ts:151-156`)
**Issue:** The main process sends `{ id, output, isError, toolName }` on the `stream:tool_use_end` channel (ipc-handlers.ts lines 151-156), but the preload `onStreamToolResult` callback type only declares `{ id: string; output: string; isError: boolean }`. The `toolName` field is present in the IPC payload but invisible to TypeScript at the renderer boundary. This does not cause a runtime crash but is a type-safety gap -- renderer code accessing `payload.toolName` would need an unsafe cast.

**Fix:** Update the preload type to include `toolName`:

```typescript
onStreamToolResult: (callback: (payload: { id: string; output: string; isError: boolean; toolName: string }) => void) => {
```

### WR-05: `stream-phase.ts` yields `isError: true` on tool results even when tool succeeded, if `hadError` is set

**File:** `src/main/agent/stream-phase.ts:165-173`
**Issue:** When `hadError` is true (a stream-level error occurred before tool results arrived), the code on line 166-172 unconditionally yields `isError: true` for every pending tool result, regardless of the actual tool execution outcome. If a tool completed successfully but a different error occurred during the stream, the UI will display all tool calls as failed, which is misleading. The actual `result.isError` is available on line 158 but is overridden on line 166.

**Fix:** Use the actual result's error status:

```typescript
if (hadError) {
  yield {
    type: 'agent:tool_result',
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    output: result.output,
    isError: result.isError,  // use actual tool result, not hardcoded true
  }
  continue
}
```

## Info

### IN-01: `tool_result` role type on `ChatMessage` is used only during session load parsing

**File:** `src/renderer/stores/chat-store.ts:21`
**Issue:** The `ChatMessage` interface includes `role: 'user' | 'assistant' | 'tool_result'`, but `tool_result` is only used transiently during `loadSession` (line 546, 559, 571) where messages are parsed from persistence and tool_result messages are merged into assistant messages before being stored. No `ChatMessage` with `role: 'tool_result'` is ever added to the live `messages` array during streaming. The union type is not a bug but it widens the type unnecessarily -- any code that switches on `message.role` must handle a case that never occurs at runtime.

**Fix:** Consider using a narrower type for the live `messages` array (`role: 'user' | 'assistant'`) and keeping the wider type only for the persistence parsing layer. Alternatively, document that `tool_result` is only used during deserialization.

### IN-02: `sendMessage` lacks a timeout on the IPC call

**File:** `src/renderer/stores/chat-store.ts:488`
**Issue:** The change description mentions a "sendMessage timeout (10min)" but `window.wzxclaw.sendMessage` is a bare `ipcRenderer.invoke` with no timeout. If the main process hangs indefinitely (e.g., LLM API never responds, agent loop blocked on permission prompt), the renderer's `isStreaming` state remains `true` with no automatic recovery. The user must manually click "Stop" to recover.

**Fix:** Wrap the IPC call with a timeout:

```typescript
const SEND_TIMEOUT = 10 * 60 * 1000 // 10 minutes
await Promise.race([
  window.wzxclaw.sendMessage({ conversationId, content: formattedAgentContent, activeTaskId }),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Agent call timed out after 10 minutes')), SEND_TIMEOUT)
  )
])
```

### IN-03: `onStreamTurnEnd` uses `?? (() => {})` fallback pattern that silently swallows missing APIs

**File:** `src/renderer/stores/chat-store.ts:291-318`
**Issue:** Several stream handlers (`onStreamThinking`, `onStreamTurnEnd`, `onMobileUserMessage`, `onSessionContextRestored`, `onStreamRetrying`, `onSessionRestore`, `onTodoUpdated`) use the pattern `window.wzxclaw.onXxx?.(() => ...) ?? (() => {})`. If the preload API is missing or fails to register, these handlers silently do nothing. While this is intentional for optional APIs, the fallback `() => {}` means the unsubscribe function returned by `init()` will call a no-op, and the handler list will contain entries that cannot be cleaned up. This is a minor maintenance concern.

**Fix:** Consider logging a warning when an optional API is not available, or at minimum documenting which APIs are optional vs required.

### IN-04: `ipc-handlers.ts` line 969 logs a partial API key to console

**File:** `src/main/ipc-handlers.ts:969`
**Issue:** The insights handler logs `apiKey=${config.apiKey?.slice(0, 8)}...` to the console. While only the first 8 characters are exposed and this is in the main process (not renderer), it is still a credential fragment in log output. On some systems, Electron main process console output may be captured by logging agents or crash reporters.

**Fix:** Remove or reduce the key fragment in the log:

```typescript
console.log(`[insights] config: provider=${config.provider} model=${config.model} baseURL=${effectiveBaseUrl} hasApiKey=${!!config.apiKey}`)
```

---

_Reviewed: 2026-04-22_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
