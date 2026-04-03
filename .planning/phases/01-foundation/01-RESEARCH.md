# Phase 1: Foundation - Research

**Phase:** 01-foundation
**Researched:** 2026-04-03
**Confidence:** HIGH (based on existing STACK.md, ARCHITECTURE.md, PITFALLS.md + Claude Code source + web research)

## Domain Knowledge

### LLM Streaming: Provider Differences

The two LLM providers have fundamentally different streaming APIs. The LLM Gateway must handle both transparently.

**OpenAI SDK v6 (`openai` npm package):**
- Streaming via `stream: true` in `client.chat.completions.create()`
- Returns async iterable of `ChatCompletionChunk` objects
- Each chunk: `chunk.choices[0]?.delta?.content` for text deltas
- Tool calls: `chunk.choices[0]?.delta?.tool_calls[i]?.function?.arguments` — partial JSON strings accumulated across chunks
- Final chunk has `finish_reason: 'stop'` or `finish_reason: 'tool_calls'`
- DeepSeek is fully compatible — just change `baseURL` to `https://api.deepseek.com`

**Anthropic SDK (`@anthropic-ai/sdk` npm package):**
- Streaming via `client.messages.stream()` or `stream: true` in `client.messages.create()`
- Returns `MessageStream` — async iterable of typed events
- Events: `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Text delta: event type `content_block_delta` with `delta.type === 'text_delta'` and `delta.text`
- Tool use: `content_block_start` with `type: 'tool_use'`, then `content_block_delta` with `type: 'input_json_delta'` and `delta.partial_json`
- Must accumulate `partial_json` chunks into complete JSON before executing tool
- Usage info in `message_delta` event: `delta.stop_reason` and `usage` object

**Critical difference:** OpenAI uses `choices[0].delta` pattern; Anthropic uses `content_block_start/delta/stop` events. These are NOT interchangeable — separate adapters are mandatory.

### Tool Call Accumulation Pattern

Both providers stream tool call arguments as partial JSON strings. The Gateway must:

1. Detect `tool_use` / `tool_calls` start in stream
2. Accumulate all partial argument chunks
3. Parse complete JSON when the block ends
4. Yield a structured `tool_use` event with complete, parsed arguments

This is the #1 pitfall from PITFALLS.md (PIT-01). Claude Code handles this in its streaming layer — we must replicate it.

### electron-vite Project Structure

electron-vite enforces a specific directory structure:

```
src/
  main/       # Electron Main Process (Node.js)
  preload/    # Preload scripts (contextBridge)
  renderer/   # Renderer Process (React + Chromium)
```

Key config: `electron.vite.config.ts` at project root. Handles TypeScript, CSS, and bundling for all three targets.

**For type-safe IPC:** The recommended approach is `@electron-toolkit/typed-ipc` (from electron-vite ecosystem) or manual typed channels via Zod schemas + contextBridge.

## Architecture

### Package Layout for Phase 1

Phase 1 delivers three packages that later phases build upon:

```
src/
  shared/                    # Shared types (importable by main + renderer + preload)
    types.ts                 # Message, Conversation, LLM response types
    ipc-channels.ts          # IPC channel name constants + payload type maps
    constants.ts             # Shared constants

  main/
    llm/                     # LLM Gateway
      types.ts               # Internal LLM types (stream events, provider config)
      gateway.ts             # Unified LLM Gateway interface
      openai-adapter.ts      # OpenAI/DeepSeek streaming adapter
      anthropic-adapter.ts   # Anthropic Claude streaming adapter

  preload/
    index.ts                 # contextBridge: expose typed IPC API

  renderer/                  # Minimal stub for Phase 1
    App.tsx
    main.tsx
```

### Data Flow: LLM Streaming

```
Agent Runtime (Phase 2)
    ↓ calls
LLM Gateway
    ↓ selects adapter
OpenAI Adapter  OR  Anthropic Adapter
    ↓ makes API call      ↓ makes API call
OpenAI API           Anthropic API
    ↓ streams chunks   ↓ streams events
    ↓ adapter normalizes to internal format
    ↓ yields AsyncGenerator<StreamEvent>
Agent Runtime receives unified StreamEvents
```

### Data Flow: IPC

```
Renderer (React)
    ↓ window.wzxclaw.sendMessage(msg)
Preload (contextBridge)
    ↓ ipcRenderer.invoke('agent:user_message', msg)
Main Process
    ↓ ipcMain.handle('agent:user_message', handler)
Handler processes message
    ↓ ipcRenderer.emit('stream:text', chunk) (via webContents.send)
Preload
    ↓ callback forwarded to renderer
Renderer updates UI
```

## Implementation Patterns

### Pattern 1: Unified LLM Stream Event Type

```typescript
// src/shared/types.ts
type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partial_json: string }
  | { type: 'tool_use_end'; id: string; parsed_input: unknown }
  | { type: 'error'; error: Error }
  | { type: 'done'; usage: TokenUsage }

// Gateway interface
interface LLMGateway {
  stream(messages: Message[], options: LLMOptions): AsyncGenerator<StreamEvent>
}
```

### Pattern 2: OpenAI Adapter Streaming

```typescript
// src/main/llm/openai-adapter.ts
import OpenAI from 'openai'

async function* streamOpenAI(messages, options): AsyncGenerator<StreamEvent> {
  const stream = await client.chat.completions.create({
    model: options.model,
    messages: messages,
    stream: true,
    ...(options.systemPrompt && { system: options.systemPrompt }),
  })

  const toolCallAccumulators = new Map<number, { id: string; name: string; args: string }>()

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta
    // Text delta
    if (delta?.content) {
      yield { type: 'text_delta', content: delta.content }
    }
    // Tool call delta
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const acc = toolCallAccumulators.get(tc.index) || { id: tc.id || '', name: tc.function?.name || '', args: '' }
        if (tc.id) acc.id = tc.id
        if (tc.function?.name) acc.name = tc.function.name
        if (tc.function?.arguments) acc.args += tc.function.arguments
        toolCallAccumulators.set(tc.index, acc)
      }
    }
    // Check for finish
    if (chunk.choices[0]?.finish_reason === 'tool_calls') {
      for (const [, acc] of toolCallAccumulators) {
        yield { type: 'tool_use_end', id: acc.id, parsed_input: JSON.parse(acc.args) }
      }
    }
  }
  yield { type: 'done', usage: { /* extract from final chunk */ } }
}
```

### Pattern 3: Anthropic Adapter Streaming

```typescript
// src/main/llm/anthropic-adapter.ts
import Anthropic from '@anthropic-ai/sdk'

async function* streamAnthropic(messages, options): AsyncGenerator<StreamEvent> {
  const stream = client.messages.stream({
    model: options.model,
    max_tokens: options.maxTokens || 8192,
    messages: messages,
    system: options.systemPrompt,
  })

  const toolAccumulators = new Map<string, string>() // id -> accumulated json

  for await (const event of stream) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      // Text block started
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { type: 'text_delta', content: event.delta.text }
    }
    if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
      toolAccumulators.set(event.content_block.id, '')
      yield { type: 'tool_use_start', id: event.content_block.id, name: event.content_block.name }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
      const acc = (toolAccumulators.get(event.content_block_id) || '') + event.delta.partial_json
      toolAccumulators.set(event.content_block_id ?? '', acc)
      yield { type: 'tool_use_delta', id: event.content_block_id ?? '', partial_json: event.delta.partial_json }
    }
    if (event.type === 'content_block_stop') {
      const acc = toolAccumulators.get(event.index)
      if (acc !== undefined) {
        yield { type: 'tool_use_end', id: event.index, parsed_input: JSON.parse(acc) }
      }
    }
  }

  const finalMessage = await stream.finalMessage()
  yield { type: 'done', usage: { input_tokens: finalMessage.usage.input_tokens, output_tokens: finalMessage.usage.output_tokens } }
}
```

### Pattern 4: Type-Safe IPC via contextBridge + Zod

```typescript
// src/shared/ipc-channels.ts
export const IPC_CHANNELS = {
  // Agent channels
  'agent:user_message': { request: UserMessageSchema, response: z.void() },
  'agent:stop': { request: z.void(), response: z.void() },
  // Stream channels (main -> renderer, fire-and-forget)
  'stream:text': { data: z.object({ content: z.string() }) },
  'stream:tool_start': { data: z.object({ id: z.string(), name: z.string(), input: z.unknown() }) },
  'stream:tool_result': { data: z.object({ id: z.string(), output: z.string(), isError: z.boolean() }) },
  'stream:end': { data: z.object({ usage: TokenUsageSchema }) },
} as const

// src/preload/index.ts
const api = {
  sendMessage: (msg: UserMessage) => ipcRenderer.invoke('agent:user_message', msg),
  onStreamText: (cb: (chunk: string) => void) =>
    ipcRenderer.on('stream:text', (_, data) => cb(data.content)),
  onStreamEnd: (cb: () => void) =>
    ipcRenderer.on('stream:end', () => cb()),
  stopGeneration: () => ipcRenderer.invoke('agent:stop'),
}
contextBridge.exposeInMainWorld('wzxclaw', api)
```

### Pattern 5: electron-vite Project Bootstrap

Use `npm create @quick-start/electron@latest` to scaffold the project with React + TypeScript template. This gives:
- `electron.vite.config.ts` — build configuration
- `src/main/index.ts` — Electron entry
- `src/preload/index.ts` — Preload script
- `src/renderer/main.tsx` — React entry
- TypeScript configs for all three targets

## Pitfalls & Gotchas

### Phase 1 Specific Pitfalls

1. **Tool call JSON accumulation (PIT-01):** Both providers stream tool call arguments as partial JSON. Must accumulate ALL chunks before parsing. Premature parsing = malformed JSON = crash.

2. **Multi-LLM format differences (PIT-06):** OpenAI uses `choices[0].delta.tool_calls[i]` with index-based tracking. Anthropic uses `content_block_start/delta/stop` with ID-based tracking. Adapters MUST NOT share accumulation logic.

3. **IPC serialization limits (PIT-07):** contextBridge uses structured clone algorithm. Cannot pass: functions, class instances, DOM nodes, Symbols, WeakMaps. Only plain objects, arrays, strings, numbers, booleans, null, undefined, Date, RegExp, Map, Set, ArrayBuffer, TypedArrays.

4. **Anthropic SDK requires `max_tokens`:** Unlike OpenAI, Anthropic API requires `max_tokens` parameter. Default to 8192.

5. **OpenAI SDK baseURL for DeepSeek:** Must set `baseURL: 'https://api.deepseek.com'` and use model names like `deepseek-chat` or `deepseek-reasoner`.

6. **Stream error handling:** Both APIs can fail mid-stream. Wrap stream consumption in try/catch. Yield error events, don't throw (agent loop needs to handle gracefully).

7. **TypeScript path aliases:** electron-vite uses `@/` prefix for renderer imports and may need separate `tsconfig.json` files for main/preload/renderer. Shared types must be importable from all three.

8. **Zod v4 vs v3:** Claude Code uses `zod/v4` import. For wzxClaw, use Zod v3 (stable, widely documented) unless there's a specific reason for v4.

## Validation Architecture

### Testable Criteria for Phase 1

| # | Criterion | Test Method |
|---|-----------|-------------|
| V1 | OpenAI adapter streams text response token-by-token | Unit test: mock OpenAI SDK, verify AsyncGenerator yields text_delta events |
| V2 | Anthropic adapter streams text response token-by-token | Unit test: mock Anthropic SDK, verify AsyncGenerator yields text_delta events |
| V3 | OpenAI adapter accumulates tool_use chunks into complete JSON | Unit test: stream mock chunks with partial JSON, verify parsed tool_use_end event |
| V4 | Anthropic adapter accumulates tool_use chunks into complete JSON | Unit test: stream mock content_block_delta events, verify parsed tool_use_end event |
| V5 | Gateway selects correct adapter based on provider config | Unit test: verify adapter routing by provider type |
| V6 | System prompt included in all LLM requests | Unit test: verify system/system field present in API call params |
| V7 | IPC send/receive works between main and renderer | Integration test: send typed message via preload, verify receipt in main |
| V8 | IPC type validation catches malformed messages | Unit test: send invalid payload, verify Zod rejects it |
| V9 | Shared types compile without errors from both main and renderer | Build test: `npx tsc --noEmit` passes for all tsconfigs |
| V10 | electron-vite dev server starts without errors | Smoke test: `npm run dev` succeeds |

### Must-Haves (Goal-Backward Verification)

1. **LLM Gateway streams from OpenAI-compatible endpoint** — Given valid API key, tokens arrive incrementally
2. **LLM Gateway streams from Anthropic endpoint** — Given valid API key, tokens arrive incrementally
3. **System prompt in all requests** — Configurable system prompt passed to every LLM call
4. **IPC typed communication** — Main and Renderer exchange typed messages without runtime type errors
5. **Shared types importable everywhere** — TypeScript strict compilation passes from main, preload, and renderer

## Dependencies

### Phase 1 Required Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| electron | 41.1.1 | Desktop shell |
| electron-vite | 5.0.0 | Build tool |
| typescript | ~5.7.x | Language (TS 6.0 may not be stable yet, use latest 5.x) |
| react | 19.x | UI framework (renderer only) |
| openai | 6.x | OpenAI/DeepSeek SDK |
| @anthropic-ai/sdk | 0.82.x | Anthropic Claude SDK |
| zustand | 5.x | State management (renderer only) |
| zod | 3.x | Schema validation (shared) |
| vitest | latest | Testing |

### Note on TypeScript Version
CLAUDE.md lists TypeScript 6.0.2, but as of April 2026, TypeScript 5.8 is the latest stable. Use `typescript@^5.7.0` for stability with electron-vite compatibility.

## Sources

- Claude Code source: `E:\ai\claude-code\src\Tool.ts`, `E:\ai\claude-code\src\QueryEngine.ts`
- Existing research: `.planning/research/STACK.md`, `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`
- [OpenAI SDK streaming example](https://github.com/openai/openai-node)
- [Anthropic SDK streaming docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic SDK streaming.ts example](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/examples/streaming.ts)
- [electron-vite documentation](https://electron-vite.org/guide/dev)
- [@electron-toolkit/typed-ipc](https://github.com/alex8088/electron-toolkit/tree/master/packages/typed-ipc) for type-safe IPC

---

## RESEARCH COMPLETE
