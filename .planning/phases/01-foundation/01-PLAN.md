---
plan: 01
phase: 01
wave: 1
depends_on: []
status: pending
requirements_addressed: [ELEC-02]
files_modified:
  - package.json
  - electron.vite.config.ts
  - tsconfig.json
  - tsconfig.node.json
  - tsconfig.web.json
  - src/shared/types.ts
  - src/shared/ipc-channels.ts
  - src/shared/constants.ts
  - src/main/index.ts
  - src/preload/index.ts
  - src/renderer/App.tsx
  - src/renderer/main.tsx
  - src/renderer/index.html
  - vitest.config.ts
  - src/shared/__tests__/types.test.ts
  - src/shared/__tests__/ipc-channels.test.ts
autonomous: true

must_haves:
  truths:
    - "electron-vite dev server starts without errors and opens an Electron window"
    - "Shared TypeScript types compile without errors and are importable from main, preload, and renderer"
    - "IPC channel names and payload type maps are defined and type-safe"
    - "vitest can run tests in the shared/ directory"
  artifacts:
    - path: "package.json"
      provides: "All Phase 1 dependencies installed"
      contains: "\"openai\""
    - path: "src/shared/types.ts"
      provides: "Message, StreamEvent, Tool, Conversation, LLMConfig types"
      exports: ["Message", "StreamEvent", "ToolCall", "ToolResult", "Conversation", "LLMConfig", "TokenUsage", "UserMessage", "AssistantMessage", "ToolResultMessage"]
    - path: "src/shared/ipc-channels.ts"
      provides: "IPC channel name constants and payload type map"
      exports: ["IPC_CHANNELS", "IpcChannelMap"]
    - path: "src/shared/constants.ts"
      provides: "Shared constants (default model list, max tokens, etc.)"
      contains: "DEFAULT_MODELS"
    - path: "vitest.config.ts"
      provides: "Vitest configuration for the project"
      contains: "vitest"
  key_links:
    - from: "src/main/index.ts"
      to: "src/shared/types.ts"
      via: "import"
      pattern: "from ['\"].*shared/types"
    - from: "src/renderer/App.tsx"
      to: "src/shared/types.ts"
      via: "import"
      pattern: "from ['\"].*shared/types"
    - from: "src/preload/index.ts"
      to: "src/shared/ipc-channels.ts"
      via: "import"
      pattern: "from ['\"].*shared/ipc-channels"
---

<objective>
Bootstrap the electron-vite project with React + TypeScript, install all Phase 1 dependencies, and create the shared type system that all subsequent plans depend on.

Purpose: Establishes the project skeleton and type contracts. Plans 02 and 03 import types from src/shared/ -- this plan must deliver those contracts before implementation begins.
Output: A running electron-vite dev server with empty shell, all dependencies installed, and shared types importable from all three process targets (main, preload, renderer).
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/01-foundation/01-CONTEXT.md
@.planning/phases/01-foundation/01-RESEARCH.md
@.planning/phases/01-foundation/01-VALIDATION.md
</context>

<tasks>

<task type="auto">
  <id>01-01-01</id>
  <title>Bootstrap electron-vite project and install dependencies</title>
  <read_first>
    - .planning/phases/01-foundation/01-RESEARCH.md (dependency versions)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-18 monorepo, D-19 electron-vite, D-20 TypeScript strict)
  </read_first>
  <action>
    1. Create the wzxClaw project at E:\ai\wzxClaw using electron-vite scaffold:
       ```
       cd E:/ai/wzxClaw
       npm create @quick-start/electron@latest . -- --template react-ts
       ```
       If the directory is not empty (has .planning/, CLAUDE.md), use `--force` or manually create the files. The scaffold MUST produce:
       - `electron.vite.config.ts` at project root
       - `src/main/index.ts` - Electron main process entry
       - `src/preload/index.ts` - Preload script
       - `src/renderer/src/main.tsx` - React entry
       - `src/renderer/index.html` - HTML shell
       - `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`

    2. Restructure renderer to flat layout. electron-vite scaffold creates `src/renderer/src/`. Move files so renderer source is at:
       - `src/renderer/main.tsx` (not src/renderer/src/main.tsx)
       - `src/renderer/App.tsx` (not src/renderer/src/App.tsx)
       - `src/renderer/index.html` (keep at this location)
       Update `electron.vite.config.ts` renderer entry to point to `src/renderer/main.tsx`.

    3. Install all Phase 1 dependencies:
       ```
       npm install openai@^6.0.0 @anthropic-ai/sdk@^0.82.0 zustand@^5.0.0 zod@^3.23.0 uuid@^13.0.0 dotenv@^17.0.0
       npm install -D vitest@^3.0.0 @types/uuid@^10.0.0
       ```
       Note: electron, electron-vite, react, typescript come with the scaffold.

    4. Verify TypeScript strict mode. In `tsconfig.json` (and tsconfig.node.json, tsconfig.web.json as needed), ensure:
       ```json
       "strict": true
       ```

    5. Create directory structure for shared types:
       ```
       mkdir -p src/shared/__tests__
       mkdir -p src/main/llm/__tests__
       mkdir -p src/preload/__tests__
       ```

    6. Add vitest script to package.json:
       ```json
       "test": "vitest run",
       "test:watch": "vitest"
       ```

    7. Create minimal `vitest.config.ts` at project root:
       ```typescript
       import { defineConfig } from 'vitest/config'
       import path from 'path'

       export default defineConfig({
         resolve: {
           alias: {
             '@shared': path.resolve(__dirname, 'src/shared'),
           },
         },
         test: {
           globals: true,
           environment: 'node',
           include: ['src/**/*.test.ts'],
         },
       })
       ```
  </action>
  <acceptance_criteria>
    - `package.json` contains dependencies: "openai", "@anthropic-ai/sdk", "zustand", "zod", "uuid", "dotenv"
    - `package.json` contains devDependencies: "vitest"
    - `package.json` has scripts: "dev", "build", "test"
    - `electron.vite.config.ts` exists at project root
    - `tsconfig.json` contains `"strict": true`
    - `src/main/index.ts` exists
    - `src/preload/index.ts` exists
    - `src/renderer/main.tsx` exists
    - `src/renderer/index.html` exists
    - `vitest.config.ts` exists at project root
    - `npm run dev` exits without TypeScript compilation errors (may fail on Electron binary download, that is acceptable -- TypeScript compilation must succeed)
    - Directories exist: src/shared/, src/main/llm/, src/shared/__tests__/
  </acceptance_criteria>
  <automated>npx tsc --noEmit 2>&1 | head -5 && echo "TypeScript compilation check done"</automated>
</task>

<task type="auto">
  <id>01-01-02</id>
  <title>Create shared type definitions</title>
  <read_first>
    - .planning/phases/01-foundation/01-RESEARCH.md (Pattern 1: StreamEvent type, Pattern 4: IPC channels)
    - .planning/phases/01-foundation/01-CONTEXT.md (D-04 unified message format, D-06 AsyncGenerator chunks, D-07 tool call accumulation, D-10 all IPC types in shared)
    - .planning/research/ARCHITECTURE.md (Message type union pattern, Tool interface, IPC channel namespace convention)
  </read_first>
  <action>
    Create the following files with EXACT type definitions. These are the contracts that Plans 02 and 03 implement against.

    **File: `src/shared/types.ts`**

    ```typescript
    import { z } from 'zod'

    // ============================================================
    // Message Types
    // ============================================================

    export interface UserMessage {
      role: 'user'
      content: string
      timestamp: number
    }

    export interface AssistantMessage {
      role: 'assistant'
      content: string
      toolCalls: ToolCall[]
      timestamp: number
    }

    export interface ToolResultMessage {
      role: 'tool_result'
      toolCallId: string
      content: string
      isError: boolean
      timestamp: number
    }

    export type Message = UserMessage | AssistantMessage | ToolResultMessage

    // ============================================================
    // Tool Types
    // ============================================================

    export interface ToolCall {
      id: string
      name: string
      input: Record<string, unknown>
    }

    export interface ToolResult {
      toolCallId: string
      output: string
      isError: boolean
    }

    export interface ToolDefinition {
      name: string
      description: string
      inputSchema: Record<string, unknown>  // JSON Schema object
    }

    // ============================================================
    // LLM Stream Events (per D-06)
    // ============================================================

    export interface TextDeltaEvent {
      type: 'text_delta'
      content: string
    }

    export interface ToolUseStartEvent {
      type: 'tool_use_start'
      id: string
      name: string
    }

    export interface ToolUseDeltaEvent {
      type: 'tool_use_delta'
      id: string
      partialJson: string
    }

    export interface ToolUseEndEvent {
      type: 'tool_use_end'
      id: string
      parsedInput: Record<string, unknown>
    }

    export interface StreamErrorEvent {
      type: 'error'
      error: string
    }

    export interface TokenUsage {
      inputTokens: number
      outputTokens: number
    }

    export interface StreamDoneEvent {
      type: 'done'
      usage: TokenUsage
    }

    export type StreamEvent =
      | TextDeltaEvent
      | ToolUseStartEvent
      | ToolUseDeltaEvent
      | ToolUseEndEvent
      | StreamErrorEvent
      | StreamDoneEvent

    // ============================================================
    // Conversation
    // ============================================================

    export interface Conversation {
      id: string
      title: string
      messages: Message[]
      createdAt: number
      updatedAt: number
    }

    // ============================================================
    // LLM Configuration (per D-15, D-16)
    // ============================================================

    export type LLMProvider = 'openai' | 'anthropic'

    export interface LLMConfig {
      provider: LLMProvider
      model: string
      apiKey: string           // Never sent to renderer (per D-14)
      baseURL?: string         // Custom endpoint (per D-16)
      systemPrompt?: string    // Per D-06 system prompt support
      maxTokens?: number       // Anthropic requires this
    }

    // ============================================================
    // Zod Schemas for IPC Validation
    // ============================================================

    export const UserMessageSchema = z.object({
      role: z.literal('user'),
      content: z.string().min(1),
      timestamp: z.number(),
    })

    export const TokenUsageSchema = z.object({
      inputTokens: z.number(),
      outputTokens: z.number(),
    })

    export const StreamEventSchema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('text_delta'), content: z.string() }),
      z.object({ type: z.literal('tool_use_start'), id: z.string(), name: z.string() }),
      z.object({ type: z.literal('tool_use_delta'), id: z.string(), partialJson: z.string() }),
      z.object({ type: z.literal('tool_use_end'), id: z.string(), parsedInput: z.record(z.unknown()) }),
      z.object({ type: z.literal('error'), error: z.string() }),
      z.object({ type: z.literal('done'), usage: TokenUsageSchema }),
    ])
    ```

    **File: `src/shared/ipc-channels.ts`**

    ```typescript
    import { z } from 'zod'
    import { UserMessageSchema, TokenUsageSchema } from './types'

    // ============================================================
    // IPC Channel Name Constants (per D-08, D-10, Pattern 4)
    // ============================================================

    export const IPC_CHANNELS = {
      // Agent channels (renderer -> main)
      'agent:send_message': 'agent:send_message',
      'agent:stop': 'agent:stop',

      // Stream channels (main -> renderer, fire-and-forget via webContents.send)
      'stream:text_delta': 'stream:text_delta',
      'stream:tool_use_start': 'stream:tool_use_start',
      'stream:tool_use_delta': 'stream:tool_use_delta',
      'stream:tool_use_end': 'stream:tool_use_end',
      'stream:error': 'stream:error',
      'stream:done': 'stream:done',

      // Settings channels (renderer -> main)
      'settings:get': 'settings:get',
      'settings:update': 'settings:update',
    } as const

    export type IpcChannelName = keyof typeof IPC_CHANNELS

    // ============================================================
    // Payload Type Maps (per D-10)
    // ============================================================

    // Request payloads (renderer sends to main via ipcRenderer.invoke)
    export interface IpcRequestPayloads {
      'agent:send_message': {
        conversationId: string
        content: string
      }
      'agent:stop': void
      'settings:get': void
      'settings:update': {
        provider?: string
        model?: string
        apiKey?: string
        baseURL?: string
        systemPrompt?: string
      }
    }

    // Response payloads (main returns to renderer via ipcMain.handle return)
    export interface IpcResponsePayloads {
      'agent:send_message': void
      'agent:stop': void
      'settings:get': {
        provider: string
        model: string
        hasApiKey: boolean
        baseURL?: string
        systemPrompt?: string
      }
      'settings:update': void
    }

    // Stream payloads (main sends to renderer via webContents.send)
    export interface IpcStreamPayloads {
      'stream:text_delta': { content: string }
      'stream:tool_use_start': { id: string; name: string }
      'stream:tool_use_delta': { id: string; partialJson: string }
      'stream:tool_use_end': { id: string; parsedInput: Record<string, unknown> }
      'stream:error': { error: string }
      'stream:done': { usage: { inputTokens: number; outputTokens: number } }
    }

    // ============================================================
    // Zod Schemas for IPC Validation (per D-09)
    // ============================================================

    export const IpcSchemas = {
      'agent:send_message': {
        request: z.object({
          conversationId: z.string(),
          content: z.string().min(1),
        }),
        response: z.undefined(),
      },
      'stream:text_delta': z.object({ content: z.string() }),
      'stream:tool_use_start': z.object({ id: z.string(), name: z.string() }),
      'stream:tool_use_end': z.object({ id: z.string(), parsedInput: z.record(z.unknown()) }),
      'stream:done': z.object({ usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }) }),
    } as const
    ```

    **File: `src/shared/constants.ts`**

    ```typescript
    // ============================================================
    // Default Model List (per D-15)
    // ============================================================

    export interface ModelPreset {
      id: string
      name: string
      provider: 'openai' | 'anthropic'
      maxTokens: number
    }

    export const DEFAULT_MODELS: ModelPreset[] = [
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', maxTokens: 16384 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', maxTokens: 16384 },
      { id: 'deepseek-chat', name: 'DeepSeek-V3', provider: 'openai', maxTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1', provider: 'openai', maxTokens: 8192 },
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'anthropic', maxTokens: 8192 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', provider: 'anthropic', maxTokens: 8192 },
    ]

    // ============================================================
    // Default Configuration
    // ============================================================

    export const DEFAULT_MAX_TOKENS = 8192
    export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful AI coding assistant.'
    export const MAX_TOOL_RESULT_CHARS = 30000
    export const MAX_FILE_READ_LINES = 2000
    export const MAX_AGENT_TURNS = 25

    // OpenAI-compatible endpoints
    export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
    export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
    ```

    **File: `src/shared/__tests__/types.test.ts`**

    ```typescript
    import { describe, it, expect } from 'vitest'
    import {
      UserMessageSchema,
      TokenUsageSchema,
      StreamEventSchema,
      type StreamEvent,
      type Message,
    } from '../types'

    describe('UserMessageSchema', () => {
      it('accepts valid user message', () => {
        const result = UserMessageSchema.safeParse({
          role: 'user',
          content: 'Hello',
          timestamp: Date.now(),
        })
        expect(result.success).toBe(true)
      })

      it('rejects empty content', () => {
        const result = UserMessageSchema.safeParse({
          role: 'user',
          content: '',
          timestamp: Date.now(),
        })
        expect(result.success).toBe(false)
      })

      it('rejects wrong role', () => {
        const result = UserMessageSchema.safeParse({
          role: 'assistant',
          content: 'Hello',
          timestamp: Date.now(),
        })
        expect(result.success).toBe(false)
      })
    })

    describe('StreamEventSchema', () => {
      it('validates text_delta event', () => {
        const result = StreamEventSchema.safeParse({
          type: 'text_delta',
          content: 'hello',
        })
        expect(result.success).toBe(true)
      })

      it('validates tool_use_end event', () => {
        const result = StreamEventSchema.safeParse({
          type: 'tool_use_end',
          id: 'call_123',
          parsedInput: { file_path: '/foo.ts' },
        })
        expect(result.success).toBe(true)
      })

      it('validates done event', () => {
        const result = StreamEventSchema.safeParse({
          type: 'done',
          usage: { inputTokens: 100, outputTokens: 50 },
        })
        expect(result.success).toBe(true)
      })

      it('rejects unknown event type', () => {
        const result = StreamEventSchema.safeParse({
          type: 'unknown',
          data: 'hello',
        })
        expect(result.success).toBe(false)
      })
    })

    describe('TypeScript type narrowing', () => {
      it('Message union type compiles correctly', () => {
        const userMsg: Message = {
          role: 'user',
          content: 'test',
          timestamp: Date.now(),
        }
        expect(userMsg.role).toBe('user')

        const toolResult: Message = {
          role: 'tool_result',
          toolCallId: 'call_1',
          content: 'result',
          isError: false,
          timestamp: Date.now(),
        }
        expect(toolResult.role).toBe('tool_result')
      })

      it('StreamEvent union type narrows correctly', () => {
        const event: StreamEvent = {
          type: 'text_delta',
          content: 'hello',
        }
        if (event.type === 'text_delta') {
          expect(event.content).toBe('hello')
        }
      })
    })
    ```

    **File: `src/shared/__tests__/ipc-channels.test.ts`**

    ```typescript
    import { describe, it, expect } from 'vitest'
    import { IPC_CHANNELS, IpcSchemas } from '../ipc-channels'

    describe('IPC_CHANNELS', () => {
      it('has all required channel names', () => {
        expect(IPC_CHANNELS['agent:send_message']).toBe('agent:send_message')
        expect(IPC_CHANNELS['agent:stop']).toBe('agent:stop')
        expect(IPC_CHANNELS['stream:text_delta']).toBe('stream:text_delta')
        expect(IPC_CHANNELS['stream:done']).toBe('stream:done')
        expect(IPC_CHANNELS['settings:get']).toBe('settings:get')
        expect(IPC_CHANNELS['settings:update']).toBe('settings:update')
      })

      it('all channel names are const (readonly)', () => {
        // Type-level check: values should be string literals, not string
        const channel: 'agent:send_message' = IPC_CHANNELS['agent:send_message']
        expect(channel).toBe('agent:send_message')
      })
    })

    describe('IpcSchemas', () => {
      it('validates send_message request', () => {
        const result = IpcSchemas['agent:send_message'].request.safeParse({
          conversationId: 'conv-123',
          content: 'Hello agent',
        })
        expect(result.success).toBe(true)
      })

      it('rejects send_message with empty content', () => {
        const result = IpcSchemas['agent:send_message'].request.safeParse({
          conversationId: 'conv-123',
          content: '',
        })
        expect(result.success).toBe(false)
      })

      it('validates stream:text_delta payload', () => {
        const result = IpcSchemas['stream:text_delta'].safeParse({
          content: 'hello token',
        })
        expect(result.success).toBe(true)
      })
    })
    ```

    **Update main process entry: `src/main/index.ts`**

    Replace scaffold contents with a minimal Electron main process that can import shared types:
    ```typescript
    import { app, BrowserWindow } from 'electron'
    import { join } from 'path'
    import { electronApp, optimizer, is } from '@electron-toolkit/utils'

    function createWindow(): BrowserWindow {
      const mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          sandbox: false,
        },
      })

      if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
      } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
      }

      return mainWindow
    }

    app.whenReady().then(() => {
      electronApp.setAppUserModelId('com.wzxclaw')
      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })
      createWindow()
      app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit()
      }
    })
    ```

    **Update preload: `src/preload/index.ts`**

    Minimal preload that can import shared types:
    ```typescript
    import { contextBridge, ipcRenderer } from 'electron'
    import { api } from '@electron-toolkit/preload'

    // Phase 1: Minimal preload. Plan 03 adds typed IPC.
    const electronAPI = api

    // Expose minimal API for testing
    contextBridge.exposeInMainWorld('electron', electronAPI)
    ```

    **Update renderer: `src/renderer/App.tsx`**

    ```typescript
    import type { Message } from '../../shared/types'

    function App(): JSX.Element {
      // Phase 1: Minimal shell. Verify shared types are importable.
      const _message: Message = {
        role: 'user',
        content: 'wzxClaw initialized',
        timestamp: Date.now(),
      }

      return (
        <div style={{ padding: 20, fontFamily: 'sans-serif' }}>
          <h1>wzxClaw</h1>
          <p>AI Coding IDE - Phase 1 Foundation</p>
        </div>
      )
    }

    export default App
    ```

    **Update renderer entry: `src/renderer/main.tsx`**

    ```typescript
    import React from 'react'
    import ReactDOM from 'react-dom/client'
    import App from './App'

    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    )
    ```
  </action>
  <acceptance_criteria>
    - `src/shared/types.ts` exports: UserMessage, AssistantMessage, ToolResultMessage, Message, ToolCall, ToolResult, ToolDefinition, TextDeltaEvent, ToolUseStartEvent, ToolUseDeltaEvent, ToolUseEndEvent, StreamErrorEvent, StreamDoneEvent, StreamEvent, TokenUsage, Conversation, LLMConfig, LLMProvider, UserMessageSchema, TokenUsageSchema, StreamEventSchema
    - `src/shared/ipc-channels.ts` exports: IPC_CHANNELS, IpcChannelName, IpcRequestPayloads, IpcResponsePayloads, IpcStreamPayloads, IpcSchemas
    - `src/shared/constants.ts` exports: ModelPreset, DEFAULT_MODELS, DEFAULT_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT, MAX_TOOL_RESULT_CHARS, MAX_FILE_READ_LINES, MAX_AGENT_TURNS, OPENAI_BASE_URL, DEEPSEEK_BASE_URL
    - `npx vitest run src/shared/__tests__/types.test.ts` passes all tests
    - `npx vitest run src/shared/__tests__/ipc-channels.test.ts` passes all tests
    - `npx tsc --noEmit` passes with zero errors (shared types compile from all tsconfigs)
    - `src/main/index.ts` can import from `../../shared/types` without error
    - `src/renderer/App.tsx` can import from `../../shared/types` without error
  </acceptance_criteria>
  <automated>npx vitest run src/shared/__tests__/</automated>
</task>

</tasks>

<verification>
1. All shared type tests pass: `npx vitest run src/shared/__tests__/`
2. TypeScript compilation succeeds: `npx tsc --noEmit`
3. electron-vite build succeeds: `npx electron-vite build`
</verification>

<success_criteria>
- electron-vite project scaffolded with React + TypeScript
- All Phase 1 npm dependencies installed (openai, @anthropic-ai/sdk, zustand, zod, uuid, dotenv, vitest)
- Shared types compile and are importable from main, preload, and renderer
- StreamEvent union type with discriminated union on `type` field
- IPC channel constants with Zod schemas for validation
- Default model list with 6 presets (OpenAI, DeepSeek, Anthropic)
- vitest tests pass for shared types and IPC channels
- TypeScript strict mode enabled
</success_criteria>

<output>
After completion, create `.planning/phases/01-foundation/01-SUMMARY.md`
</output>
