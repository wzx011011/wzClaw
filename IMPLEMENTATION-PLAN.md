# wzxClaw 功能完善实施计划

> 基于 Claude Code (E:\ai\claude-code) 对比分析，2026-05-07 制定

---

## Phase 1: P0 高价值功能（预计 8-12 个任务）

### 1.1 Session Resume（会话恢复）

**状态: 已完成 ✓** — 已经完全实现！switchSession + loadSession(两阶段 tail+full) + agentLoop.restoreContext + 搜索过滤全部就位。

---

### 1.2 Bash Background Tasks（后台任务执行）

**状态: 已实现 ✓**

**新建文件:**
- `src/main/tasks/background-task-manager.ts` — 后台 shell 任务管理器（spawn, kill, output, completion callbacks）
- `src/main/tools/task-output-tool.ts` — TaskOutput 工具（LLM 可查询后台任务输出）

**修改文件:**
- `src/main/tools/bash.ts` — BashSchema 添加 `run_in_background`, execute 中分发到 BackgroundTaskManager
- `src/main/tools/tool-registry.ts` — 传入 BackgroundTaskManager, 注册 TaskOutputTool
- `src/main/index.ts` — 创建 BackgroundTaskManager 实例, 注入到 tool registry

---

### 1.3 Auto-Memory（自动记忆提取）

**状态: 已完成 ✓**

**新建文件:**
- `src/main/memory/auto-extractor.ts` — AutoExtractor 类，从最近对话摘要中提取增量记忆

**修改文件:**
- `src/main/agent/agent-loop.ts` — 导入 AutoExtractor + MemoryManager，在 `shouldStop` 正常结束处触发 `triggerAutoMemory()`（fire-and-forget）

**验收标准**:
- 对话结束（agent 自然停止）时自动触发记忆提取
- 提取的记忆追加到项目 MEMORY.md
- 不在 abort/错误时触发
- 记忆内容不超过 200 行（与现有限制一致）

---

### 1.4 MCP SSE Transport

**状态: 已完成 ✓**

**修改文件:**
- `src/main/mcp/mcp-client.ts` — 重构为双传输支持：添加 `connectSSE()` 方法（HTTP GET 建立 SSE 流，POST 发送 JSON-RPC），SSE 解析，断线自动重连，共用的 `handleMessage()` 和 `postJsonRpc()`

**验收标准**:
- 配置中可选择 SSE 传输方式
- SSE MCP 服务器能正常连接、列出工具、调用工具
- 连接断开时自动重连
- 与现有 stdio 传输共存

---

### 1.5 MCP Resources

**状态: 已完成 ✓**

**新建文件:**
- `src/main/tools/mcp-resource-tool.ts` — MCPListResourcesTool + MCPReadResourceTool

**修改文件:**
- `src/main/mcp/mcp-client.ts` — 添加 `listResources()`, `readResource()`, `MCPResource`, `MCPResourceContent` 类型
- `src/main/mcp/mcp-manager.ts` — 添加 `listAllResources()`, `readResource()` 代理方法
- `src/main/index.ts` — 创建 MCPManager 后注册资源工具（避免循环依赖）

**验收标准**:
- 新增 `MCPListResources` 和 `MCPReadResource` 工具
- LLM 可列出 MCP 服务器提供的资源列表
- LLM 可读取指定 URI 的资源内容
- 工具描述准确，LLM 知道何时使用

---

### 1.6 Conversation Rewind（会话回退）

**状态: 已完成 ✓**

**新建文件:**
- (无，仅修改现有文件)

**修改文件:**
- `src/main/persistence/session-store.ts` — 添加 `truncateAfterMessage()` 方法，原子写截断 JSONL
- `src/main/file-history/file-history-manager.ts` — 添加 `revertAfterTimestamp()` 批量回退文件快照
- `src/shared/ipc-channels.ts` — 添加 `session:rewind` channel（请求/响应类型）
- `src/main/index.ts` — 注册 rewind IPC handler（文件回退 + 消息截断 + runtime 重置）
- `src/preload/index.ts` — 暴露 `rewindSession()` 到渲染进程
- `src/renderer/stores/chat-store.ts` — 添加 `rewindToMessage()` action
- `src/renderer/components/chat/ChatMessage.tsx` — 用户消息悬停显示回退按钮
- `src/renderer/components/chat/MessageList.tsx` — 传递 onRewind 回调
- `src/renderer/styles/chat.css` — 回退按钮样式
- `src/renderer/i18n/zh-CN.json` + `en.json` — 添加 "回退到此消息" 翻译

**验收标准**:
- 消息上可触发 "回退到此" 操作
- 回退后该消息之后的所有对话和文件变更被撤销
- 文件恢复到回退点的状态
- 回退后可继续发送新消息

---

## Phase 2: P1 中等价值功能

### 2.1 通知系统（声音 + 桌面通知）

**状态: 已完成 ✓**

**新建文件:**
- `src/main/notification/notification-service.ts` — NotificationService 类

**修改文件:**
- `src/main/settings-manager.ts` — 添加 notificationSound / notificationDesktop 配置字段
- `src/main/index.ts` — 导入 NotificationService，在 agent:done 时触发通知
- `src/renderer/stores/settings-store.ts` — 暴露通知设置字段
- `src/renderer/components/settings/GeneralPanel.tsx` — 通知开关 UI
- `src/renderer/i18n/zh-CN.json` + `en.json` — 通知相关翻译

---

### 2.2 Compaction 策略丰富化

**状态: 跳过** — 现有的 reactive compact + tools-disabled 降级已覆盖核心场景。待用户反馈再决定是否添加额外策略。

---

### 2.3 Context Visualization（上下文可视化）

**状态: 已有 ✓** — `/context` 命令已实现完整的 token 分布可视化（图形化 grid + 详细表格 + 会话统计 + 压缩历史）。

---

### 2.4 `/doctor` 诊断命令

**状态: 已完成 ✓**

**新建文件:**
- `src/main/diagnostics/doctor.ts` — Doctor 类（Node/Git/API Key/MCP/磁盘空间检查）

**修改文件:**
- `src/shared/ipc-channels.ts` — 添加 `system:doctor` channel
- `src/main/ipc-handlers.ts` — 注册 doctor IPC handler
- `src/preload/index.ts` — 暴露 `runDoctor()`
- `src/renderer/commands/slash-commands.ts` — 注册 `/doctor` 命令

---

### 2.5 Keybindings 系统

**状态: 跳过** — 桌面端快捷键需求不强，暂不实现。

---

### 2.6 Model Picker（交互式模型选择）

**状态: 已完成 ✓**

**修改文件:**
- `src/renderer/components/ide/StatusBar.tsx` — 添加 ModelPicker 组件（点击弹出下拉选择器）
- `src/renderer/styles/ide.css` — 模型选择器样式
- `src/renderer/i18n/zh-CN.json` + `en.json` — 翻译

---

## Phase 3: P2 锦上添花功能（按需挑选）

### 3.1 Conversation Export
- 导出对话为 Markdown/JSON 文件
- 文件: `src/main/export/conversation-exporter.ts`（新建）
- IPC: `session:export`

### 3.2 Fast Mode
- `/fast` 切换快速模式（同一模型但调整参数）
- 文件: `src/main/agent/agent-loop.ts` 添加模式参数
- 渲染器: 状态栏切换按钮

### 3.3 Output Styles
- 可配置输出详细程度（concise / standard / verbose）
- 文件: `src/main/agent/system-prompt-builder.ts` 注入风格指令
- 设置: GeneralPanel 添加选项

### 3.4 Scratchpad
- 临时文件目录供 agent 使用
- 文件: `src/main/paths.ts` 添加 scratchpad 路径
- 系统 prompt 注入 scratchpad 路径

### 3.5 PowerShell Tool
- Windows 上 PowerShell 作为 Bash 替代
- 文件: `src/main/tools/powershell.ts`（新建）
- 自动检测 Windows 环境

### 3.6 Tool Search Tool
- 搜索可用工具描述
- 文件: `src/main/tools/tool-search.ts`（新建）
- 帮助 LLM 在工具多时找到合适的工具

---

## 实施顺序建议

```
Week 1: Phase 1.1 (Session Resume) + Phase 1.6 (Rewind)
Week 2: Phase 1.2 (Bash Background) + Phase 1.5 (MCP Resources)
Week 3: Phase 1.3 (Auto-Memory) + Phase 1.4 (MCP SSE)
Week 4: Phase 2.1 (Notifications) + Phase 2.6 (Model Picker)
Week 5: Phase 2.4 (Doctor) + Phase 2.3 (Context Viz)
Week 6+: Phase 2.2 (Compaction) + Phase 2.5 (Keybindings)
按需:   Phase 3.x
```

---

## 依赖关系

```
1.1 Session Resume ← 无依赖
1.2 Bash Background ← 无依赖
1.3 Auto-Memory ← 无依赖
1.4 MCP SSE ← 无依赖
1.5 MCP Resources ← 无依赖
1.6 Conversation Rewind ← 1.1 Session Resume（共享消息管理逻辑）

2.1 Notifications ← 1.2 Bash Background（后台任务完成通知）
2.2 Compaction ← 无依赖
2.3 Context Viz ← 无依赖
2.4 Doctor ← 无依赖
2.5 Keybindings ← 无依赖
2.6 Model Picker ← 无依赖
```

---

*Plan created: 2026-05-07*
*Based on: Claude Code feature comparison analysis*
