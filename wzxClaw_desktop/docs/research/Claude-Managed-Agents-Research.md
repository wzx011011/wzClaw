# Claude Managed Agents 调研报告

### 概述

**Claude Managed Agents** 是 Anthropic 于 **2026 年 4 月 8 日**推出的公共 Beta 服务。它提供了一个**托管的 Agent 运行时平台**——开发者无需自建 agent loop、sandbox 或工具执行层，直接使用 Anthropic 的云端基础设施运行自主 AI Agent。

---

## 核心架构：Brain / Hands / Session 三层解耦

这是这篇文章最有价值的部分——Anthropic 如何设计一个可扩展的 Agent 基础设施。

| 概念 | 类比 | 职责 |
|------|------|------|
| **Brain (大脑)** | OS 内核 | Harness 循环——调用 Claude API、路由 tool calls、管理 context |
| **Hands (手)** | 外设驱动 | Sandbox/容器——执行代码、编辑文件、运行命令 |
| **Session (会话)** | 磁盘 | 持久化的事件日志——append-only，记录所有交互 |

### 关键设计决策

1. **不要养宠物（Don't adopt a pet）**——早期把所有组件放在一个容器里，结果容器挂了 = 会话丢失，成了需要精心照料的 "pet"。解耦后，每个组件都是可替换的 "cattle"。

2. **Harness 不住在容器里**——Harness 通过 `execute(name, input) → string` 调用 Sandbox，就像调用任何其他工具一样。容器挂了？Harness 捕获错误，传给 Claude，Claude 决定是否重试，新容器用 `provision({resources})` 重建。

3. **Harness 本身也是 cattle**——Session 日志存在 Harness 外部。Harness 崩溃？新的 Harness 通过 `wake(sessionId)` 恢复，用 `getSession(id)` 取回事件日志，从最后一个事件继续。

4. **安全边界**——Sandbox 里运行的不可信代码永远接触不到凭证。Git token 在 sandbox 初始化时注入 local remote；MCP 的 OAuth token 存在 secure vault 里，通过代理调用。Harness 完全不知道凭证的存在。

---

## 性能提升

解耦 Brain 和 Hands 带来了显著性能收益：

| 指标 | 改善幅度 |
|------|----------|
| p50 TTFT (首 token 时间) | **下降 ~60%** |
| p95 TTFT | **下降 >90%** |

原因：不再为每个会话预建容器。Harness 是无状态的，可以快速启动；Sandbox 只在 Claude 真正需要执行操作时才按需创建。

---

## Session ≠ Context Window

这是另一个重要洞察：

- **Context window 是有限的、不可逆的**——compaction、trimming 都是单向操作，丢掉的 token 无法恢复
- **Session 是持久的、可回溯的**——`getEvents()` 允许 Harness 按位置切片查询事件流
- Harness 可以回退到某个时刻之前重新读取上下文
- Context 管理策略（compaction、cache hit 优化等）由 Harness 决定，Session 只保证数据不丢

---

## Many Brains, Many Hands

- **多 Brain**：一个会话可以按需连接多个 Sandbox（VPC 里的、云端的），不再需要网络对等连接
- **多 Hand**：Claude 可以同时操作多个执行环境——容器、手机、任何实现 `execute(name, input) → string` 的东西
- **Brain 之间可以传递 Hand**——不同的 agent 可以共享 sandbox

---

## API 层面的核心概念

| 概念 | 描述 |
|------|------|
| **Agent** | 模型 + system prompt + tools + MCP servers + skills 的配置 |
| **Environment** | 容器模板（预装包、网络规则、挂载文件） |
| **Session** | 在某个 Environment 中运行的 agent 实例 |
| **Events** | 用户消息、工具结果、状态更新（SSE 流式推送） |

### 使用流程

1. 创建 Agent（定义模型、提示、工具）
2. 创建 Environment（配置容器）
3. 启动 Session
4. 发送事件，通过 SSE 接收流式响应
5. 可随时发事件引导方向或中断

---

## 内置工具

- **Bash** —— 在容器中执行 shell 命令
- **File operations** —— 读写编辑文件、glob、grep
- **Web search & fetch** —— 搜索和抓取网页
- **MCP servers** —— 连接外部工具

---

## 与 wzxClaw 的关系

Managed Agents 的架构思路和 wzxClaw 有几个直接对应：

| Managed Agents | wzxClaw 现状 |
|----------------|-------------|
| Brain = Harness loop | `src/main/agent/agent-loop.ts` |
| Hands = Sandbox (云端容器) | 本地文件系统 + Bash |
| Session = 持久化事件日志 | `session-store.ts` (JSONL) |
| Context 管理 (compaction) | 已有 80% context 阈值压缩 |
| MCP 工具代理 | MCP 代码完成但未激活 |

### 值得借鉴的点

1. **Brain/Hands 解耦**——wzxClaw 当前 agent loop 和执行环境是耦合的，未来如果需要支持远程执行（手机端、远程服务器），需要类似解耦
2. **Session 作为持久 context 对象**——wzxClaw 的 JSONL session 已经在做这件事，但 `getEvents()` 按位置切片查询的能力可以加强
3. **Harness 无状态化**——当前 agent loop 如果崩溃，会话恢复机制可以参考 `wake(sessionId)` 模式
4. **安全边界**——凭证永远不在 sandbox 里暴露，这对 wzxClaw 的 API key 管理有参考价值

---

## Beta 状态

- 需要 `managed-agents-2026-04-01` beta header
- SDK 自动设置
- 所有 API 账户默认开启
- 部分功能（outcomes、multiagent、memory）仍在 research preview

---

## Sources

- [Scaling Managed Agents: Decoupling the brain from the hands - Anthropic Engineering Blog](https://www.anthropic.com/engineering/managed-agents)
- [Claude Managed Agents overview - Official API Docs](https://platform.claude.com/docs/en/managed-agents/overview)
- [Anthropic's New Product Aims to Handle the Hard Part of Building AI - Wired](https://www.wired.com/story/anthropic-launches-claude-managed-agents/)
- [Anthropic's Claude Managed Agents gives enterprises a new one-stop shop - VentureBeat](https://venturebeat.com/orchestration/anthropics-claude-managed-agents-gives-enterprises-a-new-one-stop-shop-but)
- [Claude Managed Agents: Anthropic's Play to Own Agent Infrastructure - Till Freitag](https://till-freitag.com/blog/claude-managed-agents)
