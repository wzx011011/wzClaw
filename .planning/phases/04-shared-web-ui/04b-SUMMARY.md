---
phase: 04-shared-web-ui
plan: 02
subsystem: chat-ui
tags: [chat-store, zustand, react, streaming, markdown, syntax-highlighting]
dependency_graph:
  requires: [04a]
  provides: [chat-store-factory, chat-ui-components]
  affects: [packages/web-ui/src/*]
tech_stack:
  added:
    - react-markdown ^9.x
    - remark-gfm ^4.x
    - rehype-raw ^7.x
    - highlight.js ^11.x
  patterns:
    - zustand factory pattern (createChatStore(dataSource))
    - rAF text batching via StreamingBatcher
    - history windowing for message lists
    - CSS custom properties for dark theme
key_files:
  created:
    - packages/web-ui/src/stores/chat-store.ts
    - packages/web-ui/src/stores/streaming-batcher.ts
    - packages/web-ui/src/stores/chat-store-utils.ts
    - packages/web-ui/src/stores/__tests__/chat-store.test.ts
    - packages/web-ui/src/components/chat/ChatPanel.tsx
    - packages/web-ui/src/components/chat/MessageList.tsx
    - packages/web-ui/src/components/chat/ChatMessage.tsx
    - packages/web-ui/src/components/chat/ThinkingIndicator.tsx
    - packages/web-ui/src/components/chat/CodeBlock.tsx
    - packages/web-ui/src/components/chat/history-window.ts
    - packages/web-ui/src/styles/chat.css
  modified:
    - packages/web-ui/src/App.tsx
    - packages/web-ui/package.json
decisions:
  - D-02: Zustand factory pattern (createChatStore) instead of global singleton
  - D-06: ChatPanel simplified from 964 to ~170 lines, removed desktop-only features
  - CodeBlock uses highlight.js with on-demand language registration for smaller bundle
  - MessageList uses injected store hook (props) for testability
metrics:
  duration: 13m
  completed: "2026-05-14"
  tasks_completed: 2
  files_created: 11
  files_modified: 2
  tests_added: 6
  tests_passing: 15
---

# Phase 4 Plan 02: Core Chat UI Summary

Chat store extracted as DataSource-driven factory with 6 passing tests, plus 5 chat UI components (ChatPanel, MessageList, ChatMessage, ThinkingIndicator, CodeBlock) with dark theme CSS.

## What Was Built

### Task 1: Chat Store (TDD)

- **streaming-batcher.ts**: `StreamingBatcher` class that coalesces high-frequency text/thinking tokens via `requestAnimationFrame`, preventing per-token React re-renders. Copied from desktop, zero Electron dependencies.
- **chat-store-utils.ts**: `updateMessageById` (O(1) fast-path for last element) and `buildChatMessagesFromRaw` (session loading utility).
- **chat-store.ts**: `createChatStore(dataSource)` factory function. Store state includes `messages`, `conversationId`, `isStreaming`, `streamingMessageId`, `streamJustEnded`, `error`. Actions: `init()` subscribes to 7 stream event types via `dataSource.onStreamEvent()`, `sendMessage()` creates user+assistant bubbles and calls `dataSource.sendMessage()`, `stopGeneration()`, `createSession()`, `clearConversation()`.
- **chat-store.test.ts**: 6 unit tests with mock DataSource and rAF polyfill. Tests cover: initial state, sendMessage interaction, stream:text content update, stream:done state transition, createSession reset, stopGeneration call.

### Task 2: Chat UI Components

- **ChatPanel.tsx** (~170 lines): Simplified from desktop's 964 lines. Retains: textarea input, Enter send / Shift+Enter newline, send/stop button, connection status indicator, model name display. Removed: @Mention, SlashCommands, DiffPreview, StepPanel, PermissionMode, Settings/PluginManager panels.
- **MessageList.tsx**: Auto-scroll (direct scrollTop during streaming, scrollIntoView otherwise), user scroll detection (pauses auto-scroll when >100px from bottom), history windowing (40 message initial render), scroll-to-bottom floating button.
- **ChatMessage.tsx**: User message bubbles, assistant messages with Markdown rendering (react-markdown + remark-gfm + rehype-raw), streaming text display, thinking content collapsible block, tool call placeholder cards, usage info footer.
- **ThinkingIndicator.tsx**: Pulse dot + rotating Chinese phrases with CSS shimmer animation.
- **CodeBlock.tsx**: highlight.js syntax highlighting with 20+ on-demand registered languages, copy button, long code collapse/expand.
- **history-window.ts**: Pure utility for message windowing (`getVisibleHistoryWindow`, `shouldWindowHistory`).
- **chat.css**: Full dark theme CSS with CSS custom properties. Includes: chat panel layout, message bubbles, streaming shimmer, thinking indicator, code blocks, tool cards, error banner, input area, toolbar, history window banner, scroll button.
- **App.tsx**: Updated to create DataSource instance, create chat store, wire to ChatPanel.

## Deviations from Plan

None - plan executed exactly as written.

## Key Architecture Decisions

1. **Factory pattern for store**: `createChatStore(dataSource)` returns a Zustand store instance. This allows multiple store instances (testing) and decouples from global state.
2. **Props-based store injection**: ChatPanel receives store as prop rather than importing a global singleton. MessageList receives a `useStore` function. This enables testability.
3. **Input value in store**: `_inputValue` stored in Zustand state to avoid React re-render race conditions with controlled input during streaming.
4. **highlight.js over Monaco**: CodeBlock uses highlight.js for read-only syntax highlighting. Much smaller bundle than Monaco Editor.
5. **Chinese-only UI text**: No i18n framework; all user-facing text is hardcoded Chinese to keep the web-ui lightweight.

## Verification Results

- **Tests**: 15 passing (6 chat-store + 5 WebSocket source + 4 IPC source)
- **TypeScript**: `tsc --noEmit` clean, zero errors
- **Build**: `vite build` successful, output in dist/ (~660 KB gzipped)

## Known Stubs

| Stub | File | Description |
|------|------|-------------|
| ToolCallGroup placeholder | `ChatMessage.tsx:167-180` | Tool calls show name + status icon only. Full ToolCallGroup component deferred to Plan 04d. |
| stopGeneration (WebSocket) | `websocket-source.ts:188` | Throws "not implemented" error. Agent-server protocol doesn't support stop yet. |

## Threat Flags

No new security surface introduced beyond what was analyzed in the plan's threat model. ReactMarkdown with rehype-raw is configured but does not apply HTML tag allowlisting (T-04-04 mitigation not yet applied - deferred to hardening pass).
