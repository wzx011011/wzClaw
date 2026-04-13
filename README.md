# wzxClaw

Personal AI coding IDE desktop application — a Cursor-like tool built on the VS Code tech stack.

## Overview

wzxClaw embeds a full AI Agent Runtime directly into a desktop GUI, with a Monaco Editor, real-time Chat Panel, and tool execution visible as it happens. It supports multiple LLM backends through a unified gateway.

**Core value:** The AI agent correctly calls tools (read/write files, run commands, search code) to complete programming tasks, and you see every step in the Chat Panel in real time.

## Features

- **Multi-LLM support** — OpenAI, Anthropic Claude, DeepSeek, GLM, and any OpenAI-compatible endpoint
- **Agent loop** — multi-turn conversations with up to 25 turns, automatic context compaction at 80% threshold
- **Tool system** — 20 built-in tools:
  - `FileRead` / `FileWrite` / `FileEdit` — workspace-boundary-enforced file operations
  - `Bash` — shell command execution with security policy
  - `Grep` / `Glob` — code search
  - `Browser*` — web browsing (screenshot, click, type, scroll, navigate)
  - `WebSearch` / `WebFetch` — internet research
  - `SemanticSearch` — TF-IDF vector search over indexed project files
  - `SymbolNav` — code symbol navigation
  - `TodoWrite` / `CreateTask` / `UpdateTask` — task management
  - `Agent` — sub-agent spawning
  - `AskUser` — mid-task clarification
- **Streaming** — real-time token streaming displayed in Chat Panel
- **Permission system** — 4 modes: always-ask, accept-edits, plan, bypass
- **Monaco Editor** — the actual VS Code editor engine with syntax highlighting and multi-language support
- **Mobile bridge** — companion Android app connects via WebSocket tunnel for on-the-go control

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 41 |
| Language | TypeScript 6 |
| UI | React 19 + Zustand 5 |
| Editor | Monaco Editor 0.55 |
| LLM (OpenAI-compat) | openai SDK 6 |
| LLM (Anthropic) | @anthropic-ai/sdk 0.82 |
| Build | electron-vite 5 + electron-builder 26 |
| Tests | Vitest |

## Installation

Download the latest installer from [Releases](../../releases) and run it. No additional setup needed — configure your API keys inside the application.

### Build from source

```bash
# Prerequisites: Node.js >= 20.19, npm >= 10
npm install
npm run dev          # development mode
npm run build:win    # build Windows installer
```

## Configuration

On first launch, open Settings and configure:

- **API Key** and **Base URL** for your preferred LLM provider
- **Model** — e.g. `claude-sonnet-4-6`, `deepseek-chat`, `gpt-4o`
- **Permission mode** — controls which tool calls require approval

## Project structure

```
src/
├── main/              # Electron main process
│   ├── agent/         # Agent loop + context manager
│   ├── llm/           # LLM gateway + adapters (OpenAI, Anthropic)
│   ├── tools/         # Tool implementations
│   ├── permission/    # Permission manager
│   ├── indexing/      # TF-IDF semantic search
│   └── mobile/        # WebSocket tunnel for Android companion
├── renderer/          # React UI (Chat Panel, Monaco Editor)
└── shared/            # Types and constants
```

## License

Personal use. Not open-sourced.
