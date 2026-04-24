# Model -- Agent Loop 中的 LLM 调用

## 1. 概述

在 AI Agent 架构中，**Model** 不是指一个数据结构，而是指「调用 LLM API 获取下一段输出」这一核心动作。Agent Loop 的每一轮 turn 都会调用一次 Model，拿到文本回复或工具调用指令，然后决定继续循环还是终止。

可以把 Model 理解为 Agent 的「大脑」——它接收当前对话上下文（messages + system prompt + tool definitions），返回下一步该做什么。

---

## 2. Agent Loop 中的位置

```
async function* agentLoop(userMessage, config) {
  // 0. 初始化
  conversation.appendUserMessage(userMessage)
  systemPrompt = await buildSystemPrompt(config)   // 构建系统提示

  // 1. 主循环
  for (let turn = 0; turn < maxTurns; turn++) {

    // 2. 上下文压缩检查
    if (shouldCompact(messages)) { compact(messages) }

    // 3. ★ 调用 Model（核心）★
    turnResult = yield* executeTurn({
      systemPrompt,
      messages,
      tools: toolDefinitions,
      model: config.model,
    })

    // 4. 累计 token 用量
    totalUsage += turnResult.usage

    // 5. 判断是否结束
    if (turnResult.shouldStop) {
      yield { type: 'agent:done', usage: totalUsage }
      return
    }

    // 6. 工具结果已追加到 messages，继续下一轮
  }
}
```

第 3 步 `executeTurn` 内部调用 LLM Gateway，后者路由到对应的 SDK Adapter，发起流式请求。

---

## 3. 流式调用机制

LLM API 以 **SSE（Server-Sent Events）** 方式返回数据。SDK 将其封装为 `AsyncGenerator`，调用方用 `for await...of` 逐块消费。

### 3.1 Anthropic SDK 流式调用

```typescript
// AnthropicAdapter.stream() 核心逻辑
const stream = this.client.messages.stream({
  model: options.model,          // e.g. "claude-sonnet-4-20250514"
  max_tokens: options.maxTokens ?? 8192,
  messages: providerMessages,
  system: systemContent,         // 带缓存标记的 system blocks
  tools: normalizedTools,
})

for await (const event of stream) {
  switch (event.type) {
    case 'content_block_start':
      // 工具调用开始 → yield tool_use_start
      break
    case 'content_block_delta':
      if (event.delta.type === 'text_delta')
        yield { type: 'text_delta', content: event.delta.text }
      if (event.delta.type === 'input_json_delta')
        // 累积工具调用的 JSON 参数片段
      break
    case 'content_block_stop':
      // 工具调用结束 → yield tool_use_end (完整 JSON)
      break
  }
}

// 从 finalMessage() 获取准确的 token 用量
const finalMessage = await stream.finalMessage()
yield { type: 'done', usage: finalMessage.usage }
```

### 3.2 OpenAI SDK 流式调用

```typescript
// OpenAIAdapter.stream() 核心逻辑
const stream = await this.client.chat.completions.create({
  model: options.model,
  messages: [{ role: 'system', content: systemPrompt }, ...messages],
  stream: true,
  tools: openaiTools,
})

const toolCalls = new Map<number, { id, name, arguments }>()

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta

  if (delta?.content) {
    yield { type: 'text_delta', content: delta.content }
  }

  // OpenAI 工具调用通过 delta.tool_calls 累积
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      // 逐块拼接 arguments 字符串
      accumulator.arguments += tc.function.arguments
    }
  }

  // finish_reason === 'tool_calls' → 解析所有累积的 JSON
  if (choice.finish_reason === 'tool_calls') {
    for (const acc of toolCalls.values()) {
      const parsedInput = JSON.parse(acc.arguments)
      yield { type: 'tool_use_start', id: acc.id, name: acc.name }
      yield { type: 'tool_use_end', id: acc.id, parsedInput }
    }
  }
}
```

### 3.3 两种 SDK 的事件差异

| 特性 | Anthropic SDK | OpenAI SDK |
|------|--------------|------------|
| 文本增量 | `content_block_delta` → `text_delta` | `choices[0].delta.content` |
| 工具调用 | 先 `content_block_start`，逐步 `input_json_delta`，最后 `content_block_stop` | 在 `delta.tool_calls` 中累积，`finish_reason='tool_calls'` 时一次性出 |
| Thinking | 原生 `thinking` block + `thinking_delta` | `reasoning_effort` 参数（o1/o3/o4 系列） |
| Usage | `stream.finalMessage().usage` | chunk.usage 或最后一个 chunk |
| 缓存标记 | `cache_control: { type: 'ephemeral' }` | 不支持（OpenAI 自动缓存） |

---

## 4. 多模型路由 -- Gateway Pattern

Agent 不直接调用 SDK，而是通过 `LLMGateway` 统一路由：

```typescript
class LLMGateway {
  private adapters: Map<LLMProvider, LLMAdapter> = new Map()

  // 根据 model 名称前缀自动路由
  detectProvider(model: string): LLMProvider {
    if (model.startsWith('claude'))   return 'anthropic'
    if (model.startsWith('glm-5'))    return 'anthropic'  // GLM via Anthropic-compatible API
    return 'openai'  // OpenAI, DeepSeek, Qwen, 任何 OpenAI 兼容端点
  }

  async *stream(options: StreamOptions): AsyncGenerator<StreamEvent> {
    const provider = this.detectProvider(options.model)
    const adapter = this.adapters.get(provider)
    yield* adapter.stream(options)
  }
}
```

### 路由映射表

| Model 前缀 | Provider | SDK | baseURL |
|------------|----------|-----|---------|
| `claude-*` | anthropic | `@anthropic-ai/sdk` | `https://api.anthropic.com` |
| `glm-5*` | anthropic | `@anthropic-ai/sdk` | `https://open.bigmodel.cn/api/paas/v4` |
| `deepseek-*` | openai | `openai` | `https://api.deepseek.com` |
| `gpt-*` / `o1-*` | openai | `openai` | `https://api.openai.com/v1` |
| 其他 | openai | `openai` | 用户自定义 baseURL |

关键设计：同一个 `openai` SDK 覆盖所有 OpenAI 兼容 API，只需切换 `baseURL`。

---

## 5. 关键参数

```typescript
interface StreamOptions {
  model: string          // 模型标识，决定路由
  messages: Message[]    // 对话历史
  systemPrompt: string   // 系统提示
  tools: ToolDef[]       // 可用工具定义
  maxTokens?: number     // 最大输出 token 数（默认 8192）
  temperature?: number   // 温度（Agent 场景通常不设置，用默认值）
  abortSignal?: AbortSignal  // 用户取消
  thinkingDepth?: 'none' | 'low' | 'medium' | 'high'  // 思考深度
  fallbackModel?: string // 重试用尽后的降级模型
  onRetry?: (info) => void  // 重试通知回调
}
```

### 参数说明

| 参数 | 用途 | 典型值 |
|------|------|--------|
| `model` | 决定路由到哪个 SDK、使用哪个模型 | `claude-sonnet-4-20250514`、`deepseek-chat` |
| `maxTokens` | 限制单次输出长度 | 8192（默认）、16384（thinking 模式） |
| `temperature` | 随机性控制 | Agent 场景不设置，使用模型默认值 |
| `tools` | 告诉 LLM 可以调用哪些工具 | `[]` 时纯对话模式（降级场景） |
| `thinkingDepth` | Anthropic 专属，启用 extended thinking | `high` 时设置 `budget_tokens: 16384` |

---

## 6. 错误处理与重试

### 6.1 错误分类

```
错误消息 → classifyError()
├── retryable          → 指数退避重试
│   ├── 429 rate_limit → 尊重 Retry-After header
│   ├── 500/502/503    → 服务器过载
│   └── ECONNRESET/ETIMEDOUT → 网络错误
├── prompt_too_long    → 抛出 PromptTooLongError（不可重试）
│   └── context_length_exceeded → 触发反应式压缩
├── auth               → 不可重试（API Key 无效）
│   └── 401/403/invalid_api_key
└── non_retryable      → 其他 4xx 错误
```

### 6.2 三层恢复策略

```
Agent Loop 捕获 PromptTooLongError:

层级 1: 反应式压缩（最多 2 次）
  → 保留最近消息，压缩旧上下文
  → 重试同一 turn（不消耗 turn 槽位）

层级 2: 降级到纯对话模式
  → tools: [] （禁用工具定义，减少 token）
  → 设置 toolsDisabled 标志
  → 压缩成功后可自动恢复

层级 3: 最终失败
  → 告知用户使用 /compact 手动压缩
```

### 6.3 重试 + 降级流程

```typescript
async function* withRetry(thunk, primaryModel, options) {
  let attempt = 0
  let currentModel = primaryModel

  while (true) {
    const gen = thunk(currentModel)
    let hasYieldedContent = false

    for await (const event of gen) {
      if (event.type === 'error') {
        const classified = classifyError(event.error)

        if (classified === 'prompt_too_long')
          throw new PromptTooLongError()   // 上抛给 agent loop

        if (classified === 'retryable' && !hasYieldedContent) {
          if (attempt < maxRetries) {
            attempt++
            await sleep(exponentialBackoff(attempt))  // 1s → 2s → 4s，±20% jitter
            continue  // 重新调用 thunk
          }
          if (fallbackModel) {
            currentModel = fallbackModel   // 切换降级模型
            attempt = 1
            await sleep(1000)
            continue
          }
        }

        yield event  // 不可恢复的错误，传递给消费者
        return
      }

      if (event.type === 'text_delta' || event.type === 'tool_use_start')
        hasYieldedContent = true  // 内容已开始流动，不能再安全重试

      yield event
    }
    return  // 正常完成
  }
}
```

---

## 7. Token 计费与成本控制

### 7.1 Token 用量追踪

每次 LLM 调用返回的 `done` 事件携带 usage 数据：

```typescript
// Anthropic SDK 返回
{
  inputTokens: 15234,
  outputTokens: 2341,
  cacheReadTokens: 12000,     // 从缓存读取（节省 90%）
  cacheWriteTokens: 3200,     // 首次写入缓存
}

// OpenAI SDK 返回
{
  inputTokens: prompt_tokens,
  outputTokens: completion_tokens,
  // OpenAI 自动缓存，不单独报告
}
```

### 7.2 Prompt Caching 省钱原理

Anthropic 的 Prompt Caching 将 system prompt 分为静态/动态两部分：

```
[静态部分] — 基础指令 + 工具使用规则
  cache_control: { type: 'ephemeral' }  ← 缓存标记
<!-- CACHE_BOUNDARY -->
[动态部分] — 环境信息 + git 上下文 + CLAUDE.md + memory

三个缓存断点 (Cache Breakpoints):
  BP1: 静态 system prompt    → 跨 turn 不变，最高命中率
  BP2: tool definitions      → 最后一个 tool 带 cache_control
  BP3: 倒数第二个 user message → 多轮对话历史缓存
```

缓存命中时：`cache_read_tokens` 以 10% 价格计费，而非完整 input token 价格。

### 7.3 上下文压缩触发

```
shouldCompact(messages, model) 检查:
  → estimateTokens(messages) / contextWindowForModel(model) > 80%
  → 触发 auto compaction

compaction 流程:
  1. 发送旧消息给 LLM，请求生成摘要
  2. 用摘要替换旧消息，保留最近 N 条
  3. beforeTokens: 50000 → afterTokens: 12000
```

### 7.4 成本控制总结

| 策略 | 机制 | 节省幅度 |
|------|------|---------|
| Prompt Caching | 静态前缀缓存，3 个断点 | 缓存部分 input token 费用降低 90% |
| 上下文压缩 | 超过 80% 阈值自动摘要 | 避免达到 context 上限导致失败 |
| 反应式压缩 | PromptTooLongError 触发紧急压缩 | 挽救即将失败的请求 |
| 工具禁用降级 | 去掉 tool definitions 减少 token | 紧急场景降低 token 开销 |
| 工具结果裁剪 | `truncateToolResult()` 截断过长输出 | 防止单个工具结果膨胀 |
| 模型降级 | 主模型重试失败后切 fallback | 不用最贵模型完成简单任务 |
