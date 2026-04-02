# Pitfalls Research: wzxClaw AI Coding IDE

**Researched:** 2026-04-03
**Confidence:** HIGH

## Critical Pitfalls

### PIT-01: LLM Streaming Tool Call Parsing
**Risk:** HIGH
**Description:** LLMs stream tool_use calls in chunks. The `function_call` / `tool_use` JSON arrives piece by piece. If you parse before the stream completes, you get malformed JSON. OpenAI and Anthropic use different streaming formats for tool calls.

**Warning signs:** Intermittent JSON parse errors during tool calls, lost tool call parameters
**Prevention:** Use SDK built-in streaming parsers (OpenAI SDK `.parse()`, Anthropic SDK `stream` helper). Never manually parse streaming tool call JSON. Build the tool call accumulator pattern from Claude Code's query.ts.
**Phase:** Phase 1 (Agent Runtime)

### PIT-02: Agent Infinite Loop
**Risk:** HIGH
**Description:** Agent loop (LLM → tool → LLM → tool → ...) can cycle indefinitely. LLM gets stuck calling the same tool with the same arguments, or bounces between two failing approaches.

**Warning signs:** Agent makes 5+ consecutive identical tool calls; total tokens consumed > 100K in one turn
**Prevention:** Hard limit on tool call iterations per turn (max 20-30). Track tool call history and detect repetition. If same tool+args repeated 3x, force-stop and inform user.
**Phase:** Phase 1 (Agent Runtime)

### PIT-03: Context Window Overflow
**Risk:** HIGH
**Description:** Each tool result adds tokens. File reads of large files, long bash outputs, grep results on large codebases — all blow up the context window. LLM API rejects the request.

**Warning signs:** API returns 400/context_length_exceeded after several tool calls
**Prevention:** Token counting before each API call. Truncate tool results (e.g., file reads limited to 2000 lines, bash output truncated at 10K chars). Implement context compaction: summarize older messages when approaching 80% of context limit.
**Phase:** Phase 1 (Agent Runtime)

### PIT-04: File Edit Race Conditions
**Risk:** MEDIUM
**Description:** LLM reads a file, decides to edit it, but the file has changed between read and edit. The edit applies stale line numbers, corrupting the file.

**Warning signs:** User reports file corruption; edits land on wrong lines
**Prevention:** Always re-read the file immediately before editing. Use content-based matching (find the exact string to replace) rather than line-number-based editing. Validate the old content matches before applying edit. This is exactly how Claude Code's FileEditTool works.
**Phase:** Phase 2 (Tool System)

### PIT-05: Bash Command Security
**Risk:** HIGH
**Description:** LLM can execute arbitrary shell commands including `rm -rf`, network calls, privilege escalation. Without sandboxing, this is a security disaster.

**Warning signs:** LLM runs destructive commands without user confirmation
**Prevention:** Permission system: bash commands require user approval by default. Auto-approve safe read-only commands (ls, cat, grep). Block dangerous patterns (rm -rf, sudo, chmod 777). Timeout all commands (default 120s). Run in working directory only, not system paths.
**Phase:** Phase 2 (Tool System)

### PIT-06: Multi-LLM API Format Differences
**Risk:** MEDIUM
**Description:** OpenAI and Anthropic have fundamentally different API formats:
- OpenAI: `function` / `function_call` in `choices[0].delta`
- Anthropic: `content_blocks` with `type: 'tool_use'`
- Different streaming protocols, error formats, token counting

**Warning signs:** Tool calls work with one provider but not another; streaming breaks on provider switch
**Prevention:** Separate adapter per provider in LLM Gateway. Don't try to abstract into a single format — use dual SDK approach (OpenAI SDK + Anthropic SDK). Convert to internal unified message format at the adapter boundary.
**Phase:** Phase 1 (LLM Gateway)

### PIT-07: Electron Main/Renderer Process Communication
**Risk:** MEDIUM
**Description:** IPC (contextBridge + ipcRenderer) has serialization limits. Can't pass functions, class instances, or circular references. Large file contents through IPC can block the renderer.

**Warning signs:** Data loss in IPC; UI freezes during file operations; "object could not be cloned" errors
**Prevention:** Use structured clone compatible types only (plain objects, arrays, strings). For large file contents, use shared memory or temp files instead of IPC. Keep IPC messages small (< 1MB). Use async IPC channels exclusively.
**Phase:** Phase 1 (Electron Shell)

### PIT-08: Monaco Editor Integration Complexity
**Risk:** MEDIUM
**Description:** Monaco Editor in Electron requires careful setup. Worker files, language services, theme customization all have Electron-specific gotchas. VS Code's Monaco setup is deeply intertwined with their extension system.

**Warning signs:** Syntax highlighting not working; web worker errors; editor sluggish with large files
**Prevention:** Use `@monaco-editor/react` wrapper for simpler integration. Don't try to replicate VS Code's extension host. Keep Monaco config simple — syntax highlighting + basic language features. Use Monaco's built-in TypeScript/JSON/CSS language services.
**Phase:** Phase 3 (Editor Shell)

### PIT-09: Build Size and Performance
**Risk:** LOW-MEDIUM
**Description:** Electron apps are large by default. Monaco Editor adds ~5MB. Multiple LLM SDKs add weight. Total installer can easily exceed 200MB.

**Warning signs:** Slow startup (> 5s); installer > 300MB; high memory usage
**Prevention:** Use electron-builder with aggressive tree-shaking. Lazy-load LLM SDKs (only load the one being used). Don't bundle all of Monaco's languages — only include what's needed. Target < 100MB installer, < 3s startup.
**Phase:** Phase 3 (Electron Shell)

### PIT-10: Token Counting Accuracy
**Risk:** MEDIUM
**Description:** Token counts must be accurate for context management. Different models use different tokenizers (Claude vs GPT vs DeepSeek). Inaccurate counting leads to either wasted context space or API errors.

**Warning signs:** API rejects requests you thought were within limits; context compaction triggers too early
**Prevention:** Use tiktoken for OpenAI models, Anthropic's token counting API for Claude. Add 10% safety margin. Count tokens after each message, not estimated. Log actual vs estimated to calibrate over time.
**Phase:** Phase 1 (LLM Gateway)

## Phase Mapping Summary

| Pitfall | Phase | Priority |
|---------|-------|----------|
| PIT-01: Streaming tool parsing | Phase 1 (Agent Runtime) | HIGH |
| PIT-02: Agent infinite loop | Phase 1 (Agent Runtime) | HIGH |
| PIT-03: Context overflow | Phase 1 (Agent Runtime) | HIGH |
| PIT-04: File edit race conditions | Phase 2 (Tool System) | MEDIUM |
| PIT-05: Bash security | Phase 2 (Tool System) | HIGH |
| PIT-06: Multi-LLM format diffs | Phase 1 (LLM Gateway) | MEDIUM |
| PIT-07: IPC communication | Phase 1 (Electron Shell) | MEDIUM |
| PIT-08: Monaco integration | Phase 3 (Editor Shell) | MEDIUM |
| PIT-09: Build size | Phase 3 (Electron Shell) | LOW-MEDIUM |
| PIT-10: Token counting | Phase 1 (LLM Gateway) | MEDIUM |
