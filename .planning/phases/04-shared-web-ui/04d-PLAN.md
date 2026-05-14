---
phase: 04-shared-web-ui
plan: 04
type: execute
wave: 3
depends_on: ["04b"]
files_modified:
  - packages/web-ui/src/components/chat/ToolCard.tsx
  - packages/web-ui/src/components/chat/ToolCallGroup.tsx
  - packages/web-ui/src/components/chat/CodeBlock.tsx
  - packages/web-ui/src/components/chat/ChatMessage.tsx
autonomous: true
requirements:
  - WEBUI-10
  - WEBUI-11

must_haves:
  truths:
    - "工具调用显示为卡片，包含工具名、输入参数、执行状态指示"
    - "工具执行完成后显示输出结果（截断显示）"
    - "工具调用错误时显示红色错误状态"
    - "代码块有语法高亮、行号、复制按钮"
    - "多个工具调用在一条消息中分组显示，左侧有连接竖线"
  artifacts:
    - path: "packages/web-ui/src/components/chat/ToolCard.tsx"
      provides: "单个工具调用可视化卡片"
      min_lines: 80
    - path: "packages/web-ui/src/components/chat/ToolCallGroup.tsx"
      provides: "工具调用分组容器 — 竖线 + 折叠"
    - path: "packages/web-ui/src/components/chat/CodeBlock.tsx"
      provides: "语法高亮代码块 + 复制按钮"
  key_links:
    - from: "packages/web-ui/src/components/chat/ChatMessage.tsx"
      to: "packages/web-ui/src/components/chat/ToolCallGroup.tsx"
      via: "toolCalls prop 渲染"
      pattern: "ToolCallGroup"
    - from: "packages/web-ui/src/components/chat/ChatMessage.tsx"
      to: "packages/web-ui/src/components/chat/CodeBlock.tsx"
      via: "Markdown pre 标签替换"
      pattern: "CodeBlock"
---

<objective>
实现工具调用可视化和代码块渲染。

Purpose: 工具调用是 AI Agent 的核心特征。用户需要看到 Agent 调用了哪些工具（文件读写、命令执行等）、参数是什么、结果如何。代码块语法高亮让技术内容可读性大幅提升。

Output: ToolCard + ToolCallGroup + CodeBlock 组件，集成到 ChatMessage 的渲染中。
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/04-shared-web-ui/04-CONTEXT.md
@.planning/phases/04-shared-web-ui/04b-SUMMARY.md

Desktop source files to extract from:
@wzxClaw_desktop/src/renderer/components/chat/ToolCard.tsx
@wzxClaw_desktop/src/renderer/components/chat/ToolCallGroup.tsx
@wzxClaw_desktop/src/renderer/components/chat/CodeBlock.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: ToolCard + ToolCallGroup + CodeBlock components</name>
  <files>
    packages/web-ui/src/components/chat/ToolCard.tsx,
    packages/web-ui/src/components/chat/ToolCallGroup.tsx,
    packages/web-ui/src/components/chat/CodeBlock.tsx,
    packages/web-ui/src/components/chat/ChatMessage.tsx
  </files>
  <action>
    从桌面端提取工具调用和代码块组件：

    1. **CodeBlock.tsx**: 从桌面端提取，简化：
       - 保留：语言标签、复制按钮、长代码折叠/展开（>15 行）
       - 保留：highlight.js 语法高亮（需要安装 highlight.js 依赖）
       - 移除：Apply 按钮（依赖 tab-store，web-ui 没有编辑器）
       - 约 74 行 -> ~50 行
       - 安装 highlight.js 到 package.json

    2. **ToolCard.tsx**: 从桌面端提取（725 行），大幅简化：
       - 保留核心功能：
         - 工具名 + 状态图标（running spinner / completed check / error X）
         - 输入参数折叠显示（JSON 格式化）
         - 输出结果截断显示（500 字符）
         - 错误状态红色显示
       - 保留特殊工具渲染：
         - WebSearch 输出解析（标题 + URL 列表）
         - WebFetch 输出（摘要显示）
       - 移除：
         - DiffPreview 集成（FileWrite/FileEdit 的 "Review Changes" 按钮）
         - GoToDefinition / FindReferences / SearchSymbols 的特殊渲染（需要编辑器）
         - 嵌套子工具调用（children）— 简化为扁平显示
         - progress 显示 — 简化
       - 约 725 行 -> ~200 行

    3. **ToolCallGroup.tsx**: 从桌面端提取（170 行），保持基本不变：
       - 保留：WorkflowHeader（工具数 >= 3 时显示摘要行）
       - 保留：左侧竖线连接（工具数 >= 2）
       - 保留：折叠/展开逻辑
       - 移除：嵌套子工具（children 渲染）
       - 约 170 行 -> ~130 行

    4. **ChatMessage.tsx 更新**: 将 Plan 04b 中的工具调用占位符替换为真实的 ToolCallGroup 渲染：
       - 当 message.toolCalls 存在且非空时，渲染 ToolCallGroup
       - ToolCallGroup 放在 message content 下方

    5. **chat.css 更新**: 添加工具调用相关样式（从桌面端 chat.css 中提取 .tool-card, .tool-call-group, .workflow-header 等样式）。
  </action>
  <verify>
    <automated>cd packages/web-ui && npm run typecheck && npm run build</automated>
  </verify>
  <done>
    - ToolCard 显示工具名、状态图标、输入参数、输出结果
    - ToolCallGroup 左侧竖线连接多个工具调用
    - CodeBlock 语法高亮 + 复制按钮 + 长代码折叠
    - ChatMessage 中工具调用渲染为 ToolCardGroup
    - npm run build 构建通过
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| agent output -> ToolCard | 工具调用输出可能包含任意文本，需要安全渲染 |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-04-08 | X | ToolCard output | mitigate | 工具输出使用 textContent 而非 innerHTML，React 默认转义 |
| T-04-09 | S | CodeBlock copy | accept | navigator.clipboard.writeText 是浏览器安全 API |
</threat_model>

<verification>
1. `cd packages/web-ui && npm run typecheck` — 通过
2. `cd packages/web-ui && npm run build` — 构建成功
3. Dev server 运行，发送消息后工具调用正确渲染
</verification>

<success_criteria>
- ToolCard 渲染工具名 + 状态 + 输入 + 输出
- ToolCallGroup 分组显示 + 竖线 + 折叠
- CodeBlock 语法高亮 + 复制
- ChatMessage 集成工具调用和代码块渲染
- 构建通过
</success_criteria>

<output>
After completion, create `.planning/phases/04-shared-web-ui/04d-SUMMARY.md`
</output>
