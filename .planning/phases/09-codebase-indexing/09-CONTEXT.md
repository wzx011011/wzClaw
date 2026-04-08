# Phase 9: Codebase Indexing - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

The agent can perform semantic search across the entire codebase using vector embeddings, finding relevant code that keyword search would miss. This phase adds background indexing with incremental updates, a SemanticSearch tool for the agent, and status display in the status bar.

</domain>

<decisions>
## Implementation Decisions

### Embedding & Search Architecture
- Use user's configured LLM API for embeddings (text-embedding endpoint), fallback to local TF-IDF if no embedding endpoint available
- Simple JSON file-based storage in .wzxclaw/index/ — no database dependency for MVP
- Split code at function/class boundaries using regex (function declarations, class declarations, export statements), max 512 tokens per chunk
- Cosine similarity on normalized vectors — simple, effective, no external library needed

### Indexing Workflow
- Index on workspace open (initial full index), then watch for file changes via chokidar for incremental updates
- New SemanticSearch tool in tool registry — agent calls it like any other tool
- Status bar shows icon + file count + status (indexing/ready/error)

### Claude's Discretion
- Token counting method for chunks (tiktoken vs character estimation)
- Embedding cache invalidation strategy
- Search result formatting and truncation
- Index file format (single JSON vs per-file JSON files)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- chokidar file watcher (Phase 03) — reuse for incremental index updates
- Tool registry (Phase 02) — new SemanticSearch tool registers here
- IPC channel pattern (Phase 01) — index operations via IPC
- StatusBar component (Phase 03) — add index status indicator
- Command palette (Phase 06) — add re-index command
- Settings store (Phase 04) — embedding API configuration

### Established Patterns
- Tools implement ITool interface in src/main/tools/
- IPC channels in src/shared/ipc-channels.ts with Zod schemas
- Stores in src/renderer/stores/ with Zustand
- Command palette commands via command-store.ts

### Integration Points
- Tool registry: src/main/tools/tool-registry.ts
- Agent loop: src/main/agent/ — SemanticSearch available to agent
- Workspace manager: src/main/workspace.ts — triggers initial index on workspace open
- File watcher: src/main/workspace.ts — triggers incremental updates
- Status bar: src/renderer/components/ide/StatusBar.tsx — index status

</code_context>

<specifics>
## Specific Ideas

- Index metadata should include file path, chunk offset, language, and last-modified timestamp
- Search results should include file path, line range, and relevance score
- Exclude node_modules, .git, dist, build, and binary files from indexing

</specifics>

<deferred>
## Deferred Ideas

- Real-time re-indexing as user types (may be too expensive)
- Cross-session index persistence (complex for MVP)
- Multi-workspace index support

</deferred>
