# Technology Stack

**Project:** wzxClaw -- Cursor-like AI Coding IDE
**Researched:** 2026-04-03
**Approach:** Reference Claude Code architecture, rewrite runtime. Not a VS Code fork. Electron shell with embedded Monaco Editor and AI Agent Runtime.

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Electron | 41.1.1 | Desktop application shell | Industry standard for VS Code-class desktop apps. Cursor, Windsurf, and Void all use Electron. Provides Chromium renderer + Node.js main process out of the box. Version 41+ ships with Chromium 134 and Node 22.x. | HIGH |
| TypeScript | 6.0.2 | Primary language | VS Code and Cursor are entirely TypeScript. Claude Code is also TypeScript. TS 6.0 adds further performance improvements. Using the same language as reference codebases is non-negotiable for code portability. | HIGH |
| React | 19.2.4 | UI framework for Chat Panel and workbench | React 19 ships with Server Components and improved concurrent features. Cursor uses React for its sidebar. Most VS Code extension UI patterns and component libraries target React. | HIGH |
| Monaco Editor | 0.55.1 | Code editor core | This IS the VS Code editor. Same `vscode/vs/editor` codebase packaged standalone. Provides syntax highlighting, IntelliSense API, multi-cursor, diff view, and 100+ language support. No alternative comes close. | HIGH |
| @monaco-editor/react | 4.7.0 | React wrapper for Monaco | Clean hook-based API (`useMonaco`) for integrating Monaco into React components. Handles lifecycle, Web Worker setup, and theme management. | HIGH |

### State Management

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Zustand | 5.0.12 | Application state management | Minimal boilerplate, hook-based API, no context providers needed. Perfect for Electron where React context can cause re-render overhead across the main window. Zustand v5 adds `persist` middleware built-in and improved TypeScript inference. Cursor uses a similar lightweight approach. | HIGH |

### LLM Integration

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| openai (npm SDK) | 6.33.0 | OpenAI-compatible LLM API client | Single SDK covers OpenAI, DeepSeek, and any OpenAI-compatible endpoint (just change baseURL). SDK v6 has native streaming via `for await` loops, structured outputs, and tool/function calling built in. DeepSeek's API is fully OpenAI-compatible -- same SDK, change base URL to `https://api.deepseek.com`. | HIGH |
| @anthropic-ai/sdk | 0.82.0 | Anthropic Claude API client | Official Anthropic SDK. Required because Claude's API has different message format (content blocks, tool_use/tool_result) than OpenAI's. Native streaming, tool use, and prompt caching support. Cannot use the OpenAI SDK for Anthropic -- the API schemas are fundamentally different. | HIGH |

### Build Toolchain

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| electron-vite | 5.0.0 | Build tool and dev server | Purpose-built for Electron apps. Combines Vite's fast HMR with Electron's multi-process architecture (main, preload, renderer). Handles TypeScript compilation, CSS modules, and asset bundling without manual webpack config. v5.0 requires Node.js 20.19+. Replaces the nightmare of manual Electron+Vite+TypeScript configuration. | HIGH |
| esbuild | 0.27.7 | Bundler (used by electron-vite internally) | Fastest JavaScript/TypeScript bundler. electron-vite uses it under the hood. No direct configuration needed but understanding it helps with custom build steps. | MEDIUM |
| electron-builder | 26.8.1 | Packaging and distribution | Standard tool for packaging Electron apps as Windows installers (.exe, .msi), macOS (.dmg), and Linux (.AppImage). Handles code signing, auto-update, and asset bundling. | HIGH |

### File System and Project Management

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| chokidar | 5.0.0 | File system watcher | Standard Node.js file watcher used by every major JS tool (VS Code, webpack, Vite). v4+ simplified internals with fewer dependencies and better performance. Essential for watching project files for changes to feed into Agent context. | HIGH |

### Supporting Libraries

| Technology | Version | Purpose | When to Use | Confidence |
|------------|---------|---------|-------------|------------|
| uuid | 13.0.0 | Unique ID generation | Generating conversation IDs, message IDs, tool call IDs. Required for correlating streaming responses with their requests. | HIGH |
| dotenv | 17.4.0 | Environment variable loading | Loading API keys from `.env` files during development. Electron main process can read these at startup. | MEDIUM |

### Dev Dependencies

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| @types/node | latest | Node.js type definitions | Required for TypeScript compilation of Electron main process code. | HIGH |
| @types/react | latest | React type definitions | Required for TypeScript compilation of renderer code. | HIGH |
| eslint + @typescript-eslint/parser | latest | Linting | Standard for TypeScript projects. Catches bugs before runtime. | HIGH |
| prettier | latest | Code formatting | Consistent code style across the codebase. | HIGH |
| vitest | latest | Unit testing | Vite-native test runner. Fast, supports TypeScript out of the box, compatible with jest assertions. | HIGH |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Desktop Framework | Electron 41 | Tauri | Tauri uses Rust + system webview, not Chromium. Cannot embed Monaco Editor reliably (Monaco requires Chromium-specific APIs). VS Code ecosystem is entirely Electron. Breaking from Electron means no VS Code extension compatibility, ever. |
| UI Framework | React 19 | Vue 3 / Svelte | VS Code's workbench API and Cursor's UI patterns are React-based. Component ecosystem for IDE-like UIs (resizable panels, command palette, tree views) is richer in React. |
| State Management | Zustand 5 | Redux Toolkit / Jotai / MobX | Redux is over-engineered for this scope -- wzxClaw is not a CRUD app with complex normalized data. Jotai is atom-based which gets messy with inter-dependent state (agent loop has deeply coupled state: messages, tools, streaming status). MobX requires class decorators and observable wrapping. Zustand gives simple store-with-hooks pattern that maps well to Agent state. |
| Build Tool | electron-vite | webpack / manual Vite config | webpack is the legacy approach -- slow, complex config. Manual Vite + Electron setup requires fighting with preload scripts, context isolation, and CSP headers. electron-vite solves all of this out of the box. |
| Monaco Wrapper | @monaco-editor/react | monaco-editor-core (raw) | Raw Monaco requires manual Web Worker configuration, lifecycle management, and React integration. The React wrapper handles all of this with a clean API. Can always access the raw Monaco API through the wrapper when needed. |
| LLM SDK (non-Anthropic) | openai SDK | langchain.js / custom fetch | Langchain adds enormous dependency weight and abstracts away streaming control that an Agent loop needs direct access to. Custom fetch means reimplementing SSE parsing, retry logic, and type safety. The official OpenAI SDK gives streaming, tool calling, and type safety with zero abstraction tax. |
| File Watcher | chokidar 5 | Node.js fs.watch | Node's built-in `fs.watch` is unreliable (duplicate events, missing events on some OS, no recursive watching on Linux). chokidar is battle-tested across millions of installs. |
| Testing | vitest | jest | jest requires complex configuration for ESM + TypeScript. vitest is native to Vite (which electron-vite uses), zero-config TypeScript, and faster. |

## Architecture Notes

### Multi-Process Model

Electron enforces a multi-process architecture that maps directly to wzxClaw's needs:

```
Main Process (Node.js)
  - Electron window management
  - File system operations (Agent Tool System)
  - LLM API calls (network access)
  - chokidar file watchers
  - Native OS integration

Preload Scripts (Isolated)
  - contextBridge API exposure
  - IPC type-safe bridge between Main and Renderer

Renderer Process (Chromium + React)
  - Monaco Editor instance
  - Chat Panel UI (React)
  - Zustand stores (UI state)
  - User interaction handling
```

The Agent Loop runs in the **Main Process** because it needs file system access and network access. The Chat Panel renders in the **Renderer Process** and receives streaming updates via IPC.

### LLM Strategy

Two SDKs, one abstraction layer:

```
wzxClaw LLM Adapter
  |
  +-- OpenAI SDK --> OpenAI, DeepSeek, any OpenAI-compatible API
  |
  +-- Anthropic SDK --> Claude models
```

Build a thin adapter that normalizes both SDKs into a common interface:
- `sendMessage(messages, tools, options)` -> AsyncIterable of stream events
- Both SDKs support streaming, tool calling, and multi-turn conversations
- The adapter translates between OpenAI and Anthropic message/tool formats

DeepSeek does NOT need its own SDK. The OpenAI SDK handles it by setting `baseURL: 'https://api.deepseek.com'` and using `deepseek-chat` or `deepseek-reasoner` as the model name.

### Key Constraint: No VS Code Fork

Unlike Cursor (which forks the entire VS Code codebase at `github.com/microsoft/vscode`), wzxClaw builds its own shell. This means:

1. **No access to VS Code extension API** -- Must build own extension system or skip for MVP
2. **No built-in terminal** -- Can integrate node-pty later if needed
3. **No built-in language servers** -- Monaco provides basic syntax support; LSP integration is a future feature
4. **Full control over architecture** -- No fighting VS Code's layered DI system

The tradeoff is acceptable for MVP because the core value (AI Agent Loop + Chat Panel) does not depend on VS Code infrastructure.

## Installation

```bash
# Create project from electron-vite template
npm create @quick-start/electron@latest wzxclaw -- --template react-ts

cd wzxclaw

# Core dependencies
npm install monaco-editor @monaco-editor/react
npm install zustand
npm install openai @anthropic-ai/sdk
npm install chokidar uuid dotenv

# Dev dependencies (most come with the template, ensure these are present)
npm install -D electron electron-builder
npm install -D @types/node @types/react
npm install -D vitest
npm install -D eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
npm install -D prettier
```

### Minimum Requirements

- **Node.js**: >= 20.19.0 (required by electron-vite 5.x)
- **npm**: >= 10.0.0 (comes with Node 20+)
- **OS**: Windows 10+ (primary target per PROJECT.md)

## Sources

- npm registry API (registry.npmjs.org) -- All version numbers verified on 2026-04-03
- VS Code architecture wiki (github.com/microsoft/vscode/wiki) -- Layered architecture, target environments
- electron-vite documentation (electron-vite.org) -- Build tool configuration, multi-process setup
- OpenAI SDK GitHub (github.com/openai/openai-node) -- Streaming API, tool calling, v6 features
- Anthropic SDK GitHub (github.com/anthropics/anthropic-sdk-typescript) -- Claude API integration
- Monaco Editor documentation (microsoft.github.io/monaco-editor) -- API reference, React integration
- Zustand documentation (github.com/pmndrs/zustand) -- v5 API, middleware
- chokidar GitHub (github.com/paulmillr/chokidar) -- v4/v5 changes, API
- DeepSeek API documentation (api-docs.deepseek.com) -- OpenAI compatibility confirmation
