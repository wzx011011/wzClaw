# Project Research Summary

**Project:** wzxClaw -- Cursor-like AI Coding IDE
**Domain:** Desktop AI Coding IDE (Electron application)
**Researched:** 2026-04-03
**Confidence:** HIGH

## Executive Summary

wzxClaw is a personal, desktop AI coding IDE in the vein of Cursor, built from scratch rather than as a VS Code fork. The research shows a clear architectural path: an Electron shell with Monaco Editor for code editing, a React-based chat panel for AI interaction, and a custom Agent Runtime in the Electron main process that orchestrates LLM calls with a tool system for file operations and command execution. Unlike Cursor (which forks the entire VS Code codebase), wzxClaw builds its own shell, trading VS Code extension compatibility for full architectural control and a simpler codebase.

The recommended approach is to build bottom-up in dependency order: shared types, then IPC protocol, then LLM Gateway, then Tool System, then Agent Runtime, and finally the Electron shell tying everything together. Two SDKs (OpenAI for OpenAI/DeepSeek, Anthropic for Claude) feed through a unified LLM Gateway adapter. The Agent Loop follows the pattern established by Claude Code: user message to LLM, parse streaming response for tool calls, execute tools, feed results back, repeat until the LLM produces a text-only response.

The key risks center on the Agent Runtime. Streaming tool call parsing is tricky because tool_use JSON arrives in chunks across both providers. The agent loop can cycle infinitely on repeated failures. Context windows overflow quickly as tool results accumulate. These are solvable with SDK-native streaming parsers, iteration caps, and token-aware context compaction -- but they must be designed in from the start, not bolted on later.

## Key Findings

### Recommended Stack

The stack is entirely TypeScript with Electron as the desktop shell. Every technology choice is HIGH confidence and backed by official documentation or npm registry verification. The key principle: use the same tools the reference codebases (VS Code, Cursor, Claude Code) use.

**Core technologies:**
- **Electron 41.1.1** -- Desktop shell; Chromium 134 + Node 22.x; industry standard for IDE-class apps
- **TypeScript 6.0.2** -- Primary language; matches reference codebases for code portability
- **React 19.2.4** -- UI framework for Chat Panel and workbench; rich ecosystem for IDE-like components
- **Monaco Editor 0.55.1** -- Code editor core; literally the VS Code editor packaged standalone
- **Zustand 5.0.12** -- State management; minimal boilerplate, hook-based, no context provider overhead in Electron
- **OpenAI SDK 6.33.0** -- LLM client for OpenAI and DeepSeek (same SDK, different baseURL)
- **Anthropic SDK 0.82.0** -- LLM client for Claude; fundamentally different API format, requires separate SDK
- **electron-vite 5.0.0** -- Build toolchain; purpose-built for Electron multi-process architecture
- **chokidar 5.0.0** -- File system watcher; battle-tested, essential for feeding file changes into Agent context

### Expected Features

**Must have (table stakes -- Phase 1):**
- Open folder as workspace + file tree explorer -- fundamental IDE action
- Monaco editor with tab-based multi-file editing -- the editing surface
- Sidebar chat panel with streaming LLM responses -- core AI interaction
- Agent tool system: FileRead, FileWrite, FileEdit, Bash, Grep, Glob -- autonomous coding capability
- Tool approval/permission prompts -- safety baseline for destructive operations
- One-click "Apply" for code blocks in chat -- bridge between AI output and editor
- BYOK (bring your own key) multi-model support from day one

**Should have (competitive -- Phase 2):**
- @-mentions (@Files, @Folders) -- Cursor's killer UX feature for attaching context
- Checkpoints/undo system -- one-click rollback of agent changes; critical for trust
- Rules/.wzxclawrules -- project-level AI behavior instructions, zero-cost quality improvement
- Conversation history persistence -- resume past sessions
- Grep/Glob agent tools -- code search for non-trivial tasks

**Defer (Phase 3+):**
- Inline edit (Cmd+K) -- requires deep Monaco integration for inline diff rendering
- Tab completion -- requires dedicated inference model or specialized API
- MCP support -- extensibility story, growing ecosystem but complex
- Plan mode -- structured agent workflow, valuable but not MVP
- Codebase indexing / semantic search -- embeddings + vector store, very complex

### Architecture Approach

The architecture follows a strict Main Process / Renderer Process split enforced by Electron. The Agent Runtime, Tool System, and LLM Gateway all run in the Main Process (Node.js context) where they have direct file system and network access. The Renderer Process (Chromium) hosts Monaco Editor, Chat Panel, and File Explorer as React components sharing state through Zustand. Communication between processes uses typed IPC channels.

**Major components:**
1. **Agent Runtime** (Main Process) -- Conversation loop orchestrator. Manages message history, drives the LLM-to-tool-to-LLM cycle, handles streaming, abort, and context compaction. Inspired by Claude Code's query.ts pattern.
2. **LLM Gateway** (Main Process) -- Multi-provider adapter. Dual SDK approach: OpenAI SDK for OpenAI/DeepSeek, Anthropic SDK for Claude. Unified internal interface, provider-specific adapters at the boundary.
3. **Tool System** (Main Process) -- Each tool implements a common interface (name, description, inputSchema, execute). MVP: FileRead, FileWrite, FileEdit, Bash, Grep, Glob. Permission model per tool.
4. **Chat Panel** (Renderer) -- React component for AI conversation. Streaming text display, markdown rendering, code blocks with Apply button, tool call visualization, message input.
5. **Monaco Editor** (Renderer) -- File tabs, syntax highlighting, multi-file editing. Save triggers flow to main process via IPC.
6. **File Explorer** (Renderer) -- Directory tree view. File open/create/delete/rename operations.

### Critical Pitfalls

1. **LLM Streaming Tool Call Parsing** -- Tool_use JSON arrives in chunks. Never manually parse; use SDK-native streaming parsers. Build a tool call accumulator pattern.
2. **Agent Infinite Loop** -- Cap tool iterations at 20-30 per turn. Detect repeated identical tool calls (3x same = force stop). Log token consumption.
3. **Context Window Overflow** -- Count tokens before each API call. Truncate tool results (files to 2000 lines, bash output to 10K chars). Implement context compaction at 80% threshold.
4. **Bash Command Security** -- Default to user approval for all bash commands. Auto-approve safe read-only commands. Block destructive patterns. 120s timeout.
5. **Multi-LLM API Format Differences** -- OpenAI and Anthropic have fundamentally different streaming formats and tool call structures. Use separate adapters per provider; convert to internal format at the adapter boundary. Do not try to force a single abstraction.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Foundation (Shared Types + IPC + LLM Gateway)
**Rationale:** The Agent Runtime and Tool System both depend on LLM integration and typed communication. Building the type system, IPC protocol, and LLM Gateway first establishes the contracts everything else follows. This phase has zero UI and can be fully tested in Node.js without Electron.
**Delivers:** TypeScript type definitions, IPC channel definitions, working LLM Gateway that can stream responses from OpenAI/DeepSeek and Claude
**Addresses:** LLM API support feature, streaming responses, multi-model support
**Avoids:** PIT-01 (streaming tool parsing), PIT-06 (multi-LLM format differences), PIT-10 (token counting)

### Phase 2: Agent Core (Tool System + Agent Runtime)
**Rationale:** With the LLM Gateway in place, the Agent Runtime and Tool System can be built and tested. This is the core value proposition -- the agent loop that makes the IDE "AI-powered." The conversation loop pattern from Claude Code is well-documented and can be implemented with high confidence.
**Delivers:** Working Agent Runtime with conversation loop, MVP tool implementations (FileRead, FileWrite, FileEdit, Bash, Grep, Glob), permission system, context management with token counting
**Addresses:** Agent tool system features, tool approval/permission prompts
**Avoids:** PIT-02 (infinite loop), PIT-03 (context overflow), PIT-04 (file edit race conditions), PIT-05 (bash security)

### Phase 3: IDE Shell (Electron + Monaco + File Explorer + Tabs)
**Rationale:** The IDE shell is the visual surface. It depends on nothing from Phase 1-2 except the IPC protocol. Could technically be built in parallel, but sequential delivery ensures the IPC contracts are stable before building UI against them. Monaco integration has known gotchas with Electron web workers, so this phase needs careful testing.
**Delivers:** Electron app window, Monaco editor with file tabs, file explorer tree, workspace open/close, file save
**Addresses:** Open folder workspace, file tree, tab-based editing, syntax highlighting, cursor position tracking
**Avoids:** PIT-08 (Monaco integration complexity), PIT-09 (build size)

### Phase 4: Chat Panel + Integration (Connect Agent to UI)
**Rationale:** This is the integration phase where Agent Runtime, Tool System, LLM Gateway, and IDE Shell all connect through the Chat Panel. Every IPC channel is wired up. The user can type a message, see streaming AI response, watch tool calls execute, and apply code changes to the editor. This is the first phase where the product feels usable end-to-end.
**Delivers:** Chat panel with streaming, code block rendering with Apply button, tool call visualization, settings panel for API keys and model selection, end-to-end agent workflow
**Addresses:** Chat panel features, code block apply, API key configuration, model selection, tool call visualization, stop generation
**Avoids:** PIT-07 (IPC communication limits)

### Phase 5: Competitive Features (@-mentions, Checkpoints, Rules)
**Rationale:** With the core product working, add the features that differentiate wzxClaw from a basic chat wrapper. @-mentions require file tree integration (built in Phase 3). Checkpoints require either git-based or snapshot-based state management. Rules are low-effort, high-value configuration files.
**Delivers:** @-mentions for files and folders, checkpoint/undo system, .wzxclawrules support, conversation history persistence
**Addresses:** @-mentions (Tier 1 differentiator), checkpoints (Tier 1), rules/custom instructions (Tier 2), conversation persistence (Tier 2)

### Phase Ordering Rationale

- **Dependency-driven:** Types before IPC, IPC before Gateway, Gateway before Agent, Agent before Chat UI. This is the build order from ARCHITECTURE.md and it is non-negotiable.
- **Value-driven within phases:** LLM Gateway in Phase 1 is testable immediately. Agent Runtime in Phase 2 is the core IP. Phase 4 integration is the "it works" moment.
- **Risk front-loaded:** The three highest-risk pitfalls (streaming parsing, infinite loops, context overflow) are all in the Agent Runtime, addressed in Phase 2. Getting these right early prevents cascading failures later.
- **UI last-ish:** The IDE shell and chat panel depend on stable contracts from the backend components. Building UI first leads to constant refactoring as APIs evolve.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1:** LLM Gateway streaming implementation -- the exact patterns for accumulating tool call chunks from both SDKs need careful API review. The Anthropic streaming format in particular has nuances around content block types.
- **Phase 2:** Bash tool sandboxing on Windows -- most AI IDE sandboxing documentation targets macOS/Linux. wzxClaw targets Windows 10+. Need to research Windows-specific command sandboxing (job objects, restricted tokens, or working-directory confinement).
- **Phase 5:** Checkpoint implementation -- need to decide between git-based snapshots (requires git installed), file-system snapshots (storage heavy), or AST-aware undo (complex). This warrants its own research spike.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Shared types and IPC protocol -- pure TypeScript design, well-documented Electron IPC patterns
- **Phase 3:** IDE Shell -- Electron + Monaco integration has extensive community documentation and examples
- **Phase 4:** Chat Panel -- standard React UI development with streaming display patterns well-established

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All versions verified against npm registry. Every technology is the industry standard for its category. Alternatives considered and rejected with clear rationale. |
| Features | HIGH | Comprehensive competitive analysis against Cursor, Windsurf, Copilot, and Qoder. Feature priorities map to real user expectations documented in official docs. MVP recommendation is defensible. |
| Architecture | HIGH | Based on direct analysis of Claude Code source patterns (query.ts, Tool.ts, types/). IPC channel design follows Electron best practices. Component boundaries are clean. |
| Pitfalls | HIGH | All 10 pitfalls are concrete, with specific warning signs and prevention strategies. Phase mapping aligns with architectural dependencies. |

**Overall confidence:** HIGH

### Gaps to Address

- **Windows-specific bash sandboxing:** Most AI IDE sandboxing documentation covers macOS/Linux. wzxClaw targets Windows 10+. Need to research Windows-specific approaches (job objects, process restrictions, or working-directory-only confinement) during Phase 2 planning.
- **Monaco + Electron web worker setup:** The exact configuration for Monaco's language service workers inside Electron's renderer process requires careful testing. The @monaco-editor/react wrapper handles most of this, but custom language services may need manual worker configuration.
- **Context compaction strategy:** Research identifies the need (compact at 80% of context limit) but the implementation approach (summarize older messages? Drop tool results? Use a secondary LLM call?) needs definition during Phase 2.
- **Token counting across providers:** Different models use different tokenizers. tiktoken works for OpenAI models, Anthropic has its own counting. Need a pragmatic strategy during Phase 1 -- likely provider-specific token counters behind a common interface.

## Sources

### Primary (HIGH confidence)
- npm registry API (registry.npmjs.org) -- all version numbers verified 2026-04-03
- Cursor official documentation (cursor.com/docs) -- agent features, tool system, UX patterns
- VS Code architecture wiki (github.com/microsoft/vscode/wiki) -- layered architecture reference
- electron-vite documentation (electron-vite.org) -- build tool configuration
- OpenAI SDK GitHub (github.com/openai/openai-node) -- streaming API, tool calling
- Anthropic SDK GitHub (github.com/anthropics/anthropic-sdk-typescript) -- Claude API integration
- Monaco Editor documentation (microsoft.github.io/monaco-editor) -- API reference
- GitHub Copilot official docs (docs.github.com/en/copilot) -- feature comparison
- VS Code Agents Tutorial (code.visualstudio.com/docs/copilot/agents) -- agent patterns
- DeepSeek API documentation (api-docs.deepseek.com) -- OpenAI compatibility confirmation

### Secondary (MEDIUM confidence)
- "Cursor Deep Dive: $29B by Forking VS Code" (mmntm.net) -- Cursor business/architecture analysis
- "AI Coding Agents in 2025: Comprehensive Comparison" (kingy.ai) -- competitive landscape
- "Cursor vs Claude Code" (devtoolsacademy.com) -- feature comparison
- "A Technical Guide to AI Agent Sandboxing" (levelup.gitconnected.com) -- sandboxing patterns

---
*Research completed: 2026-04-03*
*Ready for roadmap: yes*
