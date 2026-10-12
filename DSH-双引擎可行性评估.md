# DeepSeek Harness（DSH）双引擎可行性评估

> 调研日期：2026-09-16 · 只读调研，未改任何代码
> 背景：设想「没装官方 ZCode 的机器上，用开源引擎顶替」——候选引擎 DeepSeek Harness（`dsh`）。
> 本文回答：能不能做、适配形态、工作量、为什么现在不做。

## 结论先行

**技术上可行，但现在不建议动手。**

DSH 确实有可供外部进程驱动的机器接口（JSON-RPC Server / ACP Server 投影），适配器路径存在（`relay/zcode/brain-adapter.js` 是现成先例）；但它处于 `v0.1.0-rc.7` 开发者预览期，官方明确警告会有破坏性变更，会话格式版本号 `SESSION_FORMAT_VERSION = 0` 且不承诺兼容，且接入它意味着**放弃智谱编码计划的凭据体系、改用用户自己的 DeepSeek/GLM API key 计费**。三个独立的推迟理由，叠加起来够充分。

## DSH 是什么（核实过的事实）

DeepSeek AI 2026-08-13 开源的 Agent 运行时，MIT 协议，Node.js 实现（要求 Node ≥22.19，npm 分发声称 v18+），命令行名 `dsh`，24 小时 GitHub Stars 破 5 万。

「一切皆插件」：模型适配器、Agent Loop、会话存储（Session Store）、工具注册表、文件系统、沙箱、审批策略（approval）、Web Host 全是 Cordis 微内核上的插件，不存在特权核心。

四种运行形态：

| 形态 | 说明 |
|---|---|
| Web UI | `npx @deepseek-ai/dsh web`，本机 3080 端口 |
| TUI | `--profile tui` 终端界面 |
| Headless | `--profile headless "任务"`，单任务跑完退出 |
| SDK 嵌入 | Python SDK（`pip install deepseek-harness-sdk`，**不支持 Windows 原生**） |

对我们最关键的一条事实（来自基于 `dsh-v0.1.0-rc.7` 源码的架构分析）：**它有 JSON-RPC Server 和 ACP Server**——与 Web UI 共享同一套运行时，「驱动 ctx.agents，订阅 session/event，把同一套会话和生命周期投影成外部协议」。这正是 Companion 能驱动它的前提，相当于我们 app-server 的 stdio JSON-RPC 的对应物。

## 能力对照表（app-server 协议面 ↔ DSH）

| 我们依赖的能力（APP-SERVER.md 实测） | DSH 对应物 | 判断 |
|---|---|---|
| `session/send` 流式回复 | `followup(input)` + `assistant/chunk` 事件流 | ✅ 形态对齐，可映射 |
| `session/list` / `session/resume` | 会话事件日志持久化 + session ID 复用续上下文 | ✅ 有，但 `SESSION_FORMAT_VERSION = 0` 不承诺稳定 |
| `session/messages`（历史回放） | 追加式事件日志投影（`deriveMessages()`） | ✅ 设计上更强（支持回放/fork） |
| 模型自愈（-32031 → setModel → close → resume → send） | 模型切换改配置、下次请求生效；无会话内 setModel 等价物 | ⚠️ 需降级：报「暂不支持会话内换模型」 |
| `session/setThoughtLevel` | 无对应物 | ❌ 显式降级 |
| `session/usage`（token 用量） | 成本指标是可替换插件，有无现成 RPC 未验证 | ⚠️ 待探针 |
| 权限反向请求（手机点允许/拒绝） | 审批策略是插件、审批事件在 Capability Seam 固定位置拦截；官方明确「Web 按钮不是唯一审批入口，Headless/SDK/Subagent 走同一能力世界」 | ⚠️ 机制存在，但 **RPC 帧形状未实测**——按我们的纪律必须先跑探针 |
| 模型身份（zcode.z.ai 签名通道 / 编码计划配额） | OpenAI 兼容端点，自带 client 身份直连模型 API | ❌ **不兼容**：需用户提供 DeepSeek 或 GLM 的 OpenAI 兼容 key，编码计划的 Flash 免费/闲时优惠全部不适用 |
| 运行宿主（Windows + 官方 ZCode.exe 承载 cjs） | npm 版 Windows 可跑 Web UI；JSON-RPC 投影在 Windows 未验证；Python SDK 明确不支持 Windows 原生 | ⚠️ 未验证 |

DSH 事件流参考形状（追加式会话日志）：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`。

## 适配形态与工作量

切分点与既有判断一致：

- **relay** 完全不动（它只是房间，引擎无关）。
- **Companion**：切在运行时门——`resolveZcodeRuntime` 同级加引擎选择；未装 ZCode 时改拉 DSH（JSON-RPC 投影），新增 `dsh-adapter.js` 把 app-server 帧翻译成 DSH 的 JSON-RPC + session/event。与 brain-adapter 同构。
- **Android**：改动最碎。错误码语义（-32031/-32004 是 zcode 特有）、模型 heal 文案与流程、模型列表来源（DSH 没有 `settings.model.available`，需要另找目录来源）、引擎感知的 UI 降级（会话内换模型、思考档位按钮灰显为「暂不支持」）——都要按引擎分支。

估算：

| 阶段 | 内容 | 工期 |
|---|---|---|
| 探针 | 拉起 dsh JSON-RPC server，钉死方法清单/事件形状/审批帧，产出自己的 DSH-PROTOCOL.md | 1–2 天 |
| 适配器 + Companion 门 | dsh-adapter.js + 引擎选择 + 凭据配置（OpenAI 兼容 key，0600 纪律） | 3–5 天 |
| Android 引擎分支 | 错误语义分支、模型列表来源、降级 UI、双栈回归 | 3–5 天 |

前提是 DSH 在此期间没有破坏性变更——预览期这个前提本身就不稳。

## 风险清单

1. **预览期不稳定**：官方 README 明确警告未来会有破坏兼容性的变更；会话格式版本 0；SQLite schema 不承诺兼容。适配器可能反复返工。
2. **已知 bug**：预览版有 Bash noop 循环挂起类 bug；rc.7 无内置回合上限（终止钩子需自行限制）——远程遥控场景下「任务跑飞」风险比本地使用更严重。
3. **计费与身份切换**：DSH 用自己的身份直连 OpenAI 兼容端点，干净（不冒充任何客户端），但编码计划配额/Flash 免费政策完全不适用，用户需另备 DeepSeek 或 GLM key。
4. **Windows 程序化路径未验证**：Web UI 在 Windows 可跑，但 Companion 需要的是 JSON-RPC 投影，这一点没有官方 Windows 支持声明。

## 建议与下一步

- **现在不做**。在 AGENTS.md 记一笔「引擎门已预留、DSH 候选、等 stable」即可。
- 若将来 DSH 出 stable 版后再启动，**第一步不是写适配器，是跑探针**——按纪律把 JSON-RPC 方法清单、事件流形状、审批流帧形状钉死在实测文档里（先例：`probe-methods.js` / `APP-SERVER.md`），再决定做不做。
- 一个可提前做的低成本准备：Companion 运行时门保持引擎无关的返回形状（当前已接近），确保将来插第二引擎时不需要回头改调用方。

## 一个诚实提醒

「没装 ZCode 就用 DSH 代替」在身份层面反而是干净的：DSH 用自己的 client 身份直连模型 API，不冒充 ZCode、不走 zcode.z.ai 签名通道；我们的架构里 Android/relay/Companion 本来也不伪造身份。代价是完全自有计费。也就是说这不是「绕过限制」的方案，而是「另一套引擎、另一份 key」的方案。

## 信源

- [官方仓库 README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)（MIT、Node、`dsh web` 3080、预览期警告）
- [Agent 运行时设计源码分析（基于 rc.7）——53AI](https://www.53ai.com/news/LargeLanguageModel/2026090797806.html)（JSON-RPC/ACP 投影、事件类型、Capability Seam、SESSION_FORMAT_VERSION=0、Windows 限制）
- [部署指南：四种启动模式与 OpenAI 兼容端点——腾讯云开发者社区](https://developer.cloud.tencent.com/article/2726094)（Python SDK、OpenAI 兼容端点配置）
- [awesome-deepseek-harness](https://github.com/Dominic789654/awesome-deepseek-harness/blob/main/README.zh-CN.md)（生态索引）
