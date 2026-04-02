# Architecture Research: wzxClaw AI Coding IDE

**Researched:** 2026-04-03
**Confidence:** HIGH (based on Claude Code source analysis + Cursor architecture patterns)

## System Overview

wzxClaw is a desktop AI coding IDE built on Electron. The architecture follows a **Main Process / Renderer Process** split with IPC communication, similar to Cursor and VS Code.

```
┌─────────────────────────────────────────────────────────┐
│                    Electron Main Process                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Agent Runtime │  │ Tool System  │  │ LLM Gateway   │ │
│  │ (conversation │  │ (Read/Write/ │  │ (OpenAI SDK + │ │
│  │  loop, context│  │  Edit/Bash/  │  │  Anthropic SDK│ │
│  │  management)  │  │  Grep/Glob)  │  │  multi-model) │ │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘ │
│         │                 │                   │         │
│         └────────────┬────┘───────────────────┘         │
│                      │ IPC (electron ipcMain/Renderer)  │
├──────────────────────┼──────────────────────────────────┤
│                    Renderer Process                      │
│  ┌──────────────┐  ┌┴─────────────┐  ┌───────────────┐ │
│  │ Monaco Editor │  │ Chat Panel   │  │ File Explorer │ │
│  │ (code editing)│  │ (AI convo UI)│  │ (tree view)   │ │
│  └──────────────┘  └──────────────┘  └───────────────┘ │
│                      │                                  │
│              ┌───────┴───────┐                          │
│              │  Zustand Store │                          │
│              │  (state mgmt) │                          │
│              └───────────────┘                          │
└─────────────────────────────────────────────────────────┘
```

## Component Architecture

### 1. Electron Main Process (Node.js context)

**Agent Runtime** — Core engine, inspired by Claude Code's `query.ts`:
- Conversation loop: User msg → LLM API → Parse response → Execute tools → Feed results back → Repeat
- Context management: Token counting, message truncation, conversation history
- Streaming: Receive SSE stream from LLM, forward chunks to renderer via IPC
- Abort handling: Cancel in-progress requests

**Tool System** — Inspired by Claude Code's `Tool.ts` + `tools/` directory:
- Each tool implements a common interface: `name`, `description`, `inputSchema`, `execute()`
- MVP tools: FileRead, FileWrite, FileEdit, Bash, Grep, Glob
- Tool results sent back to Agent Runtime for LLM consumption
- Permission model: configurable auto-approve / prompt / deny per tool

**LLM Gateway** — Multi-provider API adapter:
- OpenAI SDK for OpenAI/DeepSeek/compatible endpoints
- Anthropic SDK for Claude models
- Unified interface: `sendMessage(messages, options)` → AsyncIterable of chunks
- Handles: streaming, tool_use response parsing, error retry, token counting

### 2. Electron Renderer Process (Browser context)

**Monaco Editor** — Code editing:
- File tabs, syntax highlighting, multi-file editing
- Dirty state tracking, save triggers to main process

**Chat Panel** — AI conversation UI:
- Message list (user/assistant/tool-result)
- Streaming text display with markdown rendering
- Code blocks with "Apply" button
- Input area with file attachment support

**File Explorer** — Project tree:
- Directory tree view
- File open/create/delete/rename operations

**Zustand Store** — Shared state:
- Current conversation messages
- Active file/tab state
- LLM connection status
- Tool execution status

## Data Flow

### Conversation Loop (core value path)

```
1. User types message in Chat Panel
2. Renderer → IPC → Main: "user_message" { content, attachments }
3. Main Agent Runtime creates user message, appends to conversation
4. Main → LLM Gateway: send messages with tool definitions
5. LLM Gateway → LLM API: streaming request
6. For each chunk:
   a. If text: Main → IPC → Renderer: "stream_chunk" { content }
   b. If tool_use: Main → IPC → Renderer: "tool_start" { name, input }
   c. Execute tool in Main process
   d. Tool result appended to messages
   e. Main → IPC → Renderer: "tool_result" { output }
7. If more tool calls needed, go back to step 4
8. When done: Main → IPC → Renderer: "stream_end"
```

### File Operation Flow

```
1. LLM requests FileRead("/path/to/file")
2. Tool executes: fs.readFile in Main process
3. Result returned to Agent Runtime → fed back to LLM
4. LLM decides to FileEdit with changes
5. Tool executes: apply diff/patch to file
6. Main → IPC → Renderer: "file_changed" { path }
7. Renderer updates Monaco editor content
```

## IPC Channel Design

| Channel | Direction | Payload |
|---------|-----------|---------|
| `user:message` | Renderer→Main | `{ content, attachments }` |
| `stream:chunk` | Main→Renderer | `{ content }` |
| `stream:end` | Main→Renderer | `{}` |
| `stream:error` | Main→Renderer | `{ error }` |
| `tool:start` | Main→Renderer | `{ name, input }` |
| `tool:result` | Main→Renderer | `{ output, error }` |
| `file:open` | Renderer→Main | `{ path }` |
| `file:save` | Renderer→Main | `{ path, content }` |
| `file:changed` | Main→Renderer | `{ path, content }` |
| `conversation:clear` | Renderer→Main | `{}` |
| `settings:update` | Renderer→Main | `{ key, value }` |

## Module Structure (npm workspace or monorepo)

```
wzxClaw/
├── packages/
│   ├── agent-runtime/     # Core conversation loop + context management
│   ├── tool-system/       # Tool interface + implementations
│   ├── llm-gateway/       # Multi-provider LLM API adapter
│   ├── shared-types/      # Shared TypeScript types
│   └── ipc-protocol/      # IPC channel definitions
├── src/
│   ├── main/              # Electron main process entry
│   │   ├── index.ts
│   │   └── ipc-handlers.ts
│   └── renderer/          # Electron renderer (React)
│       ├── App.tsx
│       ├── components/
│       │   ├── ChatPanel/
│       │   ├── Editor/
│       │   └── FileExplorer/
│       └── store/
│           └── index.ts   # Zustand store
├── electron.vite.config.ts
├── package.json
└── tsconfig.json
```

## Build Order (Dependencies)

1. **shared-types** — No dependencies, defines all interfaces
2. **ipc-protocol** — Depends on shared-types
3. **llm-gateway** — Depends on shared-types, OpenAI SDK, Anthropic SDK
4. **tool-system** — Depends on shared-types
5. **agent-runtime** — Depends on llm-gateway, tool-system, shared-types
6. **Electron shell** — Depends on everything, ties it together

## Claude Code Runtime Patterns (from source analysis)

### Tool Interface Pattern (from Tool.ts)
Each tool implements a common interface with:
- `name`: string identifier
- `description`: human-readable description for LLM
- `inputSchema`: JSON Schema for tool parameters
- `execute()`: runs the tool, returns result
- Tool results are `{ type: 'tool_result', tool_use_id, content }` format

### Conversation Message Format (from types/message.ts)
Messages are typed union: UserMessage | AssistantMessage | ToolResultMessage | SystemMessage
- Each has role, content, timestamps
- Assistant messages can contain mixed content blocks (text + tool_use)
- Tool results reference the tool_use_id from assistant message

### Agent Loop Pattern (from query.ts)
1. Build system prompt with tool definitions
2. Send messages array to LLM API
3. Parse streaming response for content blocks
4. If tool_use blocks: execute tools, append results, loop back to step 2
5. If only text: conversation turn complete
6. Context compaction when approaching token limits

### Context Management (from context/)
- Token budget tracking per conversation
- Auto-compaction when threshold approached
- System prompt construction with tool definitions
