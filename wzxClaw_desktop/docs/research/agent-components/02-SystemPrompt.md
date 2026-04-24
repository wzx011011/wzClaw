# System Prompt -- Agent 的身份、规则与上下文注入

## 1. 概述

System Prompt 是 Agent 的「人格 + 规则 + 上下文」集合。它告诉 LLM：你是谁、你能做什么、你该遵守什么规则、当前项目有什么特殊指令。每次 Agent Loop 启动时，System Prompt 在所有用户消息之前注入，作为整个对话的「系统级指令」。

在 Claude Code 架构中，System Prompt 不是一坨静态文本，而是由多个来源动态组装的，分为**静态部分**（跨 turn 不变，可被 prompt cache 缓存）和**动态部分**（每次可能变化）。

---

## 2. Agent Loop 中的位置

```typescript
async function* agentLoop(userMessage, config) {
  // 0. 追加用户消息
  conversation.appendUserMessage(userMessage)

  // 1. ★ 构建系统提示（每次 run() 调用一次）★
  const systemPrompt = await buildSystemPrompt(config, activeTask)

  // 2. 获取工具定义（独立于 system prompt 文本）
  const toolDefinitions = toolRegistry.getDefinitions()

  // 3. 主循环
  for (let turn = 0; turn < maxTurns; turn++) {
    turnResult = yield* executeTurn({
      systemPrompt,        // ← 注入到每轮 LLM 调用
      toolDefinitions,     // ← 作为 tools 参数传入（不在 prompt 文本中）
      messages,
    })
  }
}
```

关键点：
- `systemPrompt` 在 `run()` 开始时构建一次，所有 turn 共享
- `toolDefinitions` 单独作为 `tools` 参数传给 API，不在 prompt 文本中重复
- 如果需要更新 system prompt（如任务变更），需要重新调用 `buildSystemPrompt()`

---

## 3. System Prompt 组装流程

### 3.1 组装架构

```
buildSystemPrompt(config, activeTask)
│
├── config.systemPrompt          ← 静态基础指令（由上层传入，包含身份、能力、约束）
│
├── <!-- CACHE_BOUNDARY -->       ← 缓存分割线
│
├── buildEnvInfo()               ← 运行时环境（OS、shell、model、workspace 路径）
├── getGitContext()               ← Git 上下文（当前分支、远程仓库、最近提交）
├── loadInstructions()           ← 项目指令（WZXCLAW.md 加载链）
├── MemoryManager.buildSection() ← MEMORY.md 自动记忆
└── buildTaskContext()           ← 活跃任务上下文（如有）
```

### 3.2 实际代码结构

```typescript
async function buildSystemPrompt(config, activeTask?): Promise<string> {
  // 并行加载所有动态上下文段
  const [gitContext, instructionSection, memorySection] = await Promise.all([
    getGitContext(config.workingDirectory).catch(() => ''),
    loadInstructions(config.workingDirectory).catch(() => ''),
    activeTask
      ? new MemoryManager(activeTask.id).buildSystemPromptSection().catch(() => '')
      : Promise.resolve(''),
  ])

  // 构建环境信息
  const envInfo = buildEnvInfo({
    model: config.model,
    provider: config.provider,
    workingDirectory: config.workingDirectory,
  })

  // 组装动态部分
  const dynamicParts = [envInfo]
  if (gitContext)          dynamicParts.push(gitContext)
  if (instructionSection)  dynamicParts.push(instructionSection)
  if (memorySection)       dynamicParts.push(memorySection)
  if (activeTask)          dynamicParts.push(buildTaskContext(activeTask))

  // 拼接：静态 + 缓存边界 + 动态
  return config.systemPrompt + CACHE_BOUNDARY + dynamicParts.join('\n\n')
}
```

### 3.3 最终输出结构

```
┌─────────────────────────────────────────────┐
│ 静态部分 (config.systemPrompt)                │
│                                               │
│ "You are an expert software engineer..."     │
│ 身份 + 能力 + 工具使用规则 + 代码风格指南       │
│ Git 工作流规则 + 安全约束                       │
│                                               │
│ cache_control: { type: 'ephemeral' }  ← BP1  │
├─────────────────────────────────────────────┤
│ <!-- CACHE_BOUNDARY -->                       │
├─────────────────────────────────────────────┤
│ 动态部分                                      │
│                                               │
│ ## Environment                                │
│ OS: Windows 10, Shell: bash, Model: deepseek  │
│ Working Directory: E:\ai\wzxClaw              │
│                                               │
│ ## Git Context                                │
│ Branch: master, Remote: origin                │
│ Recent commits: b515f1c chore: redesign icon  │
│                                               │
│ ## Project Instructions                       │
│ ── (来自 ~/.wzxclaw/WZXCLAW.md) ──           │
│ ── (来自 E:\ai\wzxClaw\WZXCLAW.md) ──        │
│ ── (来自 .wzxclaw/rules/*.md) ──             │
│ ── (来自 ~/.wzxclaw/commands/*.md) ──        │
│ ── (来自 ~/.wzxclaw/skills/*.md) ──          │
│                                               │
│ ## Memory                                     │
│ ── (来自 MEMORY.md) ──                       │
│                                               │
│ # Active Task                                 │
│ **任务标题**                                   │
│ Mounted Projects: ...                         │
└─────────────────────────────────────────────┘
```

---

## 4. 各组成段详解

### 4.1 基础指令 (config.systemPrompt)

这是 Agent 的「出厂设置」，包含：

| 类别 | 内容示例 |
|------|---------|
| 身份 | "You are an expert software engineer" |
| 能力 | "You can read/write files, execute commands, search code" |
| 约束 | "Always prefer editing existing files over creating new ones" |
| 工具规则 | "Use Grep for searching, not Bash grep" |
| 代码风格 | "Use TypeScript, follow existing patterns" |
| Git 规则 | "Prefer creating new commits over amending" |

这段文本在应用层硬编码，所有 turn 共享，是 prompt caching 的最佳候选。

### 4.2 环境信息 (buildEnvInfo)

```typescript
function buildEnvInfo({ model, provider, workingDirectory }) {
  return `
## Environment
- OS: ${os.platform()} ${os.release()}
- Shell: ${process.env.SHELL ?? 'powershell'}
- Language: ${process.env.LANG}
- Current Model: ${model}
- Provider: ${provider}
- Working Directory: ${workingDirectory}
- Current Date: ${new Date().toISOString().split('T')[0]}
`.trim()
}
```

作用：让 LLM 知道运行环境，生成正确的命令（Windows 用 `dir` 而非 `ls`，路径用反斜杠等）。

### 4.3 Git 上下文 (getGitContext)

```typescript
async function getGitContext(workingDir: string): Promise<string> {
  // 执行 git status, git log, git remote 等命令
  // 返回格式化的 git 上下文信息
  return `
## Git Context
- Branch: master
- Remote: origin → git@github.com:user/repo.git
- Status: 2 modified, 1 untracked
- Recent commits:
  - b515f1c chore: redesign icon
  - 49f9ba6 chore: update desktop icon
  `.trim()
}
```

作用：LLM 生成 commit message 时参考最近的提交风格，避免破坏性 git 操作。

### 4.4 项目指令 (loadInstructions)

这是最复杂的加载链，从多个位置合并项目级指令：

```
加载优先级（从低到高）:

1. ~/.wzxclaw/WZXCLAW.md            ← 全局用户偏好
2. 父目录 WZXCLAW.md                 ← 组织/monorepo 级指令
3. {workspace}/WZXCLAW.md            ← 项目根指令
4. {workspace}/.wzxclaw/WZXCLAW.md   ← 隐藏项目指令
5. {workspace}/.wzxclaw/rules/*.md   ← 拆分规则文件（按文件名字母序）
6. {workspace}/WZXCLAW.local.md      ← 本地覆盖（gitignored）
7. ~/.wzxclaw/commands/*.md          ← 用户自定义命令
8. ~/.wzxclaw/skills/*.md            ← 用户自定义技能
```

所有找到的文件通过 `---` 分隔符合并，支持 `@include` 指令引用外部文件：

```markdown
# 项目根 WZXCLAW.md
## 命名规范
- 组件用 PascalCase
@include ./conventions/naming-rules.md
```

---

## 5. Prompt Caching -- 结构化缓存

### 5.1 为什么需要缓存分割

Anthropic 的 Prompt Caching 对「完全相同的前缀」生效。如果把所有内容放在一起，任何一个动态部分变化都会导致缓存失效。因此将 prompt 分为：

- **静态前缀**：每次 run() 相同的内容（基础指令）→ 高缓存命中率
- **动态后缀**：每次可能变化的内容（env, git, instructions）→ 不缓存

### 5.2 缓存断点分布

```
Anthropic API 请求中的缓存标记:

system: [
  { text: "静态部分...", cache_control: { type: 'ephemeral' } }  ← BP1
  { text: "动态部分..." }                                          // 不缓存
]

tools: [
  ..., { name: "TodoWrite", cache_control: { type: 'ephemeral' } } ← BP2
]

messages: [
  ..., { role: "user", content: [{ text: "...", cache_control: { type: 'ephemeral' } }] }  ← BP3
]
```

| 断点 | 位置 | 缓存内容 | 预期命中率 |
|------|------|---------|-----------|
| BP1 | system prompt 静态块 | 基础指令 | 同一 run() 内 100% |
| BP2 | 最后一个 tool definition | 工具定义 | 跨 turn 100% |
| BP3 | 倒数第二个 user message | 对话历史 | 多轮对话中逐轮增长 |

### 5.3 缓存效果

```
首次调用:
  input_tokens: 15234     → 按 $3/MTok 计费
  cache_write: 15234      → 按 $3.75/MTok 计费（+25% 写入成本）

后续调用（缓存命中）:
  cache_read: 12000       → 按 $0.30/MTok 计费（90% 折扣）
  input_tokens: 3234      → 新增内容，按 $3/MTok 计费

节省: (15234 - 12000) * $3 - 12000 * $2.7 = ~$27/1000 turns
```

---

## 6. 动态注入 -- 运行时上下文追加

### 6.1 Memory 文件加载

Memory 系统在 system prompt 中注入项目记忆：

```
两层记忆结构:
  全局: ~/.wzxclaw/MEMORY.md         ← 跨项目偏好
  项目: ~/.wzxclaw/projects/{hash}/memory/MEMORY.md  ← 项目级记忆

合并规则:
  - 总行数限制 200 行
  - 超限时优先截断全局记忆
  - 由 MemoryManager 自动管理
```

### 6.2 Turn Attachment 注入

除了 system prompt，每轮 turn 还会注入额外的上下文：

```typescript
// TurnManager.executeTurn() 内部
if (turnIndex > 0) {
  // 注入上一轮文件变更信息
  const attachmentText = buildTurnAttachments({
    filesRead: ['src/main/llm/gateway.ts'],
    filesWritten: ['src/main/agent/agent-loop.ts'],
  })
  // 作为 system reminder 追加到 messages 中
  conversation.appendSystemReminder(attachmentText)
}
```

这不在 system prompt 中，而是作为消息历史的一部分注入，让 LLM 知道最近读写过哪些文件。

### 6.3 MCP 工具注入

MCP（Model Context Protocol）工具在运行时动态添加：

```
启动时:
  1. 读取 ~/.wzxclaw/mcp.json
  2. 连接 MCP servers
  3. 获取每个 server 的 tool definitions
  4. 注入到 ToolRegistry
  5. 工具描述随 toolDefinitions 传给 API（不在 prompt 文本中）

MCP 工具命名: mcp_{serverName}_{toolName}
  例: mcp_github_create_issue
```

### 6.4 完整注入时序

```
Agent Loop 启动
│
├── buildSystemPrompt()
│   ├── [静态] config.systemPrompt           ← 硬编码基础指令
│   ├── [动态] buildEnvInfo()                ← OS/Shell/Model/Date
│   ├── [动态] getGitContext()               ← Git 状态
│   ├── [动态] loadInstructions()            ← WZXCLAW.md 全链加载
│   │   ├── ~/.wzxclaw/WZXCLAW.md
│   │   ├── 父目录 WZXCLAW.md
│   │   ├── {workspace}/WZXCLAW.md
│   │   ├── .wzxclaw/WZXCLAW.md
│   │   ├── .wzxclaw/rules/*.md
│   │   ├── WZXCLAW.local.md
│   │   ├── ~/.wzxclaw/commands/*.md
│   │   └── ~/.wzxclaw/skills/*.md
│   ├── [动态] MemoryManager.buildSection()  ← MEMORY.md
│   └── [动态] buildTaskContext()            ← 活跃任务
│
├── toolRegistry.getDefinitions()
│   ├── 内建工具 (16 个)
│   └── MCP 工具 (动态加载)
│
└── 每个 Turn:
    └── buildTurnAttachments()               ← 文件变更记录
```

---

## 7. 设计要点总结

| 设计决策 | 原因 |
|---------|------|
| 静态/动态分离 | 最大化 Prompt Caching 命中率 |
| 并行加载所有动态段 | `Promise.all()` 减少 buildSystemPrompt 耗时 |
| `.catch(() => '')` 静默失败 | 任何上下文段缺失都不应阻断 Agent 启动 |
| 工具定义独立于 prompt 文本 | 避免重复占用 token，API 原生支持 tools 参数 |
| 多来源指令合并 | 支持全局、组织、项目、本地多级覆盖 |
| `@include` 指令 | 大型项目可将规则拆分到多个文件 |
| Turn Attachment | 让 LLM 感知自身操作历史，避免重复读写 |
