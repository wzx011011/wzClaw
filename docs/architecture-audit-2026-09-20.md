# wzxClaw 当前架构代码审查（2026-09-20）

## 评审结论：有阻断项需修复

基线：`0ad2dc1`，分支 `feat/zcode-remote-integration`。审查开始时工作树干净。本次只审查业务实现，新增本报告与[交互式架构图网页](./architecture-review-2026-09-20.html)，没有修复业务代码、构建、发布、重启生产服务或提交 Git。

范围包括 Android 的现用 UI 与当前 app-server 协议栈、NAS relay、CLI / Electron companion、相关测试、协议实测记录、CI 与发布文档。规则源是根 [AGENTS.md](../AGENTS.md)，协议事实源是 [APP-SERVER.md](../relay/zcode/APP-SERVER.md)。下列 15 项按触发条件和证据记录；P0 项有明确的启用途径前提，不代表已观测到生产泄露。

| 等级 | 数量 | 含义 |
|---|---:|---|
| P0 | 1 | 配对持有者凭据进入自启动日志，启用该路径前必须修复 |
| P1 | 9 | 会话目标、设置失败、停止状态、协议形状、模型恢复及契约门禁 |
| P2 | 4 | GUI 异步状态、保存失败一致性和发布依赖遗漏 |
| P3 | 1 | 现行架构文档与实现漂移，归为一组 |

## 实际架构

```text
Android 现用 UI
  ├─ ZcodeChatStore：按 sessionId 保存状态、订阅、事件补放与权威回填
  │    └─ SQLite：已确认消息的本地副本
  └─ ConnectionManager：一个活动 ZcodeRelayClient，多份已保存配对
       │ WSS，data 信封封装原生帧 / x/*
       ▼
NAS relay / server.js：一个 device + 多 probes 的房间路由
  ├─ 普通 RPC：重写 ID，按发起手机定向返回
  ├─ 通知：房间广播
  └─ 反向交互：只交一个健康 probe，离席时移交 / 待命补投
       │ WSS
       ▼
节点 companion
  ├─ GUI：作为模块运行于 Electron main；renderer 经 preload 访问
  ├─ CLI：独立 Node 入口
  ├─ x/git、x/fs、x/file、导入目录：在节点本机处理
  └─ AppServerBridge
       │ stdin / stdout，NDJSON
       ▼
ZCode app-server 独立子进程
  ├─ 会话运行归属、回合、订阅、事件与模型目录投影
  └─ 模型调用与本机工具 / 工作区访问
```

模型网络请求按 provider 配置出站；自托管 relay 不代表模型推理离线。relay 不执行工具，也不持有会话数据库。GUI 先上线 relay，再独立预检 runtime 并热注入 descriptor；设备在线与引擎健康是两个状态。

以下现状不能从历史蓝图直接推断：

- Android 当前只有一个活动节点连接，并不存在运行中的 `ZcodeDesktopRegistry` 多连接注册表。依据：`wzxClaw_android/lib/services/connection_manager.dart:169`、`:240`。
- Electron 内嵌 companion 模块，单独启动的是 app-server 子进程。依据：`companion_app/main.js:303`、`relay/zcode/companion.js:323`。
- `ChatRuntimeService` 调用原生 `session/*`，不能把全部 services 都标作 `x/*`。依据：`wzxClaw_android/lib/services/chat_runtime_service.dart:55`。
- token relay / brain-adapter 支线已经退役；Legacy Desktop 不属于当前主架构和主发布链。

## P0 阻断（必须修）

### R01 · CLI 自启动会把配对凭据永久追加到日志

**位置：** [companion.js:1898](../relay/zcode/companion.js#L1898)、[companion-autostart.vbs:50](../relay/zcode/scripts/companion-autostart.vbs#L50)。

**触发与证据：** 启用仓库保留的 VBS 自启动入口时，脚本用 `--no-qr` 启动 CLI，却把 stdout / stderr 全部追加到 `autostart.log`。`--no-qr` 只抑制终端二维码，`onPairing` 仍无条件 `console.log(url)`。URL 包含持有者配对凭据，因而进入普通运行日志。`relay/zcode/README.md:91` 还指引从该日志取配对链接。

**影响与规则：** 违反 AGENTS 的“sid/hash/token/QR 不进日志”约定。日志复制、诊断或归档会一并携带配对能力。当前文档标明计划任务 Disabled；本次没有启用任务、读取实际日志或确认生产泄露。

**建议与测试：** 非交互 / 自启动路径禁止把完整配对材料写 stdout，配对材料仅经专门受保护的产物或 UI 交付；增加覆盖“CLI + --no-qr + 日志重定向”整条路径的断言，确认日志不包含任何配对凭据。

## P1 应修

### R02 · 预选模型或权限模式设置失败后，首条消息仍会发出

**位置：** [home_page.dart:967](../wzxClaw_android/lib/pages/home_page.dart#L967)、[:975](../wzxClaw_android/lib/pages/home_page.dart#L975)、[:3663](../wzxClaw_android/lib/pages/home_page.dart#L3663)；[zcode_chat_store.dart:1020](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L1020)。

**触发与证据：** 创建会话后，`_applyNodeDefaultToSession` 的目录查询或 `applySessionModel` 失败只记录日志；预选权限模式先被清空，再调用 `setMode`，但返回的 `false` 不被检查。随后 `home_page.dart:980` 无条件调用 `sendMessage`。`session/create` 会继承引擎全局当前模型，手机节点默认必须另行应用，协议已在 `APP-SERVER.md:175` 实测说明。

**影响与规则：** 用户选择的模型未生效仍可能发送给引擎默认模型；选择 `plan` 失败仍可能按原模式执行。违反“不做假的成功”和“失败方向偏向多确认”。发送入口还会清除 store 错误，使设置失败更难察觉。

**建议与测试：** 将模型、权限模式等首发前置设置的成功纳入发送条件；失败保留输入与选择，并显式展示原因。补充目录失败、setModel 错误、setMode 返回失败时不得发出 `session/send` 的 UI 到协议链路测试。

### R03 · 停止请求失败仍把运行中的回合标为空闲

**位置：** [zcode_chat_store.dart:1273](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L1273)、[:2957](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L2957)、[:2998](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L2998)、[:3029](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L3029)；[home_page.dart:916](../wzxClaw_android/lib/pages/home_page.dart#L916)。

**触发与证据：** `session/stop` 超时或返回错误被 `catch` 吞掉，随后仍调用默认 `finishTurn=true` 的 `_refreshAuthoritative`。即便消息刷新也失败，`finally` 仍执行 `_finishTurnFlags`，清掉 streaming / waiting，并且没有通过 `session/read` 确认引擎空闲。

**影响与规则：** 引擎可能仍运行，手机却显示已停止，并在 500ms 后冲出下一条排队消息。若连接已断，队首还可能先被移除，然后因未配对而无法发送。违反权威状态单一真相与失败模式方向。

**测试与建议：** `test/zcode/zcode_chat_store_test.dart:399` 覆盖停止成功，不覆盖停止失败但引擎继续运行。应分别验证“已停止”“仍运行”“结果未知”，只有权威终止状态才收尾和推进发送队列。

### R04 · 新会话首发跨异步等待后会被投给另一个会话

**位置：** [home_page.dart:947](../wzxClaw_android/lib/pages/home_page.dart#L947)、[:967](../wzxClaw_android/lib/pages/home_page.dart#L967)、[:980](../wzxClaw_android/lib/pages/home_page.dart#L980)；[zcode_chat_store.dart:1052](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L1052)。

**触发与证据：** 创建 A 后保存 `newSid`，等待节点目录 / 模型设置时用户切换到 B。`newSid` 只用于模型设置；后续的思考档位、权限模式及 `sendMessage(text)` 都重新依赖当前活动状态。`sendMessage` 在入口读取 `_activeSessionId`，此时已是 B。

**影响与规则：** 为 A 输入的首条任务被发送到 B；若两个会话工作区不同，任务执行位置也会偏离用户原意。该触发在同节点切会话就成立，不依赖断线后错误回包等假设。违反每会话状态归属与“活动视口不能成为在途操作的新目标”。

**建议与测试：** 整个创建、设置、发送操作绑定固定 sessionId 与连接身份；目标失效则明确失败。用可控延迟的目录 / 模型 RPC，在等待期间切换活动会话，断言后续设置和首发仍指向 A 或被明确取消，绝不投给 B。

### R05 · 子智能体摘要仍读取不存在的 messages 字段，测试固化了错误形状

**位置：** [zcode_chat_store.dart:1297](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L1297)；[zcode_chat_store_external_test.dart:81](../wzxClaw_android/test/zcode/zcode_chat_store_external_test.dart#L81)。

**触发与证据：** `fetchSubagentThreads` 调用 `session/subagents` 后读取 `result['messages']`。协议实测 `APP-SERVER.md:477` 明确返回 `running[]`、`ended.items[]` 等字段，并无 `messages`。真实非空列表因而落成空摘要。该路径由 `GoalStore` 和状态面板消费；独立子智能体页面已使用正确形状，形成两套处理。

**影响与规则：** 状态面板可能看不到实际子任务。现有测试虚构 `messages` 并断言多余的 `action:'show'`，无法防止真实协议回归。违反“协议以实测为准”“单一真相”“契约钉到每一环”。

**建议与测试：** 以实测 fixture 覆盖运行中和已结束任务；复用同一解析模型。已结束子任务显示 title / status / summary，不假设可以读取其子会话完整转录。

### R06 · session/read 的当前模型投影污染了自动恢复用的完整目录

**位置：** [zcode_chat_store.dart:2815](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L2815)、[:3063](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L3063)、[:1225](../wzxClaw_android/lib/zcode/zcode_chat_store.dart#L1225)。

**触发与证据：** `openSession` 先用 resume 播种完整目录，再 read 元数据；`_applyReadMeta` 把 read 的 `settings.model.available` 传给同一个节点级 `_cacheModelCatalog`。`APP-SERVER.md:122` 明确 read 使用 `modelAvailability:'current'`，最多只有当前模型，不是目录源。非空时覆盖完整目录；空数组又不清理旧目录。

**影响与规则：** 模型不可用时，自动自愈从污染后的 `_availableModels.first` 选择模型，可能再次选中失效 current，漏掉已知有效备选。手机模型弹层另走 `x/model/catalog`，本条不宣称弹层必然只显示一个模型。违反模型目录权威与单一真相。

**测试与建议：** 现有模型恢复用例缺少真实的“resume 完整目录 → read 当前投影”序列。应把目录更新限制在实测允许的来源，current 独立更新会话；测试目录清空、失效 current 和完整目录保留。

### R07 · companion 用首个历史会话决定全节点模型目录

**位置：** [companion.js:934](../relay/zcode/companion.js#L934)、[:941](../relay/zcode/companion.js#L941)、[:1350](../relay/zcode/companion.js#L1350)；GUI 同步副本行为相同。

**触发与证据：** 查询 `session/list` 后仅 `find` 第一条合法 sessionId 并 resume；若该会话属于正在运行的桌面进程，返回 `-32004` 后整个目录查询立即降级，不尝试后续可用会话。`session/list` 包含桌面会话、会话有单运行时归属，均已有协议实测依据。

**纯内存复现：** 列表为 `[desktop-owned, companion-owned]`，首条 resume 返回 `-32004`，第二条可返回完整 available。实际请求只有 list 和首条 resume；输出 `degraded:true, models:0`，第二条从未查询。

**影响与规则：** 节点引擎有可用模型和可访问会话，手机仍拿不到 engine 目录；导入项只标作 `available:false`，不能弥补。违反协议归属约束与契约测试要求。`companion.test.js:1422` 起的目录用例仅覆盖可成功恢复的单个 fake session。

**建议：** 明确目录查询的会话来源和归属；遇到不可访问会话不能据此判定整个节点无目录。测试首条不可访问但后续可用、列表为空与真正桥不可用的不同结果。

### R08 · 套餐目录刷新 Promise 不释放，首次未登录后无法恢复

**位置：** [companion.js:499](../relay/zcode/companion.js#L499)、[:505](../relay/zcode/companion.js#L505)、[:523](../relay/zcode/companion.js#L523)；[main.js:309](../companion_app/main.js#L309)。

**触发与证据：** `refreshPlanModels` 优先返回 `planFetchInFlight`，成功分支不清理它。首次认证读取同步抛错时，内部虽然设为 null，但外层赋值又把 async 函数返回的已完成 Promise 写回。后续登录、runtime ready 和目录请求复用同一 companion，永久拿到第一次的 null。

**纯内存复现：** 成功后时间推进一小时再次刷新，实际抓取次数仍为 1，仍是首份目录；首次无认证后补认证，实际抓取次数为 0，结果始终 null。另一个相关边界是目录入口 `:1347` 只在 `!planModelIds` 时触发刷新，不能仅修 Promise 就宣称实现了 TTL 刷新。

**影响与规则：** 首启登录恢复不能带来套餐模型，已成功目录也可能长期不更新。违反失败恢复与“一步到位”。现有 plan-overlay 测试覆盖 fetch / overlay 单函数，缺少 companion 缓存和登录恢复的生命周期测试。

**建议：** 用正确的 single-flight 完成清理，区分成功缓存与在途状态；把 TTL 和登录恢复都接到真实调用入口，并验证恢复后 overlay 的生效边界。

### R09 · 已验证 runtime 基线没有覆盖所有启动入口

**位置：** [companion.js:40](../relay/zcode/companion.js#L40)、[:223](../relay/zcode/companion.js#L223)、[:651](../relay/zcode/companion.js#L651)、[:1884](../relay/zcode/companion.js#L1884)。

**触发与证据：** GUI 预检接受整个 `0.16.*` 前缀，不能保证运行的是已验证 patch；CLI 默认 `runtimeManaged=false`，`startBridge` 直接解析并启动 runtime，CLI 入口未调用 `probeZcodeRuntime`。官方安装 / PATH 更新后可能运行未经验证的协议版本。

**影响与规则：** `session/list` 可用不等于所有模型、权限、事件契约一致。仓库已经记录 0.16.9 的 provider API 字段变化，不能把同一 minor 视为完整验证。违反 AGENTS“锁定已验证 CLI 版本”。这不是“完全没有版本检查”，GUI 的 minor 前缀检查确实存在。

**建议与测试：** 全入口共用实测版本白名单 / 锁定策略，并绑定已验证 descriptor；测试 GUI 与 CLI 对未验证版本的相同行为。

### R10 · CI 的 info 级分析门禁与仓库要求相反

**位置：** [ci.yml:84](../.github/workflows/ci.yml#L84)、[release.yml:60](../.github/workflows/release.yml#L60)、[AGENTS.md:57](../AGENTS.md#L57)。

**证据与影响：** 两条流程使用 `flutter analyze --no-fatal-infos`，仅有 info 诊断时可返回成功。AGENTS 同行却声明“info 也算失败，必须 0 issues”，文字与命令自相矛盾。新增 info 不一定阻断 CI 或 Android candidate 发布。

**规则与建议：** 违反已声明质量门禁的一致性。按“0 issues”要求移除宽松选项，并修正文档；用仅含 info 的分析输出验证退出状态。主 CI 的 Node 24 / Flutter 3.41.6 钉版本身一致，本条不否定这些配置。

## P2 建议

### R11 · 旧二维码异步结果会覆盖当前配对展示

**位置：** [main.js:315](../companion_app/main.js#L315)、[:210](../companion_app/main.js#L210)。

`onPairing` 先保存新 URL，再异步 `QRCode.toDataURL`；完成时不检查实例 / URL / 代次。若旧 A 的生成晚于新 B 完成，会把 A 的图片写入当前快照，并广播旧 A。纯内存复现得到“当前 URL 为 B、二维码为 A、最后 renderer 事件仍为 A”。停止时清空字段也没有使旧任务失效。

违反单一真相和异步生命周期归属。应以 companion 代次和配对身份验证结果归属；补充 A/B 反序完成、stop 后迟到完成的测试。

### R12 · 首启设置落盘失败后，内存配置仍被改写

**位置：** [main.js:555](../companion_app/main.js#L555)、[:561](../companion_app/main.js#L561)、[:574](../companion_app/main.js#L574)。

`apply-first-run` 先改 `cfg.relayUrl`、`cfg.cwd`、`cfg.firstRun.completed`，再 `persistConfig`。写入失败返回 `ok:false`，但不恢复 cfg，旧 companion 也尚未替换。内存复现 `EACCES` 后返回失败，同时 firstRun 为 completed、内存 cwd 已改变、运行实例仍用旧配置。`dismiss-first-run` 有同类先修改后保存路径。

违反单一真相。应把候选配置的持久化与内存提交作为一致操作，失败不推进 completed 状态；补充持久化失败后 snapshot 和运行实例一致性的测试。

### R13 · 60 秒自动重探会使尚未结束的成功预检失效

**位置：** [main.js:274](../companion_app/main.js#L274)、[runtime-gate.js:13](../companion_app/runtime-gate.js#L13)、[companion.js:237](../relay/zcode/companion.js#L237)。

自动重探定时器不检查在途 probe；每次 `check` 递增 generation，旧 probe 的结果随后会被丢弃。一次失败后开始的自动重探若超过 60 秒，下次 tick 即发起重叠任务。当前预检含最多 6 次 8 秒探针、5 次 2.5 秒间隔，再加版本与 doctor，超过 60 秒在预算内。

内存复现出现 2 个同时进行的 probe，较早返回的 ready 被忽略，状态仍为 checking。不是每次启动都触发，条件是定时重试已启用且一次检查超过间隔。

违反生命周期结果归属和失败恢复。应在相同配置下复用在途检查，或等上次完成后再安排下一次重探；补充慢成功预检的时钟测试。

### R14 · relay 手工发布清单只复制 server.js，会遗漏其运行依赖

**位置：** [AGENTS.md:82](../AGENTS.md#L82)、[server.js:6](../relay/zcode/server.js#L6)。

通用发布清单只上传并 `docker cp server.js`，但该文件运行时依赖 `lib/proof`、`lib/protocol`、`lib/constants`。修改这些模块后按清单发布，本地测试使用新模块，容器却可能继续使用旧模块；重启和 `auth-ok` 不能证明新契约已部署。

违反链路每环契约与发布产物一致性。清单应覆盖全部运行文件并校验容器内版本 / 哈希。本次没有检查生产容器，不宣称当前容器已经陈旧；这是条件明确的流程缺口。

## P3 风格 / 备注

### R15 · 活跃文档仍把历史实现当作当前边界

- `AGENTS.md:27` 仍列多桌面注册表，实际 Android 连接由单个 ConnectionManager / client 拥有；`:28` 又把 ChatRuntimeService 归为 `x/*`，其实际调用原生 session 方法。
- `companion_app/README.md:27` 描述“预检通过才连接 relay”，实际 `main.js:254` 先上线，再预检。
- `relay/zcode/README.md:104` 仍描述第二模式和轮询流式，当前现用 UI 直接消费 ZcodeChatStore，订阅是主要链路。
- `APP-SERVER.md:838` 仍把 storageState / mcpTelemetry 本地代答列为待办，而 `companion.js:53`、`:772` 已实现并有测试。
- `.planning/PLAN-brain-network-v3.md` 仍带执行中状态并描述已退役的 token 支线，但根 AGENTS 又把它作为架构蓝图入口。

这些差异会误导新增功能的落点和排障路径。建议在当前入口显式标明运行现状与历史记录；本报告及网页按代码展示。`docs/arch-now-vs-target.html` 已明确标注 HISTORICAL，未将其历史内容本身计作业务缺陷。

## 已核对但未判为新缺陷

- relay 的普通请求 ID 隔离、响应归属、未认证接管保护、反向请求移交与宽限补投已有实现及回归测试，本次选定套件全部通过。
- GUI 的 cclient 同步副本与 `relay/zcode` 所对应的 7 个核心 JS 文件哈希一致，未发现当前复制内容漂移。
- 引擎白名单反向请求已有本地代答，不能沿用上次“storageState 尚未处理”的旧结论。
- 权限确认使用服务端 `option.response` 原文；未把未知方法的显式“不支持”单独认定为“必须等待 120 秒”的缺陷。
- release 流程保留 Android candidate 与 Companion 发布的边界，Legacy Desktop 独立；不能把 relay 的 Node 20 容器等同于在该容器运行 app-server。

## 待实测 / 待专项核对

- AskUser 类反向请求在 `APP-SERVER.md:507` 明确尚未实测，手机 `zcode_chat_store.dart:1478` 的应答仍是未验证形状。这是协议覆盖缺口，本次不宣称某个具体真实答复已被错误处理。
- 配置切换与旧 runtime descriptor 交付存在可由内存替身制造的极窄交错；实际触发频率和影响边界尚未充分核对，未与确认问题同级计数。
- app-server 预检会把失败输出尾部带到 GUI 日志，需在协议演进时核对是否始终不含敏感字段；本次没有证据证明该路径实际输出了凭据，因此没有另报安全泄露。

## 验证记录与限制

| 验证 | 结果 |
|---|---|
| `node --test --test-force-exit relay/zcode/test/relay.test.js` | 58 / 58 通过，0 失败；使用本机 loopback 测试 relay，未连接 NAS |
| companion runtime-gate / zcode-integration / zcode-importer 三个纯内存测试文件 | 16 / 16 通过；由只读审查任务执行 |
| companion 模型目录、认证恢复、GUI 保存、二维码、慢预检 | 真实源码在内存 VM 中执行，fs / socket / clock / 子进程为替身，确认报告所述状态结果 |
| 网页 HTML、导航、JavaScript 语法与模拟 DOM 交互 | 结构、四种链路视图、12 个节点、键盘操作和文字视图通过校验 |
| 浏览器渲染 / 截图 | **未完成**：浏览器工具启动时报 `无法解析互动请求: interaction/browserList`；没有把静态校验当作视觉验证 |
| Flutter analyze / Flutter test / 完整 companion 套件 / release 构建 | 未执行；本次不修改业务代码，不能宣称全仓测试通过 |
| 生产协议探针、NAS 状态和部署产物 | 未执行或检查；生产现况不由本报告推断 |

架构网页是无外部依赖的单 HTML 文件，可离线打开；包含架构总览、发送消息、权限审批、本机扩展链路、节点职责和源码位置、审查摘要与发布边界。源码行号以本次 HEAD 为准。
