# Claude Code 源码 vs Managed Agents 文章架构对比

两者的设计理念有渊源，但**不是同一套架构**。Claude Code 更像是一个"初代"设计，而 Managed Agents 文章描述的是 Anthropic 从 Claude Code 的痛点中提炼出来的**第二代解耦架构**。

---

## 1. Brain / Harness 对比

| 维度 | Claude Code 源码 | Managed Agents 文章 |
|------|-----------------|-------------------|
| 入口 | `src/query.ts` 的 `query()` async generator | Hosted harness service |
| 状态 | **有状态** — 循环内持有 mutable `State` 对象 (messages, toolUseContext 等) | **无状态** — harness 是 cattle，崩溃后 `wake(sessionId)` 恢复 |
| 生命周期 | 随进程生死，进程挂了 loop 就没了 | Harness 可随时替换，新 harness 读 session 恢复 |
| 多路 | 单循环，subagent 通过 `runForkedAgent()` 在同进程内 fork | Many Brains — 多个无状态 harness 独立扩展 |

Claude Code 的 `query()` 循环是这样的：

```
while (true) {
  1. 取出 mutable State
  2. 流式调用 API
  3. 收集 tool_use blocks
  4. StreamingToolExecutor 并行启动工具
  5. runTools() 执行剩余工具
  6. 用新 State continue 循环
}
```

这跟文章里说的"不要养宠物"恰恰相反——**Claude Code 本身就是那个 pet**。如果 Node 进程崩溃，loop 状态就丢了，只能靠 `--resume` 从 JSONL 重建。

---

## 2. Hands / Sandbox 对比

| 维度 | Claude Code 源码 | Managed Agents 文章 |
|------|-----------------|-------------------|
| 执行位置 | **本地** — Bash 直接在宿主机执行，File 工具直接读写本地文件 | **云端容器** — `execute(name, input) → string` 统一接口 |
| 沙箱 | 可选的 `@anthropic-ai/sandbox-runtime`，默认关闭 | 强制隔离，不可信代码永远碰不到凭证 |
| 接口 | 每个 Tool 独立实现 `call(args, context)` → `ToolResult` | 统一的 `execute(name, input) → string` 抽象 |
| 安全 | 凭证 (API key) 在同一进程可访问 | 凭证在 secure vault，sandbox 通过 proxy 调用 |

Claude Code 的工具分两类：
- **并发安全** (Glob, Grep, Read) — 可并行
- **非并发安全** (Write, Edit, Bash) — 串行

这个并行/串行调度 (`src/services/tools/toolOrchestration.ts`) 是个亮点，但工具和执行环境是**耦合的**——Bash 工具直接调用本地 shell，没有 `execute()` 抽象层。

---

## 3. Session 对比

这是两者最接近的部分：

| 维度 | Claude Code 源码 | Managed Agents 文章 |
|------|-----------------|-------------------|
| 存储 | `~/.claude/projects/<path>/` JSONL 文件 | 云端持久化 session service |
| 模式 | Append-only，每个消息带 `parentUuid` 链 | Append-only event log |
| 恢复 | `--resume` 从 JSONL 重建对话 | `wake(sessionId)` + `getSession(id)` |
| 查询 | 线性读取，无切片能力 | `getEvents()` 支持按位置切片 |
| 角色 | 主要是崩溃恢复和审计 | **Context 对象** — 降级时回溯重读 |

Claude Code 的 session 存储确实做到了 append-only 和持久化，但**只是作为恢复手段**，不像 Managed Agents 那样把 session 作为 context window 的外挂扩展（可以 rewind 几个 event 重新读取上下文）。

---

## 4. Context 管理对比

Claude Code 有一个**非常复杂的 compaction 管线**，按优先级：

```
Tool Result Budget → Snip Compact → Microcompact → Context Collapse → Auto-compact → Reactive Compact
```

对比：

| 维度 | Claude Code 源码 | Managed Agents 文章 |
|------|-----------------|-------------------|
| 策略 | 6 层压缩管线，每层独立触发 | Harness 决定策略，session 保证数据不丢 |
| 压缩方式 | 用 subagent 生成 summary 替换旧消息 | 未指定具体实现，强调 session 可回溯 |
| 不可逆性 | 压缩后原始消息从 context 移除 | Session 保留原始数据，context 只是视图 |

文章的核心洞察——**"Session is not context window"**——Claude Code 部分做到了（JSONL 里有完整记录），但 compaction 是不可逆的，compact 后的消息从 context 中删除，无法回退重读。

---

## 5. 多进程 / Bridge 模式

Claude Code 有一个 bridge 架构 (`src/bridge/`)：

```
Bridge Main (长驻进程, 轮询 Claude.ai)
  └── Session Runner (每个会话 spawn 一个 claude 子进程)
       └── REPL Bridge (子进程内, HTTP/WebSocket 通信)
```

这跟 Managed Agents 的"Many Brains"有相似之处，但出发点不同：
- Claude Code Bridge 是为了**远程控制**（Claude.ai 网页版控制本地 CLI）
- Managed Agents 的多 Brain 是为了**弹性扩展**和**按需创建**

---

## 6. Claude Code 源码关键架构细节

### Agent Loop: `src/query.ts`

核心是 `query()` async generator，循环调用 Claude API 并路由工具调用。支持：
- 流式工具执行 (StreamingToolExecutor)
- 并发安全工具并行执行
- 依赖注入 (QueryDeps) 方便测试

### Tool System: `src/Tool.ts` + `src/tools.ts`

40+ 工具，每个实现统一接口：
```typescript
type Tool<Input, Output, P> = {
  name: string
  call(args, context, canUseTool, parentMessage, onProgress?): Promise<ToolResult<Output>>
  inputSchema: AnyObject  // Zod schema
  isConcurrencySafe(input): boolean
  isReadOnly(input): boolean
  // ...
}
```

工具通过 `buildTool()` 工厂函数构建，注册在 `getAllBaseTools()` 静态数组中。

### MCP: `src/services/mcp/client.ts` (122KB)

支持 stdio / sse / http / ws / sdk / claudeai-proxy 多种传输方式，通过 React hook (`useManageMCPConnections`) 管理连接生命周期。

### Compaction 管线

6 层压缩策略：
1. **Tool Result Budget** — 裁剪大工具输出
2. **Snip Compact** — 删除旧会话轮次
3. **Microcompact** — 用 cache-editing 精简近期工具密集区
4. **Context Collapse** — 细粒度折叠 + commit-log 重建
5. **Auto-compact** — 超阈值时用 subagent 生成摘要
6. **Reactive Compact** — prompt-too-long 时的紧急压缩

---

## 架构对比总结图

```
Claude Code (源码)          Managed Agents (文章)
┌─────────────────┐        ┌─────────────────┐
│   React/Ink UI  │        │   User App      │
├─────────────────┤        ├─────────────────┤
│  query() loop   │ ←→     │  Harness (Brain)│  ← 无状态，可替换
│  (有状态, 单进程) │        │                  │
├─────────────────┤        ├─────────────────┤
│  Tools (本地)    │ ←→     │  Sandbox (Hands) │  ← 云端容器, execute() 抽象
│  Bash/File/etc  │        │  多 Hand 支持     │
├─────────────────┤        ├─────────────────┤
│  JSONL Session  │ ←→     │  Session Service │  ← 云端持久, getEvents() 切片
│  (append-only)  │        │  (context 外挂)   │
└─────────────────┘        └─────────────────┘
```

---

## 结论

Claude Code 是 Managed Agents 的**前身**，文章中提到的每个痛点（pet 容器、脑手耦合、凭证暴露、session ≠ context）都能在 Claude Code 源码中找到对应。Managed Agents 是 Anthropic 把这些教训提炼成的**理想化架构**——但 Claude Code 因为要跑在用户本地，天然受限于单进程模型，无法做到完全解耦。

### 对 wzxClaw 的启示

- 你已经在走 Claude Code 的路线（本地单进程 agent loop），这没问题
- 但 `agent-loop.ts` 可以借鉴文章的 `execute()` 抽象——把工具执行抽成统一接口，未来接远程 sandbox 会更容易
- Session 存储你已经有了 (JSONL)，可以加强 `getEvents()` 式的切片查询能力

---

## Sources

- [Scaling Managed Agents: Decoupling the brain from the hands - Anthropic Engineering Blog](https://www.anthropic.com/engineering/managed-agents)
- [Claude Managed Agents overview - Official API Docs](https://platform.claude.com/docs/en/managed-agents/overview)
- Claude Code 源码分析基于 `E:\ai\claude-code\src\` 目录
