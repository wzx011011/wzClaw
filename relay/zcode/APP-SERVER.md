# ZCode Protocol v1（app-server stdio）— 实测验证记录

> 2026-09-13 本机实测。目标：手机端控制 ZCode 的**官方稳定通道**。
> **结论：读写链路全部打通。** create → send → 真实 LLM 调用（glm-5.3 @
> open.bigmodel.cn）→ 流式事件 → 消息持久化 → stop，全流程实测成功。

## 定位结论（为什么选 app-server 而不是 rpc-frame 桥）

官方网页/手机远程控制（zcode.z.ai/remote/v4）的完整链路是：
`QR 配对 → 云中继 → workspace-bridge-open → rpc-frame 分片隧道 → VSCode workbench 远程协议`。
桥内是整套浏览器版 IDE 的 remoting（服务多路复用、topic/subscription 事件层、
`v4/conversation/frame`），在自有 App 中重实现不现实且随版本漂移。

app-server 是官方对外稳定接口：stdio NDJSON、协议即文档（zod 校验报错自带 schema 提示）、
与会话存储共享。桌面端零改动、无需环境变量、无需重启。

## 目标架构

```
手机 wzxClaw App ──WSS──▶ NAS zcode relay ──▶ 桌面 companion（我们的 Node 程序）
（扫码 sid/hash 配对）        （转发 data 载荷）      │ device 注册/心跳（线协议已实测）
                                                 │ 本机 spawn `zcode app-server`
                                                 ▼
                                          ZCode Protocol v1（stdio NDJSON）
```

companion 用我们已验证的 device/probe 线协议（见 README.md）注册到 relay，
QR 由 companion 自己生成（mid/password/hash 自管），**不动正在运行的桌面端**。

## 线协议（实测）

- 帧格式：NDJSON，**无 `jsonrpc` 字段**的类 JSON-RPC（发 `{"jsonrpc":"2.0",…}` 会被
  zod 拒绝：Unrecognized key）。
  - 请求 `{id: number|string, method, params}`
  - 通知 `{method, params}`（无 id）
  - 响应 `{id, result}` / `{id, error:{code,message,data?}}`
  - 服务端反向请求：`id` 形如 `"server-1"`，客户端必须应答 `{id:"server-1", result}`
- 无需 initialize 握手：连上即可调 `session/list`（发 `initialize` 反而 Method not found）。

## 已验证（E: 盘真实数据）

| 方法 | params | 结果 |
| --- | --- | --- |
| `session/list` | `{}` | 返回桌面端创建的全部会话：`{sessions:[{sessionId,title,status,mode,sessionKind,createdAt,updatedAt,workspace:{workspaceKey,workspacePath},traceId}]}`。桌面正在使用的会话（本会话）也在列。 |
| `session/resume` | `{sessionId}` | 激活会话；**响应直接带全量 `messages`**（测试会话 26MB，需分页策略）。会触发两次反向请求 `session/requestRuntimePreferences`（scope: `runtime-materialization`、`user-execution`），应答 `{nativeSearchEnhancementsEnabled:false}` 即可通过。 |
| `session/messages` | `{sessionId, limit:2}` | 分页生效。消息结构 `{info:{role,time{created,completed},parentID,modelID,providerID,mode,agent,path,cost,tokens{total,input,...},finish,semantics,anchor,id,sessionID}, parts:[...]}`；也支持 `afterMessageId`。 |
| `session/events` | `{sessionId}` | 返回近期事件快照 `{events:[{eventId,payload}]}` + 持续推送（实测收到 `process/mcpTelemetry`）；也支持 `afterSeq`/`limit`。 |
| `session/create` | `{workspace:{workspaceKey,workspacePath}}` | ✅ 成功。响应含 `session{sessionId,mode,model{modelId,providerId}}`、`projection{status,contextWindow,...}`、`runtime{eventSeq,...}`、`protocol{name:"ZCode Protocol",version:1}`。触发一次反向请求（scope: `runtime-materialization`）。 |
| `session/send` | `{sessionId, content: string}` | ✅ 成功。**参数名是 `content` 不是 `message`**（发错会 -32602 ZodError）。响应 `{accepted:true, sessionId, stateRevision}`。随后事件流推送完整回合（见下方事件序列）。 |
| `session/stop` | `{sessionId}` | ✅ 返回 `{}`。 |

## 错误码（实测）

- `-32600` Invalid ZCode Protocol message（帧结构错）
- `-32601` Method not found
- `-32602` Invalid params（data.name=ZodError，message 含完整 schema 差异提示）
- `-32004` Session is not active（需先 resume/create）
- `-32022` Client request timed out（未应答服务端反向请求）

## 模型配置与认证（已解决，关键结论）

**问题**：CLI app-server 不读桌面 v2 配置，`session/send` 报
"Model config is missing" → 修好后又报 "missing baseURL" → 再修后报
"missing an API key"。三层原因全部定位：

1. **`model` 字段形状**（zod `union([string, {main?,lite?}])`，strict）：
   - ✅ `"model": "builtin:bigmodel-coding-plan/glm-5.3"`（字符串 `provider/model`）
   - ✅ `"model": {"main": "provider/model", "lite": "provider/model"}`
   - ❌ `"model": {"provider": ..., "model": ...}` 或 `{"main": {provider,model}}`
     —— **整个 config.json 会被 zod 拒绝并回退为空**（连 plugins 都丢），报错仍
     "Model config is missing"，极易误判。
2. **baseURL**：builtin provider 在 CLI 侧无内置端点表，需在 config.json 显式
   provider 条目：`"provider": {"builtin:bigmodel-coding-plan": {"kind":"anthropic",
   "options": {"baseURL": "https://open.bigmodel.cn/api/anthropic"}}}`。
   （kind=anthropic/openai 时 baseURL 可省；openai-compatible 必填。）
3. **认证**：registry `resolveApiKey` 只认 ① provider options.apiKey ② env
   （anthropic kind → `ANTHROPIC_API_KEY`）。**桌面把 OAuth accessToken 直接存在
   `~/.zcode/v2/config.json` → `provider["builtin:bigmodel-coding-plan"].options.apiKey`**
   （coding-plan 订阅在服务端按 token 结算）。
   → **companion 方案：spawn 时读 v2/config.json 的 token 注入 env
   `ANTHROPIC_API_KEY`，不落盘、不打印、每次 spawn 现读（桌面续期后自动跟随）。**

最终生效的 `~/.zcode/cli/config.json` 增量（已写入本机，备份 config.json.bak-20260913）：

```json
{
  "model": "builtin:bigmodel-coding-plan/glm-5.3",
  "provider": {
    "builtin:bigmodel-coding-plan": {
      "kind": "anthropic",
      "name": "BigModel Coding Plan",
      "options": { "baseURL": "https://open.bigmodel.cn/api/anthropic" }
    }
  }
}
```

配套 spawn env：`ANTHROPIC_API_KEY = ~/.zcode/v2/config.json
  → provider["builtin:bigmodel-coding-plan"].options.apiKey`（无 token 则失败，
  提示桌面端登录）。

## session/send 后的完整事件序列（实测）

```
state.updated          patch.status="running"（prompt_started）
state.updated          全量 mode/model/permission/thoughtLevel 快照
computer-use/operation-event  kind=turn-started
v4/telemetry/event     kind=turn.started
v4/telemetry/event     kind=model.request.status status=model_request_started
                       （providerId/modelId/providerKind=anthropic/providerHostname=open.bigmodel.cn）
v4/telemetry/event     kind=model.request.status status=model_request_completed
v4/telemetry/event     kind=stream.chunk channel=text chunkLength=N   ← 文本流（可能多条）
v4/telemetry/event     kind=usage.delta inputTokens/outputTokens/totalTokens
computer-use/operation-event  kind=turn-completed
v4/telemetry/event     kind=turn.terminal status=success durationMs tokenCount
state.updated          patch.status="idle"
```

注意：正文流式即 `v4/telemetry/event` 的 `stream.chunk`（channel=text）；另有独立的
`session/events` 拉取通道。一次回合可能有多个 model request（如标题生成）。
工具调用回合还会出现 `tool.*` 事件与 `state.updated` 的 `activeToolCalls` 变化（未实测，
正式接入时对未知 kind 做透传即可）。

## 其他已知信息（静态提取，未实测）

- 方法全集（桌面与 CLI 同一份注册表）：`session/{create,resume,list,subagents,read,messages,
  events,subscribe,send,stop,cancelBackgroundTask,fork,compact,goal,close,setModel,
  setThoughtLevel,setMode}`、`workspace/*`、`mcp/list`、`plugins/*`、`automation/*`、
  `usage/stats`、`session/usage`、`interaction/*`。
- `--surface desktop` 可让 app-server 以桌面呈现面启动（对 attach 语义无影响，实测默认 electron）。
- 桥协议常量（若未来需要）：物理帧 1MiB、逻辑消息 16MiB、64 分片、30s 组装超时、
  id ≤256 字符 `^[A-Za-z0-9._~-]+$`；checksum `{algorithm:"crc32", value:/^[0-9a-f]{8}$/}`。

## 实验脚本

临时目录（会话级，不入库）：`appserver-probe.js`、`appserver-e2e.js`、`appserver-resume.js`。
`appserver-e2e.js` 已含完整生命周期 + token env 注入，可作为 companion 桥的参考实现。
核心逻辑已浓缩进本文档，正式实现进 `packages/agent-server` 或 companion 包。
