# wzxClaw

## What This Is

一个类似 Cursor 的 AI 编程 IDE 桌面应用。基于 VS Code 技术栈（Electron + Monaco Editor + React + TypeScript），内建 AI Agent Runtime，支持多 LLM 后端（OpenAI 兼容接口、Anthropic、DeepSeek 等）。参考 Claude Code 源码的 runtime 架构重写核心引擎，跳过终端 UI 层，直接嵌入桌面 GUI。

个人使用的 AI 编程工具。

## Core Value

AI Agent 能正确调用工具（读写文件、执行命令、搜索代码）完成编程任务，且用户能在 Chat Panel 中实时看到过程和结果。

## Requirements

### Validated

- ✓ Agent Loop — 多轮对话循环，流式输出，工具调用链 (v1.0)
- ✓ Tool System — 文件读写(Read/Write/Edit)、Bash执行、代码搜索(Grep/Glob) (v1.0)
- ✓ Chat Panel — 侧边栏 AI 对话面板，Markdown渲染，代码块，工具卡片 (v1.0)
- ✓ 多 LLM 后端 — OpenAI兼容接口 + Anthropic API，多模型切换 (v1.0)
- ✓ Electron 桌面壳 — Monaco编辑器 + 文件树 + Tab管理 + NSIS安装包 (v1.0)

### Active

- [ ] 上下文管理 — Token计数、自动压缩(autocompact)、上下文窗口优化
- [ ] Inline Diff预览 — AI改代码时显示红/绿diff，逐hunk接受/拒绝
- [ ] @-提及上下文 — 聊天中 @文件/@文件夹/@代码 注入上下文到对话
- [ ] 多会话管理 — 多对话标签页，对话历史，切换/恢复/删除
- [ ] 命令面板 — Ctrl+Shift+P 快速命令系统
- [ ] 终端面板 — 内嵌终端，AI可执行命令并读取输出
- [ ] 更多工具 — WebSearch, WebFetch, LSP符号跳转, NotebookEdit
- [ ] 代码库索引 — 向量化语义搜索，项目结构理解
- [ ] Session持久化 — 对话保存/恢复，JSONL存储
- [ ] Task/Plan系统 — 任务创建/跟踪/依赖管理

### Out of Scope

- Tab 补全（Inline Code Suggestion）— 后续版本
- Inline Edit（选中代码 AI 改写）— 后续版本
- MCP 协议支持 — 后续版本
- Hooks/Skills 系统 — 后续版本
- Task/Plan 管理 — 后续版本
- Vim 模式 — 不需要，Monaco 自带快捷键
- 终端 UI (Ink) — 不需要，有 Electron GUI
- 代码库索引/语义搜索 — 后续版本
- 多人协作 — 个人工具不需要
- 付费系统/用户体系 — 个人工具不需要

## Current Milestone: v1.2 完全体核心引擎

**Goal:** 实现 Claude Code 引擎核心能力 + Cursor IDE 核心交互体验，将 wzxClaw 从 MVP 进化为生产级 AI 编程工具

**Target features:**
- 上下文管理 — Token计数、自动压缩、上下文窗口优化
- Inline Diff预览 — AI改代码时显示红/绿diff，逐hunk接受/拒绝
- @-提及上下文 — 聊天中 @文件/@文件夹 注入上下文
- 多会话管理 — 多对话标签页、历史记录、切换/恢复
- 命令面板 — Ctrl+Shift+P 快速命令系统
- 终端面板 — 内嵌终端，AI可执行命令并读取输出
- 更多工具 — WebSearch, WebFetch, LSP符号跳转, NotebookEdit
- 代码库索引 — 向量化语义搜索，项目结构理解
- Session持久化 — 对话保存/恢复，JSONL存储
- Task/Plan系统 — 任务创建/跟踪/依赖管理

## Context

- Claude Code 源码位于 `E:\ai\claude-code\`，1884 个源文件，~56K 行代码，作为 runtime 架构的参考
- Claude Code 的 runtime 核心包含：Agent 对话循环、Tool System（20+ 工具）、Context Management（上下文截断、token 计算）、Permission System
- CLI 层（Ink 终端 UI、REPL、Vim 模式、Console OAuth）不需要移植
- Cursor 是基于 VS Code 开源版 fork 的，技术栈：Electron + Monaco + TypeScript + React
- 用户熟悉 TypeScript 开发

## Constraints

- **Tech Stack**: Electron + Monaco Editor + React + TypeScript — 必须和 VS Code/Cursor 同款技术栈
- **Approach**: 参考 Claude Code 源码重写 runtime，不直接 fork — 架构自主可控
- **LLM API**: 必须支持多家 API，不能只绑 Anthropic
- **Scope**: MVP 优先 — 先跑通 Agent Loop + Tool System + Chat Panel，再逐步加功能
- **Target**: 个人工具，不需要考虑商业化、付费、用户体系

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 参考 + 重写（非 Fork） | Claude Code 代码和 CLI 层深度耦合，剥离成本高；MVP 核心代码量不大，重写更干净 | — Pending |
| MVP 范围：Agent + Tools + Chat | 先跑通最小可用版本，验证核心价值 | — Pending |
| 多 LLM 后端支持 | 个人使用需要灵活切换不同模型，不能只绑一家 | — Pending |
| Cursor 风格 UI | 参考最成熟的 AI IDE 交互模式 | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-08 after milestone v1.2 definition*
