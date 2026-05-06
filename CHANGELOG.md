# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2025-05-04

### Added

- Plan mode with `/plan` command, Shift+Tab toggle, plan persistence, and permission dropdown integration
- Image attachments support (paste and drag-drop), session-isolated steps, input history
- Built-in plugins — code-quality, git-workflow, project-analysis
- Plugin system and skills framework with security hardening

### Changed

- Overhauled context window management (compact file restore, ~93% threshold, PTL turn-based retry)
- Ported Claude Code multi-layer matching algorithm for FileEdit/MultiEdit tools
- Eliminated main process sync blocking + renderer streaming optimizations + UX loading indicators

### Fixed

- Android `loadFetchedMessages` calls updated for new 2-arg signature
- Stream idle timeout retry + SearXNG web search issues
- Mobile session sync, context compaction, and workspace listing bugs
- Code review findings from performance commit

## [1.1.0] - 2025-04-27

### Added

- MultiEdit tool, LS tool, upgraded WebSearch/WebFetch, MCP default config

### Changed

- Renamed task → workspace across entire codebase (desktop + Android)
- Optimized chat rendering — delete rehypeHighlight, extract MessageList, memo ToolCard

### Fixed

- DeepSeek thinking mode 400 error (v4 thinking params, content null, reasoner strip)
- DeepSeek reasoning content preservation for tool calls
- Anthropic thinking block round-trip (persist ThinkingContentBlock with signature)
- Architecture fixes — rAF race, relay security, tool classification, snapshot interface, dead code
- Session sync bugs + code review warnings
- Parallel tool results preservation in OpenAI message builder
- Mobile session re-hydration on agent_running event via paged load

## [1.0.0] - 2025-04-13

### Added

- Micro-compact + stop hooks + stagnation detection
- Agent optimization — compaction, timeout, scores fix, budget
- Sticky question bar + tests (desktop & Android)
- Android foreground service real-time notification (replacing FCM)
- Eval framework with iteration engine and parallel dataset runs

### Changed

- Workspace-based session/memory isolation (drop task-{id} dirs)
- Removed sticky question bar in later refactor, fixed session switch state leaks

### Fixed

- Session串台 (session cross-contamination) — 3 root causes fixed
- Startup optimization — removed experimental GPU flags, immediate session list loading
- Mobile relay timer accumulation freeze, auto-generate token
- bigmodel.cn auth — Bearer token, hide beta headers from third-party endpoints
- Watchdog abort, state leak, hook cooldown, dead code

## [0.1.0] - 2025-03-28

### Added

- Initial release of wzxClaw desktop IDE
- Electron + React + Monaco Editor + xterm.js IDE shell
- AI Agent loop with 17 built-in tools
- Multi-LLM support (OpenAI, Anthropic, DeepSeek, GLM)
- Android companion app with WebSocket relay
- Session persistence and context management
- Langfuse observability integration
- Task management system
- Mobile relay server (NAS deployment)
