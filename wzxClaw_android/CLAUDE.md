<!-- GSD:project-start source:PROJECT.md -->
## Project

**wzxClaw Android**

wzxClaw 的安卓端客户端，通过 NAS 中转 WebSocket 连接桌面端 wzxClaw IDE。用户在手机上发送编程指令、查看 AI Agent 实时执行过程、管理项目、接收任务完成推送、使用语音输入。个人工具，不考虑商业化。

**Core Value:** 手机端能实时和桌面端 wzxClaw 的 AI Agent 对话，看到流式回复和工具调用过程，且在广域网环境下稳定可用。

### Constraints

- **Tech Stack**: Flutter (Dart) — 用户选择，追求轻量和快速开发
- **Target Platform**: Android only — 先不做 iOS
- **Network**: 必须支持广域网访问（手机不在同一局域网），通过 NAS 5945.top 中转
- **Server**: NAS Docker 部署 WebSocket Relay 服务，复用现有 5945.top 域名和 HTTPS
- **Desktop Integration**: 复用 wzxClaw 桌面端已有的 WebSocket 协议和消息格式
- **Scope**: 个人工具，不考虑商业化、付费、多用户
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
