---
phase: 04-shared-web-ui
plan: 04
subsystem: chat-ui
tags: [tool-calls, code-block, syntax-highlighting, react, visualization]
dependency_graph:
  requires: [04b]
  provides: [tool-card-component, tool-call-group-component, enhanced-code-block]
  affects: [packages/web-ui/src/components/chat/*, packages/web-ui/src/styles/*]
tech_stack:
  added: []
  patterns:
    - tool call card with collapsible body (CSS max-height animation)
    - workflow header for grouped tool calls (3+ tools)
    - left rail line connecting tool cards in a group
    - auto-collapse on completion, auto-expand on running
    - line numbers gutter in code blocks via flex layout
key_files:
  created:
    - packages/web-ui/src/components/chat/ToolCard.tsx
    - packages/web-ui/src/components/chat/ToolCallGroup.tsx
  modified:
    - packages/web-ui/src/components/chat/CodeBlock.tsx
    - packages/web-ui/src/components/chat/ChatMessage.tsx
    - packages/web-ui/src/styles/chat.css
decisions:
  - "Simplified ToolCard from 725-line desktop version to ~290 lines — removed DiffPreview, GoToDefinition/FindReferences special rendering, revert functionality, i18n, nested children"
  - "Used CSS max-height animation for tool card body expand/collapse instead of JS-driven height calculation"
  - "All UI text in Chinese (action verbs, section labels, status messages)"
  - "ToolCallGroup always shows left rail line (even for single tool) for visual consistency"
  - "Auto-collapse workflow header when all tools complete (3+ tools only), auto-expand when any tool starts running"
metrics:
  duration: ~5min
  completed: 2026-05-14
---

# Phase 4 Plan 04d: Tool Call Visualization + Code Block Summary

Tool call cards with status/input/output rendering, grouped tool call display with workflow header and left rail line, and enhanced code blocks with line numbers.

## Changes Made

### ToolCard.tsx (new, ~290 lines)
- Extracted from desktop ToolCard (725 lines), simplified for web-ui
- Status icon per tool type (lightning for Bash, pencil for Write/Edit, etc.)
- Chinese action verbs (running/completed states): "执行中"/"已执行", "读取中"/"已读取", etc.
- Input badge with file-type color coding (ts=cyan, js=yellow, css=purple, etc.)
- Result summary line in collapsed state
- Collapsible body with JSON input and truncated output (500 chars)
- Special rendering for WebSearch (title + URL list) and WebFetch (source + content)
- Running timer display with 250ms update interval
- Status dots: running (pulsing amber), completed (green), error (red)
- Memo comparator to skip re-renders for unchanged tool cards

### ToolCallGroup.tsx (new, ~135 lines)
- Extracted from desktop ToolCallGroup (170 lines)
- WorkflowHeader: shown when 3+ tools, displays tool summary with collapse toggle
- Left rail line: always visible, green when all tools complete
- Auto-collapse: folds when all tools finish, expands when running resumes
- Enter animation key for tool list on expand
- Spinner animation for running state, checkmark for completed, warning for error

### CodeBlock.tsx (enhanced)
- Added line numbers gutter (flex layout with left column)
- Line number column: right-aligned, monospace, user-select none, border-right separator
- Body wrapper `code-block-body` replaces direct `<pre>` for side-by-side layout
- Preserved: syntax highlighting (highlight.js), copy button, collapse/expand (>15 lines)

### ChatMessage.tsx (updated)
- Replaced basic tool call placeholder with ToolCallGroup component
- Imported ToolCallGroup, passes `toolCalls` array from message
- ToolCallGroup renders inside `.chat-message-tools` div

### chat.css (updated)
- Added ~250 lines of new styles for tool card body/details/sections, status dots, toggle arrow, progress text, web result styles
- Added ToolCallGroup styles: rail layout, connecting line, tools container, slide-in animation
- Added WorkflowHeader styles: toggle, label, shimmer text, spinner animation
- Updated code block styles for line number gutter layout
- Updated highlight.js theme overrides for new `.code-block-pre` selector

## Deviations from Plan

None -- plan executed exactly as written.

## Verification

- TypeScript type check: passed (zero errors)
- Production build: passed (381 modules, built in 2.64s)
- Unit tests: 19/19 passed
- No accidental file deletions in commit

## Self-Check: PASSED

- All 5 created/modified files verified present
- Commit fe30379 verified in git log
