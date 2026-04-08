---
status: testing
phase: all-phases
source: 01-SUMMARY.md, 02-SUMMARY.md, 03-SUMMARY.md, 02-01-SUMMARY.md, 02-02-SUMMARY.md, 02-03-SUMMARY.md, 02-04-SUMMARY.md, 03-01-SUMMARY.md, 03-02-SUMMARY.md, 03-03-SUMMARY.md, 04-01-SUMMARY.md, 04-02-SUMMARY.md, 04-03-SUMMARY.md, 05-01-SUMMARY.md, 05-02-SUMMARY.md
started: 2026-04-07T12:00:00Z
updated: 2026-04-07T12:00:00Z
---

## Current Test
<!-- OVERWRITE each test - shows where we are -->

number: 1
name: Cold Start Smoke Test
expected: |
  Launch wzxClaw.exe (dev or packaged). App opens a desktop window without errors. Three-pane layout renders: File Explorer (left) | Editor (center) | Chat Panel (right). No crash, no blank screen.
awaiting: user response

## Tests

### 1. Cold Start Smoke Test
expected: Launch wzxClaw (dev mode via npm run dev or packaged exe). Desktop window opens with three-pane layout: File Explorer | Editor | Chat Panel. No crash, no blank screen, no error dialogs.
result: [pending]

### 2. Open Folder via Menu
expected: File > Open Folder (Ctrl+Shift+O) opens a native folder picker. Selecting a folder loads the directory tree in the left sidebar. Folders and files are listed with proper icons.
result: [pending]

### 3. Open Folder via Sidebar Button
expected: Click "Open Folder" button in sidebar. Same folder picker appears. Selecting a folder loads the file tree identically to menu action.
result: [pending]

### 4. File Explorer Navigation
expected: Expand folders in sidebar tree. Click a file to open it in a new Monaco Editor tab. Click another file to open a second tab. Switch between tabs by clicking tab headers.
result: [pending]

### 5. Monaco Editor - Syntax Highlighting and Editing
expected: Open a .ts or .tsx file. Code displays with syntax highlighting (colors for keywords, strings, types). Click in editor, type text — normal text editing works. Multi-cursor not required but basic editing must work.
result: [pending]

### 6. Dirty State and Save (Ctrl+S)
expected: Edit a file in the editor. Tab header shows a dirty indicator (dot or asterisk). Press Ctrl+S. Dirty indicator disappears. Status bar or console shows no errors.
result: [pending]

### 7. Settings Panel - API Key Configuration
expected: Click gear icon in chat panel header. Settings modal opens. Enter API key for Anthropic provider. Click Save. Close and reopen settings — API key persists (shown as masked dots).
result: [pending]

### 8. Settings Panel - Model Selection
expected: In settings modal or chat header, select a different model (e.g., GLM-5.1). Model name updates in chat header. Send a message — it uses the selected model.
result: [pending]

### 9. Chat Streaming Response
expected: Type a message in chat input box (e.g., "hello, respond with a short greeting"). Press Enter or click Send. Response streams in token-by-token in the chat panel. Streaming indicator visible during generation.
result: [pending]

### 10. Tool Call Visualization
expected: Ask the agent to do something requiring tools (e.g., "read the file package.json"). Chat shows a tool call card with: tool name (e.g., FileRead), input parameters, and output result. Card is collapsible.
result: [pending]

### 11. Code Block with Apply Button
expected: Ask agent to generate code (e.g., "write a hello world function in Python"). Response contains a syntax-highlighted code block. An "Apply" button is visible on the code block. Clicking Apply inserts code into the active editor tab.
result: [pending]

### 12. Stop Generation
expected: While agent is streaming a response, click the Stop button. Generation stops immediately. Partial response remains visible in chat. Chat input becomes available again.
result: [pending]

### 13. Clear Conversation
expected: After some messages exist, click the Clear button. All messages are removed. Chat panel shows empty state. Ready for new conversation.
result: [pending]

### 14. Agent Multi-Turn Conversation
expected: Send "list the files in the current project". Agent uses Glob/Grep tool, shows results. Send a follow-up "now read the first file". Agent reads the file in context of previous conversation.
result: [pending]

### 15. Permission Request for Destructive Tool
expected: Ask agent to write or edit a file (e.g., "create a file called test-output.txt with hello world"). A permission prompt appears asking for approval. Click Approve/Allow. Tool executes and result appears in chat.
result: [pending]

### 16. GLM-5.1 Model via Anthropic API
expected: Select GLM-5.1 model in settings. Send a message. Response streams successfully from zhipuai BigModel API. No "No adapter configured" error.
result: [pending]

### 17. File Watch - External Changes Reflected
expected: Open a file in editor. In an external editor or file manager, modify and save that file. The editor tab refreshes to show updated content (if tab is not dirty).
result: [pending]

### 18. Packaged Installer Builds
expected: Run `npm run build:win` (with ELECTRON_MIRROR set). NSIS installer .exe is produced in dist/. File size around 90 MB. No build errors.
result: [pending]

## Summary

total: 18
passed: 0
issues: 0
pending: 18
skipped: 0

## Gaps

[none yet]
