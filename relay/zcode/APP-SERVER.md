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
  - app-server 请求形状可见 `{id: number|string, method, params}`；经 relay 的 probe
    普通请求必须使用数值 ID，relay 会改写为房间内部数值 ID以隔离多 probe
  - 通知 `{method, params}`（无 id）
  - 响应 `{id, result}` / `{id, error:{code,message,data?}}`
  - device/app-server 反向请求：`id` 形如 `"server-1"`，客户端必须应答
    `{id:"server-1", result}`；probe 发出的字符串 `method+id` 会被 relay 显式拒绝
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

## 模型可用目录（2026-09-18 实测定论）

**没有独立的目录查询方法**：`session/models` / `model/list` / `provider/list` /
`session/providers` 全部 `-32601`。目录只能从会话快照投影取得：

- `session/resume` / `session/create` 响应的 `settings.model.available[]`
  （每项 `{ref:{providerId,modelId}, label, contextWindow?, reasoning?, …}`）
  是 **app-server 投影的可用目录权威**——Provider Registry 已合并
  内置发布配置 + 个人配置 + 账号权益后的最终结果。
- `settings.model.current` 只是**该会话当前选中的模型**，不是可用目录证据
  （可指向已失效模型）；不得并入 available 冒充可选项（companion 侧曾有
  此错误实现，已回退并有注释锚定）。
- `session/read` / `session/subscribe(includeSnapshot:true)` 走
  `modelAvailability:"current"`，最多返回一个当前模型，同样不是目录源。

**套餐动态模型（如 glm-5.3-flash）的来源链**（本机 3.12.3 / CLI 0.16.5 实测）：

1. 官方发布配置：配置端点 `/api/v1/client/configs?app_version&platform` →
   `data.configs.builtin_provider_config_json`（下载 URL）→ revisioned
   `zcode-builtin.json`（本机 revision 28，schemaVersion 1）。Individual/Team
   Coding Plan 声明 `GLM-5.3`、`GLM-5.3-Flash`；Start Plan 另有
   `GLM-5.3-Flash`/`GLM-5.2`/`GLM-5-Turbo`。落盘于
   `~/.zcode/v2/runtime/provider/<platform>/<version>/endpoint-<hash>/`。
2. 桌面端把权益物化进 `~/.zcode/v2/config.json`
   `provider["builtin:bigmodel-coding-plan"].models`（本机含小写
   `glm-5.3-flash`、`glm-5.3-highspeed`——**模型 ID 大小写敏感，精确匹配**，
   与发布配置的大写 `GLM-5.3-Flash` 是两套并存的 ID 空间）。
3. app-server 启动时经 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 等 env 拿到
   release（剥离该变量会「无法定位 Built-in Provider Config」直接退 1），
   合并后经 `settings.model.available` 投影。

**结论**：手机端目录 = `x/model/catalog`（engine available + 导入快照），
引擎侧以 `session/resume.settings.model.available` 为唯一可用性依据；
会话要用的具体模型 ID 一律以实测投影的原始大小写为准，不做大小写归一。

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

## 同步层协议实测（第二轮，2026-09-13，probe-sync*.js）

> 只读探测 + 一次最小真实回合（2 个测试会话，事后 `session/close` 关闭）。
> 目标：回答同步层重构（PLAN-zcode-remote-v2 P1）的四个协议问题。

### Q1 推送通道：`session/subscribe` 确认存在且带正文

- 参数 `{sessionId, deliveryKind}`，`deliveryKind` 必填：
  `"desktop-continuous" | "web-remote-replayable"`（zod 报错直接给出枚举）。
  **`web-remote-replayable` 即官方网页远程使用的可回放事件流。**
- 响应 `{eventSeq, events: [...], sessionId}` —— 从游标起的快照（新会话 eventSeq=0）。
- 订阅后每个事件以 `session/event` 通知帧推送：

```json
{"method":"session/event","params":{
  "deliveryKind":"web-remote-replayable","eventId":"<UUID>","seq":6,
  "sessionId":"sess_…","timestamp":…,"traceId":"…","turnId":"turn_…",
  "type":"model.streaming",
  "payload":{"assistantMessageId":"msg_…","delta":"ok","done":false,"kind":"text_delta"}}}
```

- **`type: "model.streaming"` 的 `payload.delta` 就是流式正文**——正文内容直接推送，
  不再需要轮询 `session/events` 拉 text_delta。`done:true` 表示本条消息流结束。
- 实测一次最小回合推送的 type 序列（9 帧）：
  `session.titleUpdated → turn.started → session.updated ×2 → session.titleUpdated →
  model.streaming → session.updated → model.response → turn.completed`
  - `model.response`：带 `content`（完整回复文本）、`usage`、`contextWindow: 1000000`、
    `stopReason`、缓存命中统计。
  - `turn.completed`：带 `response`、`tokenCount`、`duration`、`toolCallCount`、
    `cacheStats` —— 纯文本回合可凭它本地收尾，免权威刷新。

### Q2 帧归属：所有帧自带 sessionId

`session/event`、`state.updated`、`v4/telemetry/event` 的 params 均含 `sessionId`
（telemetry 另含 `eventSeq`、`turnId`、`assistantMessageId`）。
**按帧严格路由可行，多会话订阅并存可行。**

### Q3 去重与顺序

- `eventId` 为 UUID（构造性全局唯一）——跨会话统一去重安全。
- 每会话另有单调递增整数 `seq`（session/event）/`eventSeq`（telemetry）——
  排序与断线补放游标用。重连后从 last-seq 重新 subscribe 即可补放（replayable 语义）。

### Q4 非 active 会话可达性

- `session/events`（拉）要求会话在本进程 materialize 过：从未 resume 的会话 →
  `-32004`。resume 切走后，先前 materialize 过的会话事件**仍可读**（实测 ok）。

### 跨进程实时性：桌面自身回合的流式正文不可达（probe-live2.js 定论）

对"桌面进程正在驱动的会话"（真实现场：探针观察自己所在的活跃会话，期间该会话
持续产出数千 token），第二个 app-server 进程三种通道全部收不到流式增量：

- `session/subscribe` 推送（`web-remote-replayable` 与 `desktop-continuous`
  两种 deliveryKind 均建立成功）：**0 帧**；
- `session/events` 周期拉取：事件游标 40s 纹丝不动（回合进行中连生命周期事件
  都不落可回放日志）；
- `v4/telemetry` 通知：不跨进程（进程内总线）。

跨进程**可见**的只有：完成后的消息全量（resume 拉到 99 条/665KB）、回合边界的
生命周期事件（`checkpoint.created`/`session.titleUpdated`/`session.resumed`）、
`session/list` 的 stale 元数据（running 显示为 idle）。可回放日志本会话总计仅
28 个序号——几万字流式输出不留任何逐块 text_delta 记录，"replayable"回放的是
回合级事件而非 token 流。

**推论**：`text_delta` 只在运行回合的那个进程的事件总线上存在。手机经 companion
发起的回合跑在 companion 的 app-server 进程内，实时流完整可用（主路径，已实测）；
"手机围观桌面自己跑的回合"经 app-server attach 不可实现——官方远程能做到是因为
它隧道的是桌面 UI 进程本身。若确需此能力，只能走会话存储文件级观察
（文件是否逐块落盘未验证）或官方远程。

### Q5 `session/read` 轻量 meta：确认

- active 会话上 read ≈ 2–5 KB（keys：session/projection/runtime/settings/
  slashCommands/todos/todoGroups/messages），对比 resume 全量 messages
  （48 条 ≈ 414 KB）。非 active → `-32004`。

### 边界与坑（本轮新增）

- `session/create` 必须带 `workspace: {workspaceKey, workspacePath}`（zod 强校验）。
- `session/send` 可能以**字符串 result**（非 error 帧）返回业务拒绝：
  `"历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。"`
  —— 新进程 resume 老会话、其存储模型解析失败时出现；需调 `session/setModel` 兜底。
- `session/close` 返回 `{closed:true}` 但同进程 `session/list` 仍会列出该会话
  （close ≠ delete，协议无 delete）。
- resume 响应永远携带全量 messages——手机端应忽略该数组、自行分页
  `session/messages`；companion 可选剥离该数组降低 relay 帧体积（优化项）。

## 分页契约实测（第三轮，2026-09-14，probe-sync3.js）

> 新会话连发 3 个最小回合（"只回复数字 N"，6 条 user/assistant 消息），
> 对 `session/messages` 做分页矩阵实测。结论供手机端同步层（Dart
> `_fetchTailWindow`/`_pullIncremental`/`_normalizeChronological`）钉死契约。

### 结论速查

| 问题 | 实测结论 |
| --- | --- |
| `{limit:N}` 返回方向 | **最新 N 条（尾部窗口）**，页内**升序（旧→新）**。limit=2 返回的是最后 2 条，不是最旧 2 条 |
| `{afterMessageId}` 窗口语义 | **cursor-forward**：返回游标之后**全部**消息（升序）；游标=最后一条 → 空 `messages:[]` |
| `{afterMessageId, limit}` 混合 | 游标后缀中的**最新 N 条**（升序）——即 "后缀 ∩ newest-N"（后缀本身是尾部集合，两种解释等价） |
| 未知 afterMessageId | **不报错**，退化为 newest-N（等同无游标）。水位失效时自然回退，无需专门兜底 |
| `time.created` 粒度 | **毫秒**（13 位 epoch ms）；本样本 6/6 唯一（user→assistant 间隔实测 0.4–2.6s），同毫秒平局概率低 |
| 响应形状 | 仅 `{messages:[...]}`，无 total/hasMore 字段；**收敛信号 = 返回条数 < limit** |

### 对同步层的含义

- 尾窗拉取 `{limit:40}` 一次即得最新 40 条、已按时间序排好——直通展示。
- 增量刷新 `{afterMessageId:水位, limit:200}`：单页最多 200 条新增（升序），
  合并后水位推进到返回页尾部，`不足一页` 即收敛。
- ⚠️ 若游标后新增 **超过 limit**，返回的是最新的 limit 条（中间跳空、水位
  直接推进到尾部）——正常回合（每回合几条）不会触发；极端补放场景可接受。
- Dart `_normalizeChronological` 的降序投票从此只是协议漂移兜底，
  主路径按升序直通（见 zcode_chat_store.dart 注释）。

## 工具回合实测（2026-09-14，probe-toolturn.js）

> 安全约束：cwd 为 mkdtemp 临时目录；权限请求先捕获完整 params 再拒绝；
> 全程零真实工具落地（结束时 `tmpDirLeftovers: []` 自证）。
> 直连真 app-server stdio（probe-sync2 模式），真模型 glm-5.3，4 轮会话。

### 权限模式（session/setMode）

- zod 全枚举：**`plan | build | edit | yolo | auto`**（发 `default` 被
  -32602 ZodError 枚举拒绝）。
- 响应携带类 projection 全量快照（activeToolCalls/backgroundJobs/
  pendingPermissions/…）。设 `edit` 后响应快照 `projection.mode` 显示
  `"build"`（快照口径差异），随后 `state.updated` 的 `patch.mode =
  {"current":"edit"}` 为准。
- 触发条件实测：**edit 模式下 `echo`（低风险）自动放行、直接执行**；
  `printf 'X' > file`（高风险）触发权限确认反向请求。
  不 setMode 的临时目录默认同样自动放行低风险命令。

### 权限确认反向请求：`interaction/requestPermission`

params 完整字段（实测原文）：

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `input` | `{command, description, …}` | 工具入参（形状随工具而定） |
| `reason` | string | 如 `"High risk tools require explicit approval"` |
| `requestId` | `"perm_<uuid>"` | 权限请求自身 id |
| `riskLevel` | `"high"` | 风险级别 |
| `sessionId` / `turnId` | string | 归属 |
| `toolCallId` | `"call_…"` | 对应工具调用（与 tool.updated/权威 part 一致） |
| `toolName` | `"Bash"` | 工具名 |
| `options` | 数组 ×3 | 见下 |

options（应答的本质是"选一个 option，回放它的 response"）：

```json
[
  {"kind":"allow_once","optionId":"allow_once","name":"Allow once",
   "response":{"decision":"allow","reason":"Approved once"}},
  {"kind":"allow_always","optionId":"allow_project",
   "name":"Always allow in this project",
   "description":"Do not ask again for matching requests in this project",
   "response":{"decision":"allow",
     "permissionUpdates":[{"behavior":"allow",
       "rules":[{"ruleContent":"printf 'A' > probe-a.txt","toolName":"Bash"}],
       "type":"addRules"}],
     "reason":"Approved for this project"}},
  {"kind":"deny","optionId":"deny","name":"Deny",
   "response":{"decision":"deny","reason":"Denied"}}
]
```

### 应答 result schema 与畸形应答实验（3 组）

result = 所选 option 的 `response` 原文：`{decision:"allow"|"deny",
reason:string, permissionUpdates?:[…]}`。

| 应答 | 服务端行为（permission.resolved） |
| --- | --- |
| error 帧（-32000 拒绝） | `{"decision":"deny","reason":"Permission request failed"}` |
| result `{}`（空对象） | 同上——静默 deny |
| result `{"approved":"yes"}`（错类型） | 同上——静默 deny |
| result `{"decision":"deny","reason":"probe denied on purpose"}`（合法） | `{"decision":"deny","reason":"probe denied on purpose"}`——**reason 原文回显，schema 证实** |

畸形应答**没有任何 zod 回显**：无同 id 后续帧、无 stderr 输出——
客户端读不到校验错误，只能靠回放 option response 原文保证合法。
（`-32602` 的 zod schema 提示只在**请求**方向存在。）

### 工具事件序列（session/event `tool.updated` 的 kind 轨迹）

一次 Bash 调用：`scheduled → started → progress×N → result → batch`

| kind | payload 形状（实测） |
| --- | --- |
| `scheduled` | `{toolCallId, assistantMessageId, toolName, dependencies:[], parallelGroupIndex, canRunParallel, schedule:{parallelGroups,executionOrder}, inputByteLength, inputOmitted:true, inputRef:"model_stream"}`（**input 不推送**，只有长度与引用） |
| `started` | `{toolCallId, toolName, startedAt}` |
| `progress` | `{toolCallId, toolName, elapsedMs, pid, stdoutBytes, stderrBytes, outputBytes}`（周期性） |
| `result` | `{toolCallId, result:{success, content, perf:{totalMs,detail}, truncated, originalBytes, returnedBytes, budgetStrategy}, duration}` |
| `batch` | `{toolCallIds:[…], successCount, errorCount}`（一批工具的汇总） |

telemetry 侧 `v4/telemetry/event kind=tool.lifecycle` 的 phase 轨迹：
`scheduled → started → progress×N → completed`（completed 带 `durationMs`、
`performance{totalMs,commandRunMs,noOutputMs,exitCode,timedOut,…}`）。

权限相关事件（session/event 推送，与反向请求并行）：

- `permission.requested`：payload 与反向请求 params 同构 +
  `suggestedPermissionUpdates`（即 allow_project 的 permissionUpdates）。
- `permission.resolved`：`{requestId, toolCallId, decision, reason}`。

### 拒绝后的回合行为

- **一个回合可触发多次权限请求**（模型换路径重试：相对路径被拒 → 绝对
  路径再请求，requestId/toolCallId 均新）——手机 UI 必须支持串行多请求。
- 拒绝后回合**正常收尾**（`turn.completed` resultType=success），模型在
  正文里报告失败原因；权威消息中该 tool part `state.status="error"`、
  `state.error` = 拒绝 reason 原文（畸形应答时为 "Permission request failed"）。

### 权威消息的 tool part 形状（session/messages）

```json
{"type":"tool",
 "callID":"call_e6328b076bbe4177825025eb",   // 注意：大写 D
 "tool":"Bash",                               // 字符串，不是 {name}
 "state":{
   "status":"completed",                      // completed | error | …
   "input":{"command":"echo hello","description":"Print hello"},
   "output":"…stdout 原文…",                  // 成功时
   "error":"Permission request failed",       // 失败时（与 output 互斥）
   "title":"Bash",
   "metadata":{"schemaVersion":1,"serialization":{…}},
   "time":{"start":1789348651854,"end":1789348665621}},
 "id":"part_…","sessionID":"sess_…","messageID":"msg_…"}
```

assistant 消息可以只含工具 part（`step-start / tool / step-finish`，
无 text part）——映射时不能按"无文本即丢弃"过滤工具消息。

### 其他

- 新事件类型：`streamRecovery.updated`、`turn.steerQueued`（载荷未展开，
  未知类型透传忽略即可）。
- **AskUser 类反向请求未能触发**（各轮均未出现）——其方法名/params/
  应答 schema 仍未知，手机端解析维持兜底形状，待后续实测。

## 实验脚本

临时目录（会话级，不入库）：`appserver-probe.js`、`appserver-e2e.js`、`appserver-resume.js`。
`appserver-e2e.js` 已含完整生命周期 + token env 注入，可作为 companion 桥的参考实现。
核心逻辑已浓缩进本文档，正式实现进 `packages/agent-server` 或 companion 包。

同步层第二轮探针（已入库 `relay/zcode/`）：`probe-sync.js`（只读：list/read/resume/
subscribe 参数枚举/events 归属/切换后可达性）、`probe-sync2.js`（subscribe
`web-remote-replayable` + 真实最小回合推送帧抓取，`--session` 可复用会话）、
报告 `probe-sync*-report.json`。

第三轮探针（U2，已入库）：`probe-sync3.js`（分页契约，见下节）、
`probe-toolturn.js`（工具回合形状，见下节；`--mode`/`--only`/`--prompt`/`--no-stop`
可单测某变体），报告 `probe-sync3-report.json`、`probe-toolturn-report*.json`。

第四轮探针（跨进程实时性，已入库）：`probe-live.js`/`probe-live2.js`
（第二个 app-server 进程对桌面正在驱动的活跃会话做双 deliveryKind 订阅 +
周期拉取观察，结论见"跨进程实时性"节；同步写 `probe-live2.log` 防管道缓冲丢日志）。

## 空闲存活实测(2026-09-14,probe-idle.js)

> probe 角色认证进房后**完全静默**(仅把收到的反向请求自动回绝),测量空闲连接
> 被谁何时掐断。环境:本机 loopback 全真链路 `probe-idle.js → server.js(默认配置
> authTimeoutMs 10000 / roomTtlMs 60000 / sweepIntervalMs 1000 / pingIntervalMs 30000)
> ← companion.js`,companion spawn 真实 `zcode app-server`(R1 配对即拉起,全程零
> appserver-* 异常事件)。relay 日志时间戳为 UTC(本地 UTC+8)。

### 每轮结果

| 轮次 | 时长 | 探针侧输出 | relay 侧 ws-close |
| --- | --- | --- | --- |
| R1 | 300s | `CONN#1 authed pair=matched`,无 closed 行,到点自退 | 16:20:20.867 probe 1006(探针 process.exit 裸断,非 relay 行为) |
| R2 | 300s | 同上 | 16:27:17.173 probe 1006(自退;中途 16:25:44 有一次 device 1006,见下"插曲") |
| R3 | 300s | 同上;全程 28s 间隔巡检:relay 零新事件、companion 恒 `state=paired`、TCP 连接数恒定 | 16:36:54.823 probe 1006(自退) |
| R4 | 600s | 同上 | 17:00:23.625 probe 1006(自退) |

3×300s + 1×600s,空闲连接 **100% 存活**;期间出现的 close 全部是探针自身到点
`process.exit`(未发 close 帧,故 relay 记 1006)。同一 sid/hash 跨全部轮次复用,
房间从未被清扫。

### 负对照:不回 pong 的端(临时脚本,未入库)

认证后暂停底层 socket(不再读 relay ping → 无 pong,双侧墙钟对齐):

- 认证 16:46:40.196 → relay `ws-close role=probe code=1006` 于 16:47:32.276,
  **+52.1s 被 terminate**——正是"第 1 个心跳周期置 alive=false、第 2 个周期
  terminate"的代码路径,相位决定窗口 30–60s。
- 被掐端因不再读 socket,客户端侧 150s 内毫无感知(**半开**)。

### 归因结论

1. **空闲连接不会被任何一方掐断。** relay 心跳是协议层 ping,ws 客户端库自动回
   pong,应用层完全静默也满足;roomTtlMs(60s)只清**空置**房间(房内 device+probe
   齐全时 inactiveAt=null);companion 无空闲清理逻辑(状态恒 paired);app-server
   在 stdio 上同样静默。
2. **心跳清扫器确实武装着**——空闲存活是自动 pong 的功劳,不是心跳没开。
3. **半开是唯一真实风险**:真正失联的端 30–60s 内被 relay 清出房间,但失联端自己
   要到下一次收发才发现;恢复路径即已实现的"重连 + 同角色接管"(fe22b20)。

### 插曲:R2 中途的 device 1006(环境噪音,非本链路)

16:25:44.576 relay 记录 `ws-close role=device code=1006`,但 companion 日志全程无
`state=disconnected`,其 socket 未死(16:27:17 仍收到房间 pair 通知并记
waiting-pairing);事后 `/health` 仍 `rooms:1, devices:1`;R3 全程监控未复现。证据
指向本机残留的旧会话客户端重连 127.0.0.1:18884(自带房间,死后被 TTL 清扫)——
对本测量零影响,非 relay bug。

### 保活策略建议(仅建议,未改任何代码)

- **手机 App 无需为 relay 增加应用层心跳**:协议层自动 pong 已满足 relay 30s 心跳;
  公网路径(wss://zcode.5945.top 经 nginx)的空闲超时由 relay 每 30s 的 ping/pong
  双向流量刷新(nginx proxy_read/send_timeout 默认 60s > 30s)。
- **半开主动检测(可选)**:前台时低频发 `pair_status_query`(60–120s 一次足矣),
  发送失败即触发重连→接管;间隔无需短于 relay 心跳周期。
- **relay 配置不建议调整**:pingIntervalMs=30s 同时满足半开清理(30–60s)与中间
  设备保活,缩短只增加移动端耗电;companion 无需改动。

## NAS Docker 节点部署实测（2026-09-15）

- 镜像 node:20 不可用：zcode.cjs 依赖内置 `node:sqlite`（需 node ≥22.5），
  改用 `node:24-alpine` 后引擎可启动。
- 引擎 cwd 必须与 `--cwd`（代理工作区）分离：CLI 从 `<引擎cwd>/app-server`
  解析内部实现；cwd 指向挂载工作区时报 `Cannot find module '/workspace/app-server'`。
  brain-adapter 以 `ENGINE_CWD` 环境变量显式指定（默认 = WORKSPACE）。
  （brain-adapter 已于 2026-09-17 退役删除，本节为历史实测记录；cwd 与
  `--cwd` 必须分离这一结论对任何无头节点形态仍然有效。）
- 连接 relay 必须请求 `wzxclaw-<token>` 子协议（与旧桌面客户端一致），
  否则 ws 客户端报 "Server sent a subprotocol but none was requested" 后 1006 断开。
- PC（node 24 win32）同 bundle + 同参数直接可用；容器内 engine 启动后
  `require('/opt/zcode/app-server')` 仍失败——CLI 0.16.5 的 app-server
  实现解析在 linux 容器内尚未打通（遗留，见 PLAN-brain-network-v3 M2 验证节）。
- 节点注册/发现本身已验证：Room [wzxclaw-brain] desktop joined +
  identity name=NAS（relay 日志），手机端 desktop_list 可见性待旧 UI APK 验证。

### 引擎 cwd 依赖（NAS 容器部署发现，2026-09-15）

`zcode.cjs app-server --cwd <ws>` 的进程 cwd 影响内部模块解析：
- cwd = 工作区目录（Windows PC 实测）：正常启动 ✓
- cwd = bundle 目录本身（容器 `/opt/zcode`）：启动即
  `Cannot find module '<cwd>/app-server'` 崩溃（crash 循环，restart 无法恢复）
- 容器内 node:20 不可用（缺内置 `node:sqlite`），须 node ≥22.5（实测 node:24-alpine 可解析启动）
- 工作区含 `.zcode/` 标记目录不影响崩溃与否（已排除）

推论：CLI 以 `path.join(process.cwd(), 'app-server')` 之类的动态解析加载
app-server 实现；无头容器部署需让引擎 cwd 指向一个含 `app-server` 模块的
目录（例如把 CLI 包目录整体挂载后从其父级启动，或确认官方 Linux 发行包）。
待专项：美化 zcode.cjs 定位该 require 调用点后给出容器化标准方案。

## companion 本地扩展协议 x/*（2026-09-16，probe-git.js 实测 + companion.test.js 钉住）

背景：手机端要做 git 分支选择器与工作区新鲜度过滤，但 app-server 协议不提供
相关方法（`git/*`、`workspace/list`、`workspace/info` 等 13 个候选方法实测
全部 `-32601 Method not found`；官方桌面 App 的 git UI 由其 IDE 层自实现，
不经 app-server）。故在 companion（与 app-server 同机）落地本地扩展方法族，
`x/` 前缀，手机 → relay → companion 拦截执行、不转发给 app-server。

| 方法 | params | 返回 | 说明 |
|---|---|---|---|
| `x/git/status` | `{path}` | `{branch, dirty}` | `git --no-optional-locks status --porcelain=v1 -b`；detached HEAD 时 branch 为 `""` |
| `x/git/branches` | `{path}` | `{branches:[{name,current}]}` | `for-each-ref refs/heads`，current 标记 `*` |
| `x/git/checkout` | `{path, branch, create?}` | `{ok:true, branch}` | create=true 时 `-b` 新建；分支名白名单 `[A-Za-z0-9][A-Za-z0-9._/-]{0,119}` 且禁 `..`、结尾 `.lock`（防选项注入，禁止前导 `-`）；**不得加 `--` 分隔符**（checkout 语义中 `--` 后一律按 pathspec 处理） |
| `x/fs/exists` | `{paths:[≤50]}` | `{exists:[bool]}` | 目录存在性（工作区列表过滤已删除路径用） |

错误帧的 `error.code` 一律为数字（Android 客户端按数值解析）：`-32100`
（`data.reason=X_BAD_PARAMS`，参数/路径非法）、`-32101`
（`data.reason=X_GIT_TIMEOUT`，git 10 秒超时）、`-32102`
（`data.reason=X_GIT_FAILED`，git 非零退出或启动失败，message 为 stderr 首行）；未知
x/ 方法为 `-32000`（ERR_UNHANDLED）。已知限制：companion 进程的 PATH 需含 git
（计划任务环境实测可用；若无 git 报数值失败码，显性失败不静默）。


## 附件入口实测（2026-09-17，probe-attach.js / probe-attach2.js）

背景：官方图片部件形状（model-io 日志实测）为
`{type:'image', image:<base64>, mediaType:'image/png'}`，用户消息 content
为部件数组（text/image 交错）。

| 实验 | 结果 |
| --- | --- |
| `session/send` content 传部件数组 | ❌ **-32602 ZodError**：`content: expected string, received array`——入口只收字符串 |
| 图片落盘工作区 + 文本引用路径（"用 Read 读 red.png"） | ✅ **成立**：agent 调 Read → 引擎自动转 analyze_image（云端 URL）→ turn.terminal success |

**结论（附件实施方案）**：手机附件一律走「上传落盘工作区 + 消息文本引用
路径」，引擎侧 Read→视觉管线自洽。类型无关：任意文件可传可引用；
图片/PDF/文本可被深度理解（模型模态决定），二进制为存档档。
