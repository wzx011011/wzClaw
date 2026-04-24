# 04-MCP-Servers — 外部工具协议

## 1. 概述

MCP（Model Context Protocol）是 Anthropic 发布的开放标准协议，定义了 AI Agent 与外部工具/数据源之间的通用通信规范。核心理念：**AI 不应硬编码工具，而应通过标准协议动态发现和调用外部能力。**

```
传统方式：AI Agent → 硬编码 16 个工具 → 无法扩展
MCP 方式：  AI Agent → MCP Client → 任意 MCP Server → 无限扩展
```

MCP 之于 AI ≈ USB 之于计算机 — 即插即用的外设协议。

## 2. Agent Loop 中的位置

MCP 工具参与 Agent Loop 的所有阶段，但对 Loop 本身是透明的——Loop 不区分内置工具和 MCP 工具。

```
Startup:
  loadConfig() → connectMCPServers(config)
    → client.listTools()            // 工具发现
    → registerAsAgentTools(tools)   // 注入工具列表

Loop Body:
  messages + tools → callModel()    // MCP 工具定义在 tools 中
  model returns tool_use
  harness.executeTool(name, args)   // 统一调度
    if builtin → 直接执行
    if mcp     → client.callTool()  // 路由到 MCP Client
  tool_result → append to messages  // 结果回到同一通道
```

关键洞察：**Agent Loop 核心代码无需修改**——MCP 工具只是在 Harness 的工具注册表中多了几条记录。

## 3. MCP 架构

### 3.1 Client-Server 模型

```
┌─────────────────────────────────────────────┐
│  AI Agent 进程                               │
│  ┌──────────────┐  ┌──────────────────────┐  │
│  │  Agent Loop   │→│  MCP Client (内置)    │  │
│  │  (Harness)    │  │  Transport Layer     │  │
│  └──────────────┘  └──────────┬───────────┘  │
└────────────────────────────────┼──────────────┘
                                 │ IPC (stdio / HTTP / WebSocket)
                                 ▼
                 ┌─────────────────────────────────┐
                 │  MCP Server (外部进程)            │
                 │  Tool: read_database             │
                 │  Tool: query_sales               │
                 │  Resource: schema.json           │
                 └─────────────────────────────────┘
```

### 3.2 协议能力域

```
MCP Protocol
├── Tools      → 可调用的函数（Agent 调用）
├── Resources  → 可读取的数据源（文件、数据库 schema）
├── Prompts    → 预定义的提示模板
└── Sampling   → Server 请求 Client 执行 LLM 调用（反向调用）
```

### 3.3 核心接口

```typescript
interface MCPClient {
  connect(transport: Transport): Promise<void>
  listTools(): Promise<Tool[]>
  callTool(name: string, args: Record<string, any>): Promise<ToolResult>
  close(): Promise<void>
}

interface AgentTool {
  name: string                    // "mcp_{server}_{tool}"
  description: string
  inputSchema: JSONSchema
  execute(args: Record<string, any>): Promise<ToolResult>
}
```

## 4. 连接生命周期

```
Startup → 读取配置(~/.wzxclaw/mcp.json) → 建立连接 → listTools
→ 注册到 Agent 工具表 → Ready → 按需 callTool → 断线重连
```

连接状态机：`DISCONNECTED → CONNECTING → CONNECTED → LISTING_TOOLS → READY`，出错时进入 `RECONNECTING`，超重试次数后 `FAILED`。

## 5. 传输方式

**stdio**（最常用）：Agent 启动 MCP Server 作为子进程，通过 stdin/stdout 通信。零网络依赖，最低延迟。

```json
{ "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
}}
```

**SSE**：用于远程 Server，HTTP 长连接 + Server-Sent Events 流。

**Streamable HTTP**：2025 规范新增，单次 HTTP 请求-响应 + 可选 SSE 流，更好的代理兼容性。

**WebSocket**：双向实时通信，适用于 Server 主动推送。

```typescript
function createTransport(config: MCPServerConfig): Transport {
  if (config.command) return new StdioTransport(config)
  if (config.url?.includes('/sse')) return new SSETransport(config)
  if (config.url?.startsWith('ws')) return new WebSocketTransport(config)
  return new StreamableHTTPTransport(config)
}
```

## 6. 工具发现与注入

```typescript
async function connectMCPServers(config: MCPConfig) {
  const mcpTools: AgentTool[] = []
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    const transport = createTransport(serverConfig)
    const client = new MCPClient()
    await client.connect(transport)
    const { tools } = await client.listTools()

    for (const tool of tools) {
      mcpTools.push({
        name: `mcp_${serverName}_${tool.name}`,
        description: tool.description,
        inputSchema: tool.inputSchema,
        execute: async (args) => {
          const result = await client.callTool(tool.name, args)
          return { content: result.content, isError: result.isError ?? false }
        }
      })
    }
  }
  return mcpTools  // 与内置工具合并，统一注入模型 tools 参数
}
```

## 7. 在 Agent Loop 中的调用路径

```
tool_use { name: "mcp_github_create_issue", args: {...} }
  → Harness.executeTool(name, args)
  → name.startsWith("mcp_") ?
    → 解析 serverName="github", toolName="create_issue"
    → mcpClients["github"].callTool("create_issue", args)
    → Transport → MCP Server 执行
    → tool_result { content: "Issue #42 created" }
  : 内置工具 → 直接执行

结果统一追加到 messages 数组。
```

超时与错误：30 秒超时，失败时返回 `{ content: "MCP tool call failed: ...", isError: true }` 让模型自行决策。

## 8. Context 占用问题

每个 MCP Server 的工具 schema 注入每次模型调用，是 Context 膨胀的主要来源。

```
单工具定义 ≈ 150-300 tokens
一个 Server (10-20 工具) ≈ 2-5K tokens
5 个 Server ≈ 10-25K tokens → 上下文的 5-12%
```

**解决方案：动态工具加载**

```typescript
// 注册阶段：极简名称列表（~5 tokens/tool）
availableMCPTools: ["mcp_github_create_issue", "mcp_github_list_prs", ...]
// 展开阶段：模型调用 mcp_tool_search → 返回完整 schema → 下一轮调用

// 方案二：按需连接 — 只在意图明确时连接对应 Server
```

wzxClaw 策略：MCP 代码完成但启动时未激活，需先实现动态加载再开启。

## 9. 认证

```
1. 无认证（本地 stdio）— 进程级隔离
2. API Key（最常见）— 配置 env 变量传入
3. OAuth 2.0（远程）— 浏览器授权 → token 存安全保险库
4. mTLS（企业级）— 双向 TLS
```

OAuth 流程：connect() → 401 + auth URL → 打开浏览器授权 → callback code → access_token → 正常调用。

安全边界策略：`allowedPaths`、`allowedDomains`、`allowedCommands`、`maxTimeout`、`maxResponseSize`。

## 10. wzxClaw 实现状态

```
├── MCP 配置解析      ✅ (~/.wzxclaw/mcp.json)
├── MCP Client        ✅ (连接/发现/调用)
├── 工具注册           ✅ (mcp_ 前缀)
├── 启动时连接         ❌ (loadAndConnect 未调用)
├── 动态加载           ❌
├── 重连机制           ⚠️ 基础实现
└── 认证               ⚠️ API Key only
```

关键文件：MCP 配置 `~/.wzxclaw/mcp.json`，Client 代码 `src/main/mcp/`。
