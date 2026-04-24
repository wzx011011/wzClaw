# Agent = Model + System Prompt + Tools + MCP + Skills 的演化时间线

这个公式不是某一天突然定义的，而是经历了 **5 个阶段、2 年时间**，每一层都是为了解决上一层的痛点而加上的。

---

## Phase 1: 只有 Model + System Prompt (2023)

这是最原始的形态——往 chat API 塞一坨 system prompt，希望模型按指令行事。

- Anthropic 从一开始就在 Messages API 里设计 system prompt 字段
- 但模型只能**输出文字**，不能采取行动
- 典型用法：`system: "你是一个有帮助的助手"` → 模型回答问题

**局限**：模型是"光说不做"的，没有任何行动能力。

---

## Phase 2: + Tools / Function Calling (2024 年 3-4 月)

| 时间 | 事件 |
|------|------|
| **2024.03** | Claude 3 发布，同时推出 **tool use beta** (function calling) |
| **2024.07** | 扩展 tool use 文档和功能 |
| **2024.10.22** | **Computer Use beta** — Claude 3.5 Sonnet 成为首个能控制桌面 GUI 的前沿模型 |
| **2024.12** | **Programmatic Tool Calling (PTC)** — 支持并行执行、代码级编排工具调用 |

这一层解决的核心问题：**让模型能行动**。

API 层面，tool use 的模式是：
```
用户消息 → 模型返回 tool_use block → 开发者执行工具 → 返回 tool_result → 模型继续
```

但这只是**原语**——开发者需要自己写 agent loop、自己管理消息历史、自己处理重试。Anthropic 的 [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)（2024.12.19）这篇文章定义了 6 种 agent 模式（Prompt Chaining、Routing、Parallelization、Orchestrator-Workers、Evaluator-Optimizer、Autonomous Agent），但这些都是**架构模式**，不是产品。

**局限**：每个开发者都在重复造 agent loop 和工具执行层的轮子。

---

## Phase 3: + MCP / Model Context Protocol (2024.11)

| 时间 | 事件 |
|------|------|
| **2024.11.25** | Anthropic 发布 **MCP** 开源协议 |

MCP 解决的核心问题：**工具连接的标准化**。

在 MCP 之前，每个工具都是自定义集成的——你要写一个天气插件、一个数据库插件、一个 GitHub 插件，每个都有自己的接入方式。MCP 统一了这些：

```
AI 应用 (MCP Client) ←→ MCP 协议 ←→ 工具服务器 (MCP Server)
```

支持 stdio / SSE / HTTP / WebSocket 等多种传输方式。

MCP 的设计哲学是：**工具定义由 server 提供，AI 客户端不需要预先知道有哪些工具**。这是一个关键转变——从"开发者硬编码工具列表"到"动态发现工具"。

**局限**：MCP 解决了工具连接问题，但没有解决 **context 膨胀**问题——加载 20 个 MCP server 的工具定义可能消耗数万 token。

---

## Phase 4: Claude Code 作为 Harness (2025.02-10)

| 时间 | 事件 |
|------|------|
| **2025.02.24** | **Claude Code** 作为 research preview 发布（随 Claude 3.7 Sonnet） |
| **2025.05.25** | **Claude 4** 发布，Claude Code 升级到 v1.0 |
| **2025.06.12** | Plan mode 加入 (~v1.0.18) |
| **2025.08.20** | `/context` 命令加入 (v1.0.86) |

这一层解决的核心问题：**把 model + prompt + tools + session 组装成一个可用的 harness**。

Claude Code 的关键贡献是把之前散落的组件**组装成一个完整的 agent runtime**：

```
Claude Code (Harness) =
  Claude 模型
  + 复杂的 system prompt（包含工具使用规范、代码风格指南、git 工作流等）
  + 16+ 内置工具（FileRead/Write/Edit, Bash, Grep, Glob, Agent, Browser...）
  + MCP 客户端（连接外部工具）
  + CLAUDE.md 记忆文件（项目级 + 用户级）
  + Session 持久化（JSONL）
  + 6 层 context compaction 管线
  + 权限系统（4 级）
```

但在这个阶段，**Agent 的概念还没有被正式定义为 API 层面的实体**。Claude Code 是一个产品，不是一个配置对象。

**局限**：每个 harness 都是硬编码的——用户无法自定义 system prompt、无法添加新类型的工具、无法定义"能力包"。

---

## Phase 5: + Skills / 渐进式上下文披露 (2025.10)

| 时间 | 事件 |
|------|------|
| **2025.10.16-17** | **Claude Skills** 在 Claude Code v2.0.22 中推出 |
| **2025.12.18** | **Agent Skills** 作为开源标准发布 |

Skills 解决的核心问题：**如何在不膨胀主 prompt 的前提下扩展 Agent 能力**。

这是一个精妙的设计：

```
Skills 的运行机制：
1. 注册阶段：只有 name + description 注入工具定义（几行文字）
2. 触发阶段：Claude 判断需要某个 skill → 发出 tool_use
3. 展开阶段：SKILL.md 全文 + 脚本路径注入 context
4. 执行阶段：Claude 按展开后的指令行动
```

这解决了 MCP 的 context 膨胀问题——20 个 MCP server 的工具定义可能占 50k token，但 20 个 Skills 只占几百 token（只有名字和描述）。Claude 按需加载，用完不占空间。

Skills 的具体结构：

```
.claude/skills/
├── pdf/
│   ├── SKILL.md          # name + description (frontmatter) + 指令 (body)
│   ├── extract_text.py   # 辅助脚本
│   └── templates/
│       └── summary.html
└── csv/
    ├── SKILL.md
    ├── analyze.py
    └── utils/
        ├── parser.py
        └── visualizer.py
```

运行时通过 `Skill` tool 调用：
1. Claude 判断需要某 skill → `tool_use: { command: "pdf" }`
2. 系统返回 `SKILL.md` 全文 + base path
3. Claude 按展开后的指令使用 `extract_text.py` 等脚本

---

## Phase 6: Managed Agents 正式定义 Agent 配置对象 (2026.04)

| 时间 | 事件 |
|------|------|
| **2026.04.08** | **Claude Managed Agents** 公共 Beta 发布 |

到这一步，Anthropic 终于在 API 层面**正式定义了 Agent 作为一等对象**：

```typescript
Agent = {
  model: "claude-sonnet-4-6-20250514",       // 模型
  system_prompt: "...",                        // system prompt
  tools: ["bash", "file", "web_search"],       // 内置工具
  mcp_servers: [{ url: "...", tools: [...] }], // MCP 工具
  skills: ["pdf", "csv", "deploy"]             // Skills
}
```

这不是一个新的"功能"——而是把过去两年逐步形成的所有组件**统一成一个配置接口**，然后托管运行。

---

## 演化总结图

```
2023                    2024                         2025                      2026
  |                       |                            |                         |
  |  Model + Prompt       |                            |                         |
  |  (只能聊天)            |                            |                         |
  |         --------------+-- + Tool Use (03)          |                         |
  |                       |    + Computer Use (10)      |                         |
  |                       |    + PTC (12)               |                         |
  |         --------------+--------- -------------------+-- Claude Code (02)     |
  |                       |         -------------------+-- + MCP 连接 (02+)     |
  |                       |    + MCP Protocol (11)      |         ---------------+-- Managed Agents
  |                       |                            |    + Skills (10)         |    正式定义 Agent
  |                       |                            |    Agent Skills std (12) |    配置对象
  |                       |                            |                         |
  v                       v                            v                         v
聊天助手 ──→ 工具调用者 ──→ 标准化连接 ──→ 完整 Harness ──→ 渐进扩展 ──→ 托管 Agent 服务
```

---

## 每一层的添加动机

| + 这一层 | 因为上一层有什么问题 |
|----------|---------------------|
| + Tools | 模型只能说话，不能行动 |
| + MCP | 工具连接没有标准，每个都自定义 |
| + Harness (Claude Code) | 开发者重复造 agent loop 轮子 |
| + Skills | MCP 工具定义太大，撑爆 context |
| + Managed Agents | 自建 harness 太复杂，直接托管 |

所以 `Agent = model + system prompt + tools + MCP servers + skills` 这个公式本质上是 **Anthropic 两年迭代的压缩总结**——每加一个组件，都是为了解决前一层留下的缺口。

---

## Sources

- [Building Effective AI Agents - Anthropic (2024.12.19)](https://www.anthropic.com/research/building-effective-agents)
- [Introducing Computer Use - Anthropic (2024.10.22)](https://www.anthropic.com/news/3-5-models-and-computer-use)
- [Claude Managed Agents Overview - Official Docs](https://platform.claude.com/docs/en/managed-agents/overview)
- [Claude Code Skills - Mikhail.io (2025.10)](https://mikhail.io/2025/10/claude-code-skills/)
- [Reflections of Claude Code from CHANGELOG - DEV Community](https://dev.to/oikon/reflections-of-claude-code-from-changelog-833)
- [Three Years of AI Agent Architecture Evolution - Medium](https://medium.com/ai-simplified-in-plain-english/three-years-of-ai-agent-architecture-evolution-from-static-prompts-to-intelligent-skills-30e04d5abe58)
- [Claude Skills - Simon Willison (2025.10.16)](https://simonwillison.net/2025/Oct/16/claude-skills/)
- [Scaling Managed Agents - Anthropic Engineering Blog](https://www.anthropic.com/engineering/managed-agents)
