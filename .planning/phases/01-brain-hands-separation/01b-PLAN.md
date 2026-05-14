---
phase: 01-brain-hands-separation
plan: 02
type: execute
wave: 2
depends_on: ["01-brain-hands-separation-01"]
files_modified:
  - packages/brain/src/llm/gateway.ts
  - packages/brain/src/llm/openai-adapter.ts
  - packages/brain/src/llm/anthropic-adapter.ts
  - packages/brain/src/llm/cost-tracker.ts
  - packages/brain/src/llm/model-cost.ts
  - packages/brain/src/context/token-counter.ts
  - packages/brain/src/context/context-manager.ts
  - packages/brain/src/context/microcompact.ts
  - packages/brain/src/context/tool-result-budget.ts
  - packages/brain/src/context/tool-result-storage.ts
  - packages/brain/src/context/turn-attachments.ts
  - packages/brain/src/context/compact-file-restore.ts
  - packages/brain/src/context/types.ts
autonomous: true
requirements: [INFRA-03, INFRA-04]

must_haves:
  truths:
    - "LLMGateway 在 brain 包内可用，无 Electron 依赖"
    - "ContextManager 在 brain 包内可用，无 Electron 依赖"
    - "OpenAI 和 Anthropic adapter 正常编译"
    - "Token counting 在 brain 包内可用"
  artifacts:
    - path: "packages/brain/src/llm/gateway.ts"
      provides: "LLM Gateway 类（provider 路由）"
      exports: ["LLMGateway"]
    - path: "packages/brain/src/llm/openai-adapter.ts"
      provides: "OpenAI/DeepSeek/GLM 流式适配器"
      exports: ["OpenAIAdapter"]
    - path: "packages/brain/src/llm/anthropic-adapter.ts"
      provides: "Claude 流式适配器（含 prompt caching）"
      exports: ["AnthropicAdapter"]
    - path: "packages/brain/src/context/context-manager.ts"
      provides: "上下文管理器（token 计数 + 压缩）"
      exports: ["ContextManager"]
  key_links:
    - from: "packages/brain/src/llm/gateway.ts"
      to: "packages/brain/src/llm/openai-adapter.ts"
      via: "import + new OpenAIAdapter"
      pattern: "new OpenAIAdapter"
    - from: "packages/brain/src/context/context-manager.ts"
      to: "packages/brain/src/context/token-counter.ts"
      via: "import countMessagesTokens"
      pattern: "countMessagesTokens"
---

<objective>
复制 LLM 层（gateway + adapters + retry）和 Context 管理层（context-manager + token-counter + microcompact + tool-result-budget）到 brain 包。

Purpose: 这两层是 Brain 的核心——LLM 调用和上下文管理。它们本身没有 Electron 依赖，只需要修改 import 路径。
Output: 完整的 LLM + Context 子系统在 packages/brain/ 中可用，tsc 编译通过。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md

<!-- 依赖 Plan 01 的产出 -->
@packages/brain/src/types.ts
@packages/brain/src/interfaces.ts
@packages/brain/src/llm/types.ts

<!-- 源文件 -->
@wzxClaw_desktop/src/main/llm/gateway.ts
@wzxClaw_desktop/src/main/llm/openai-adapter.ts
@wzxClaw_desktop/src/main/llm/anthropic-adapter.ts
@wzxClaw_desktop/src/main/llm/cost-tracker.ts
@wzxClaw_desktop/src/main/llm/model-cost.ts
@wzxClaw_desktop/src/main/llm/retry.ts
@wzxClaw_desktop/src/main/context/token-counter.ts
@wzxClaw_desktop/src/main/context/context-manager.ts
@wzxClaw_desktop/src/main/context/microcompact.ts
@wzxClaw_desktop/src/main/context/tool-result-budget.ts
@wzxClaw_desktop/src/main/context/tool-result-storage.ts
@wzxClaw_desktop/src/main/context/turn-attachments.ts
@wzxClaw_desktop/src/main/context/compact-file-restore.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: 复制 LLM 层（Gateway + Adapters + Retry）</name>
  <files>
    packages/brain/src/llm/gateway.ts,
    packages/brain/src/llm/openai-adapter.ts,
    packages/brain/src/llm/anthropic-adapter.ts,
    packages/brain/src/llm/cost-tracker.ts,
    packages/brain/src/llm/model-cost.ts,
    packages/brain/package.json
  </files>
  <read_first>
    wzxClaw_desktop/src/main/llm/gateway.ts
    wzxClaw_desktop/src/main/llm/openai-adapter.ts
    wzxClaw_desktop/src/main/llm/anthropic-adapter.ts
    wzxClaw_desktop/src/main/llm/cost-tracker.ts
    wzxClaw_desktop/src/main/llm/model-cost.ts
    wzxClaw_desktop/src/main/llm/retry.ts
    wzxClaw_desktop/package.json
    packages/brain/src/types.ts
    packages/brain/src/llm/types.ts
  </read_first>
  <action>
从桌面端复制 LLM 层所有文件到 packages/brain/src/llm/，修改 import 路径。

1. 添加运行时依赖到 package.json:
   - "openai": 版本与桌面端 package.json 一致
   - "@anthropic-ai/sdk": 版本与桌面端一致

2. `llm/gateway.ts` — 从桌面端复制:
   - import StreamEvent, LLMProvider 从 `../../shared/types` 改为 `../types`
   - import LLMAdapter, ProviderConfig, StreamOptions 从 `./types` 保持不变（已在 brain 内部）
   - import OpenAIAdapter 从 `./openai-adapter` 保持不变
   - import AnthropicAdapter 从 `./anthropic-adapter` 保持不变
   - import DEFAULT_MODELS 从 `../../shared/constants` — 需要在 brain 包内创建 src/constants.ts 复制 DEFAULT_MODELS 和 MAX_AGENT_TURNS（只复制 brain 需要的常量），或直接在 gateway 内联一个 detectProvider 方法（参考现有代码逻辑）
   - import withRetry 从 `./retry` 保持不变

3. `llm/openai-adapter.ts` — 从桌面端复制:
   - 改 import 路径: `../../shared/types` -> `../types`, `./types` 保持不变
   - 检查是否有其他 Electron 或 shared 引用并消除

4. `llm/anthropic-adapter.ts` — 从桌面端复制:
   - 同上改 import 路径
   - 检查是否有 Electron 引用

5. `llm/cost-tracker.ts` 和 `llm/model-cost.ts` — 从桌面端复制:
   - 改 import 路径（如果有 shared 引用）

6. 创建 `src/constants.ts` — 从 `wzxClaw_desktop/src/shared/constants.ts` 提取 brain 需要的常量:
   - ModelPreset interface 和 DEFAULT_MODELS 数组
   - MAX_AGENT_TURNS
   - SYSTEM_PROMPT_CACHE_BOUNDARY
   - TOOL_DEFS_CACHE_BOUNDARY
   - DEFAULT_MAX_TOKENS

7. 更新 `src/index.ts` barrel export 添加 LLM 模块导出

注意：所有代码注释保持中文。
  </action>
  <verify>
    <automated>cd packages/brain && npm install && npx tsc --noEmit && echo "OK"</automated>
  </verify>
  <done>
    - tsc 编译零错误
    - LLMGateway, OpenAIAdapter, AnthropicAdapter 全部在 brain 包内可用
    - 无 Electron 依赖
  </done>
</task>

<task type="auto">
  <name>Task 2: 复制 Context 管理层</name>
  <files>
    packages/brain/src/context/types.ts,
    packages/brain/src/context/token-counter.ts,
    packages/brain/src/context/context-manager.ts,
    packages/brain/src/context/microcompact.ts,
    packages/brain/src/context/tool-result-budget.ts,
    packages/brain/src/context/tool-result-storage.ts,
    packages/brain/src/context/turn-attachments.ts,
    packages/brain/src/context/compact-file-restore.ts
  </files>
  <read_first>
    wzxClaw_desktop/src/main/context/context-manager.ts
    wzxClaw_desktop/src/main/context/token-counter.ts
    wzxClaw_desktop/src/main/context/microcompact.ts
    wzxClaw_desktop/src/main/context/tool-result-budget.ts
    wzxClaw_desktop/src/main/context/tool-result-storage.ts
    wzxClaw_desktop/src/main/context/turn-attachments.ts
    wzxClaw_desktop/src/main/context/compact-file-restore.ts
    packages/brain/src/types.ts
    packages/brain/src/constants.ts
  </read_first>
  <action>
从桌面端复制 Context 管理层所有文件到 packages/brain/src/context/。

1. 创建 `context/types.ts` — 定义 CompactResult interface:
   ```typescript
   import type { Message } from '../types'
   export interface CompactResult {
     summary: string
     summaryMessageContent: string
     keptRecentCount: number
     beforeTokens: number
     afterTokens: number
     summarizedMessages: Message[]
   }
   ```
   （原本在 context-manager.ts 中定义，提取到独立文件便于 interfaces.ts 引用）

2. `context/token-counter.ts` — 从桌面端复制:
   - 改 import 路径: shared 引用改为 `../types` 或 `../constants`
   - 检查是否依赖 tiktoken 或其他库——如果依赖，添加到 package.json

3. `context/context-manager.ts` — 从桌面端复制:
   - 改 import 路径: `../../shared/types` -> `../types`
   - 改 import 路径: `../../shared/constants` -> `../constants`
   - 改 import 路径: `../llm/gateway` -> `../llm/gateway`（同级）
   - 改 CompactResult 为从 `./types` 导入
   - 改 AgentRuntimeConfig import 路径: `../agent/runtime-config`

4. `context/microcompact.ts` — 从桌面端复制，改 import 路径

5. `context/tool-result-budget.ts` — 从桌面端复制，改 import 路径

6. `context/tool-result-storage.ts` — 从桌面端复制:
   - 这个模块使用 `~/.wzxclaw/tool-results/` 路径
   - 路径获取需要通过接口注入或参数传递，而不是硬编码 Electron 路径
   - 如果 tool-result-storage.ts 直接引用 paths.ts（Electron 路径模块），需要把路径提取为参数或通过 IPaths 接口注入
   - 检查是否有 Electron 依赖并移除

7. `context/turn-attachments.ts` — 从桌面端复制，改 import 路径

8. `context/compact-file-restore.ts` — 从桌面端复制:
   - 检查是否引用 Electron 路径模块
   - 改 import 路径

9. 更新 `src/index.ts` barrel export 添加 context 模块导出

关键约束：如果 tool-result-storage.ts 或 compact-file-restore.ts 直接依赖 Electron 的 app.getPath()，把路径提取为构造函数参数或模块级配置变量。
  </action>
  <verify>
    <automated>cd packages/brain && npx tsc --noEmit && echo "OK" && grep -rn "electron\|../../shared\|'electron'" src/ && echo "FAIL" || echo "PASS: clean"</automated>
  </verify>
  <done>
    - tsc 编译零错误
    - ContextManager, token counting, microcompact, tool-result-budget 全部在 brain 包内可用
    - 无 Electron 依赖
    - CompactResult 类型独立导出
  </done>
</task>

</tasks>

<verification>
cd packages/brain && npx tsc --noEmit
grep -rn "electron" packages/brain/src/ || echo "No Electron references"
</verification>

<success_criteria>
- LLM 层（Gateway + OpenAI/Anthropic adapters）在 brain 包内编译通过
- Context 管理层（ContextManager + token-counter + microcompact）在 brain 包内编译通过
- 无 Electron 依赖
- packages/brain/package.json 包含 openai 和 @anthropic-ai/sdk 运行时依赖
</success_criteria>

<output>
After completion, create `.planning/phases/01-brain-hands-separation/01b-SUMMARY.md`
</output>
