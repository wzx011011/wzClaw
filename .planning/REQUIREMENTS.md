# Requirements: wzxClaw

**Defined:** 2026-04-03
**Core Value:** AI Agent 能正确调用工具（读写文件、执行命令、搜索代码）完成编程任务，且用户能在 Chat Panel 中实时看到过程和结果。

## v1 Requirements

### Agent Runtime

- [x] **AGNT-01**: Agent 能与 LLM 进行多轮对话循环（发送消息 → 接收回复 → 解析工具调用 → 执行工具 → 反馈结果 → 循环）
- [x] **AGNT-02**: Agent 支持流式输出，实时将 LLM 响应推送到 UI
- [x] **AGNT-03**: Agent 支持 tool_use 响应解析，能识别 LLM 请求的工具调用并执行
- [x] **AGNT-04**: Agent 有上下文窗口管理，能追踪 token 用量并在接近限制时自动截断/压缩
- [x] **AGNT-05**: Agent 有无限循环防护，检测重复工具调用并强制停止
- [x] **AGNT-06**: Agent 支持中途取消（AbortController），用户可停止正在进行的生成

### Tool System

- [x] **TOOL-01**: FileRead 工具 — 读取指定文件内容，返回带行号的文本
- [x] **TOOL-02**: FileWrite 工具 — 创建或覆盖文件
- [x] **TOOL-03**: FileEdit 工具 — 基于搜索替换的精确编辑（old_string → new_string），防止竞态条件
- [x] **TOOL-04**: Bash 工具 — 执行 shell 命令，支持超时（默认 120s），流式输出 stdout/stderr
- [x] **TOOL-05**: Grep 工具 — 正则表达式搜索文件内容，返回匹配行
- [x] **TOOL-06**: Glob 工具 — 按文件名模式搜索文件路径
- [ ] **TOOL-07**: 工具调用可视化 — 在 Chat 中显示 Agent 调用了什么工具，输入参数和输出结果
- [x] **TOOL-08**: 工具权限系统 — 破坏性操作（文件写入、Bash 执行）需用户确认；只读操作可自动允许

### Chat Panel

- [ ] **CHAT-01**: 侧边栏聊天面板，可调整大小、可折叠
- [ ] **CHAT-02**: 流式响应显示 — 逐 token 实时渲染 LLM 输出
- [ ] **CHAT-03**: 代码块渲染 — 语法高亮 + 一键复制 + "Apply"按钮将代码插入编辑器
- [ ] **CHAT-04**: Markdown 渲染 — 支持标题、列表、粗体、链接、表格
- [ ] **CHAT-05**: 会话内消息历史 — 显示完整的对话记录（用户消息、助手回复、工具结果）
- [ ] **CHAT-06**: 中途停止生成 — 用户可取消正在进行的响应
- [ ] **CHAT-07**: 清空/重置对话 — 用户可开始新的对话

### LLM Integration

- [x] **LLM-01**: 支持 OpenAI 兼容 API（覆盖 OpenAI、DeepSeek 及其他兼容端点）
- [x] **LLM-02**: 支持 Anthropic API（Claude 模型）
- [ ] **LLM-03**: API Key 配置界面 — 用户可输入并保存多个 Provider 的 API Key
- [ ] **LLM-04**: 模型选择/切换 — 用户可在对话中切换使用不同模型
- [x] **LLM-05**: 流式响应处理 — SSE 流式接收 LLM 输出
- [x] **LLM-06**: System Prompt 支持 — 可配置的系统提示词

### Editor

- [ ] **EDIT-01**: Monaco Editor 集成 — 代码编辑器，支持语法高亮
- [ ] **EDIT-02**: Tab 多文件编辑 — 同时打开多个文件
- [ ] **EDIT-03**: 文件树（Explorer）— 目录树视图，展示工作区文件结构
- [x] **EDIT-04**: 打开文件夹作为工作区 — 通过对话框选择项目根目录
- [ ] **EDIT-05**: Agent 编辑文件后自动打开对应 Tab
- [ ] **EDIT-06**: 文件保存和脏状态追踪

### Electron Shell

- [x] **ELEC-01**: Electron 桌面应用窗口，包含菜单栏和状态栏
- [x] **ELEC-02**: IPC 通信桥接 — Main Process 和 Renderer Process 之间的类型安全通信
- [ ] **ELEC-03**: 应用打包和分发（electron-builder）

## v2 Requirements

### Inline Edit & Completion

- **INLI-01**: Cmd+K Inline Edit — 选中代码后输入指令，生成 inline diff 预览
- **INLI-02**: Tab 补全 — AI 驱动的代码自动补全

### Advanced Features

- **RULE-01**: 项目级规则文件（.wzxclawrules）— 自定义 AI 行为指令
- **MENT-01**: @-mentions — 在 Chat 中通过 @Files、@Folders 附加上下文
- **CHKP-01**: Checkpoints — Agent 修改前的代码快照，支持一键回滚
- **HIST-01**: 对话历史持久化 — 保存和恢复历史会话
- **MCP-01**: MCP 协议支持 — 扩展 Agent 工具能力

## Out of Scope

| Feature | Reason |
|---------|--------|
| VS Code 扩展 API 兼容 | 不是 VS Code fork，不需要兼容 VS Code 扩展生态 |
| 内置终端 | MVP 只需 Bash 工具执行命令，不需要交互式终端 |
| LSP/语言服务 | 依赖 Monaco 内置语言服务，不自建 LSP |
| 代码库索引/语义搜索 | 复杂度极高，MVP 用 Grep/Glob 即可 |
| 多人协作 | 个人工具 |
| 付费/用户体系 | 个人工具 |
| Vim 模式 | Monaco 自带快捷键已够用 |
| 浏览器工具 | 复杂度极高，后续版本 |
| 多 Agent 并行 | 复杂度高，后续版本 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| LLM-01 | Phase 1: Foundation | Complete |
| LLM-02 | Phase 1: Foundation | Complete |
| LLM-05 | Phase 1: Foundation | Complete |
| LLM-06 | Phase 1: Foundation | Complete |
| ELEC-02 | Phase 1: Foundation | Complete |
| AGNT-01 | Phase 2: Agent Core | Complete |
| AGNT-02 | Phase 2: Agent Core | Complete |
| AGNT-03 | Phase 2: Agent Core | Complete |
| AGNT-04 | Phase 2: Agent Core | Complete |
| AGNT-05 | Phase 2: Agent Core | Complete |
| AGNT-06 | Phase 2: Agent Core | Complete |
| TOOL-01 | Phase 2: Agent Core | Complete |
| TOOL-02 | Phase 2: Agent Core | Complete |
| TOOL-03 | Phase 2: Agent Core | Complete |
| TOOL-04 | Phase 2: Agent Core | Complete |
| TOOL-05 | Phase 2: Agent Core | Complete |
| TOOL-06 | Phase 2: Agent Core | Complete |
| TOOL-08 | Phase 2: Agent Core | Complete |
| ELEC-01 | Phase 3: IDE Shell | Complete |
| EDIT-01 | Phase 3: IDE Shell | Pending |
| EDIT-02 | Phase 3: IDE Shell | Pending |
| EDIT-03 | Phase 3: IDE Shell | Pending |
| EDIT-04 | Phase 3: IDE Shell | Complete |
| EDIT-05 | Phase 3: IDE Shell | Pending |
| EDIT-06 | Phase 3: IDE Shell | Pending |
| CHAT-01 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-02 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-03 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-04 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-05 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-06 | Phase 4: Chat Panel + Integration | Pending |
| CHAT-07 | Phase 4: Chat Panel + Integration | Pending |
| TOOL-07 | Phase 4: Chat Panel + Integration | Pending |
| LLM-03 | Phase 4: Chat Panel + Integration | Pending |
| LLM-04 | Phase 4: Chat Panel + Integration | Pending |
| ELEC-03 | Phase 5: Polish + Packaging | Pending |

---
*Requirements defined: 2026-04-03*
*Last updated: 2026-04-03 after roadmap creation*
