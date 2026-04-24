# 06-Context Management — 贯穿所有阶段的隐形线索

## 1. 概述

Context Window（上下文窗口）是 AI Agent 的 **工作记忆**——有限、珍贵、不可回避的约束。模型每次调用只能看到 Context 内的内容，超出窗口的信息等于不存在。

Agent Loop 的核心挑战不是 "让模型更聪明"，而是 **在有限的 Context 中管理无限的任务复杂度**。

```
Human Analogy:
  长期记忆  ≈ Session 存储（磁盘上的 JSONL 文件）
  工作记忆  ≈ Context Window（每次调用的 messages 数组）
  注意力切换 ≈ Context 压缩（丢弃旧信息，保留关键摘要）
```

**为什么 Context 管理如此重要：**

- Context 爆炸 → 超出 token 限制 → API 报错 → Agent 崩溃
- 信息丢失 → 过早压缩丢弃关键信息 → 输出不一致
- 成本失控 → 冗余信息重复发送 → 费用飙升
- 质量下降 → 注意力被噪声稀释 → 关键指令被淹没

## 2. Agent Loop 中的位置

Context 管理发生在 **每次模型调用之前**，是 Loop 体内最重要的预处理步骤。

```typescript
while (!done && turns < MAX_TURNS) {
  // ═══ Context Management Pipeline ═══
  messages = trimToolResults(messages)     // 1. 裁剪工具输出
  messages = snipCompact(messages)         // 2. 移除旧回合
  messages = microCompact(messages)        // 3. 摘要工具密集区
  messages = autoCompact(messages)         // 4. 超阈值全量摘要
  messages = applyCaching(messages)        // 5. 缓存优化

  response = await callModel(messages, tools)

  if (response.error === 'prompt-too-long') {
    messages = reactiveCompact(messages)   // 6. 紧急压缩
    response = await callModel(messages, tools)  // 重试
  }
}
```

关键：Context 管理不是一次性操作，而是每次迭代都执行的管线。对话越长，压缩力度越大。

## 3. Context 窗口的约束

### 3.1 硬性限制

```
模型              Context    输出上限    价格(input/output)
Claude 4 Sonnet   200K       16K       $3 / $15 per MTok
GPT-4o            128K       16K       $2.5 / $10
DeepSeek V3       128K        8K       $0.27 / $1.1
```

### 3.2 200K tokens 的实际空间

```
200K tokens 实际可用空间：
├── System prompt        -15K  (工具定义 + 系统指令 + CLAUDE.md)
├── Tool definitions     -10K  (16 个内置工具 schema)
├── MCP tools            -10K  (可选，每个 server 2-5K)
├── Conversation       ~150K  ← 主要空间，但工具输出是大头
└── Safety buffer        -13K

→ 实际可用 ~130-150K tokens
→ 25 轮复杂对话 ≈ 100-200K tokens（含工具输出）
→ 必须压缩才能完成复杂任务
```

### 3.3 Token 计数

```typescript
function countTokens(messages: Message[], tools: ToolDef[]): number {
  let total = estimateTokens(systemPrompt)
  for (const tool of tools) total += estimateTokens(JSON.stringify(tool))
  for (const msg of messages) {
    total += 4  // 每条消息固定开销
    for (const block of msg.content) {
      total += estimateTokens(block.text ?? JSON.stringify(block))
    }
  }
  return total
}
// 粗略规则：1 token ≈ 4 英文字符 或 1-2 个汉字
```

## 4. 六层压缩管线

从轻量到激进逐层升级，每层解决不同问题。

```
Layer 1: Tool Result Budget — 截断单个工具输出（无额外 API 调用）
Layer 2: Snip Compact — 移除最旧 N 个回合（无额外 API 调用）
Layer 3: Microcompact — 摘要连续工具调用块（小型 API 调用）
Layer 4: Context Collapse — 细粒度折叠 + commit-log 保留（中型 API 调用）
Layer 5: Auto-compact — fork 子 Agent 全量摘要（一次完整 API 调用）
Layer 6: Reactive Compact — prompt-too-long 错误后的紧急兜底
```

### 4a. Layer 1: Tool Result Budget

裁剪单个工具输出的体积，最轻量最常用。

```typescript
const TOOL_BUDGETS = { FileRead: 50000, Bash: 30000, Grep: 20000, Glob: 5000 }

async function trimToolResult(result: ToolResult, toolName: string): Promise<ToolResult> {
  const budget = TOOL_BUDGETS[toolName] ?? 25000
  if (estimateTokens(result.content) <= budget) return result
  const maxChars = Math.floor(result.content.length * budget / estimateTokens(result.content))
  return { ...result, content: result.content.slice(0, maxChars) + '\n[truncated]' }
}
// FileRead 返回 2000 行 ≈ 60K tokens → 截断到 ~1666 行 → 一次节省 10K tokens
```

### 4b. Layer 2: Snip Compact

移除最旧的对话回合，简单粗暴但有效。

```typescript
function snipCompact(messages: Message[], keepRecent: number = 6): Message[] {
  const turns = splitIntoTurns(messages)
  if (turns.length <= keepRecent) return messages
  const kept = turns.slice(-keepRecent)
  return [{ role: 'user', content: `[${turns.length - keepRecent} earlier turns compacted]` }, ...kept.flat()]
}
```

### 4c. Layer 3: Microcompact

将连续多轮工具调用压缩为自然语言摘要。

```
原始 (8 轮, ~3K tokens):
  FileRead("auth.ts") → FileRead("auth.test.ts") → Grep("import.*auth")
  → FileRead("middleware.ts") → Bash("npm test") → FileWrite("auth.ts") → FileWrite("auth.test.ts")

压缩后 (~100 tokens):
  "Read auth.ts, auth.test.ts, middleware.ts. Found 15 files importing auth.
   Ran tests (passed). Rewrote auth.ts with new token validation. Updated tests."
```

```typescript
async function microCompact(messages: Message[], threshold = 5): Promise<Message[]> {
  // 检测连续 5+ 轮工具调用 → 用廉价模型生成 2-3 句摘要替换
  // 保留首尾非工具消息，中间的工具密集区压缩为 [Context compacted: summary]
}
```

### 4d. Layer 4: Context Collapse

细粒度折叠，以 commit-log 风格保留关键操作记录。

```
20 轮对话 (~50K tokens) 压缩为：
  [Turns 1-6: Built feature X. Read auth.ts, user.ts, routes.ts.
   Created feature_x.ts. Tests failed → fixed null check. Tests passed.]
  turn 7-10: 完整保留（最近操作）
→ ~5K tokens
```

### 4e. Layer 5: Auto-compact（最重要）

当 Context 接近阈值时，fork 子 Agent 生成摘要替换旧消息。

```typescript
async function autoCompact(messages: Message[], maxTokens: number): Promise<Message[]> {
  const current = countTokens(messages)
  if (current < maxTokens * 0.8) return messages  // 80% 以下不触发

  const recentCount = Math.min(messages.length, 6)
  const toCompress = messages.slice(0, -recentCount)
  const toKeep = messages.slice(-recentCount)

  // Fork 子 Agent（无工具，纯文本生成，用最便宜的模型）
  const summary = await forkSubagent({
    task: "Summarize this conversation. Preserve: key decisions, file changes, error states.",
    context: toCompress,
    maxTokens: 2000,
    maxTurns: 1,
    tools: []
  })

  return [
    { role: 'user', content: `[Auto-compacted]\n${summary}` },
    ...toKeep
  ]
  // 目标：从 80%+ 降回 40-50%
}
```

好的摘要示例：列出文件变更、决策、错误状态、待办事项。差的摘要：丢失所有语义。

### 4f. Layer 6: Reactive Compact

API 返回 prompt-too-long 错误后的紧急兜底。激进丢弃旧消息，只保留最近 2 轮 + system prompt，然后重试。

## 5. Prompt Caching

LLM API 支持相同前缀缓存命中，大幅降低延迟和成本。

```
请求 1: [System Prompt | Tool Defs | CLAUDE.md | Msg 1 | Msg 2]
         ←─ cached ──→                          ←─ new ──→

请求 2: [System Prompt | Tool Defs | CLAUDE.md | Msg 1 | Msg 2 | Msg 3]
         ←─ cached ──────────────────────────→                    ←─ new ──→
```

优化策略：将静态前缀（system prompt + tool defs）标记 `cache_control`，对话消息作为动态后缀。

```
无缓存: 200K × $3/MTok = $0.60/request → 25 轮 = $15/task
有缓存(90% 命中): ~$0.114/request → 25 轮 = $2.85/task → 节省 ~80%
```

## 6. Session vs Context Window

```
┌──────────── Session 层 ────────────┐  ┌──── Context Window 层 ───────────┐
│ Append-only 事件日志                │  │ 易失性视图（volatile view）       │
│ 磁盘 JSONL 文件，无大小限制          │  │ 每次 API 调用时构造              │
│ 跨会话持久保存                      │  │ 受限（200K tokens）              │
│ 完整记录，不遗漏                    │  │ 可被压缩/摘要，信息可能丢失       │
│ Source of Truth                    │  │ Current Working Set             │
│ 操作: getEvents(), append()        │  │ 操作: compress(), trim()        │
└────────────────────────────────────┘  └──────────────────────────────────┘
```

Session 保证完整性（所有事件记录在磁盘），Context Window 保证时效性（当前工作集）。Harness 可以通过 `session.getEvents()` 从 Session 恢复被压缩丢失的信息，代价是额外的 API 调用。

## 7. Context 预算分配

```
200K Total Context Budget:
├── System Prompt       ~10-15K (5-7%)   — 基础指令 + CLAUDE.md + Memory
├── Tool Definitions    ~10-60K (5-30%)  — 内置工具 + MCP Server schemas
│   ⚠️ MCP 是 Context 膨胀的主要来源！
├── Conversation        ~100-140K (50-70%) — 用户消息 + 模型回复 + 工具结果
│   └── 工具结果是最大消耗者
└── Safety Buffer       ~13K             — 输出 token 和格式开销
```

不同场景：
- 简单对话（无工具）：~45K (22%) → 无需压缩
- 中等任务（5 轮工具）：~85K (42%) → Layer 1-2
- 复杂任务（15 轮 + MCP）：~165K (82%) → Layer 1-5 全开
- 大型重构 + 多 MCP：~215K（超限）→ 必须减少 MCP tools 或频繁 auto-compact

## 8. wzxClaw 实现状态

```
├── Tool Result Budget     ✅ 各工具独立预算
├── Snip Compact           ✅ 保留最近 N 轮
├── Microcompact           ⚠️ 基础实现
├── Context Collapse       ❌ 未实现
├── Auto-compact           ✅ 80% 阈值触发，fork 子 Agent
├── Reactive Compact       ⚠️ prompt-too-long 重试
├── Prompt Caching         ❌ cache_control 未标记
├── Session 存储            ✅ JSONL append-only
├── Token 计数              ⚠️ 估算（非精确 tokenizer）
└── 预算分配器              ❌ 无动态工具裁剪
```

优化路线：
- Phase 2: Microcompact 增强 + Prompt Caching + tiktoken 精确计数
- Phase 3: Context Collapse + 动态工具裁剪 + Session 恢复
- Phase 4: 预算可视化 UI + 手动压缩控制 + 可配置压缩策略

## 9. 核心原则

```
1. 宁可早压，不要晚压 — 80% 主动压缩 > 95% 被迫压缩
2. 保留决策相关信息 — 文件路径、变量名、用户偏好必须保留
3. Session 是 Source of Truth — Context 可丢，Session 不能丢
4. 静态前缀，动态后缀 — System prompt 构成缓存友好前缀
5. 工具输出是最大膨胀源 — Tool Result Budget 是第一道防线
6. 压缩不可逆但可恢复 — 通过 Session 回放恢复丢失信息
```
