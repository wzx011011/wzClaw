# ZCode 官方手机远控页 /remote/v4 结构分析（2026-09-19 实测）

> 分析对象：桌面 ZCode **3.14.0** 生成的官方远程控制页
> `https://zcode.z.ai/remote/v4?sid=<设备id>&hash=<配对hash>&t=<时间戳ms>&mid=<机器id>&name=<主机名>&app_version=3.14.0`
> （凭据参数按「配对凭据纪律」不落盘，此处只记形状。）
> 分析方式：ZCode 内置浏览器以 390×844 手机视口**真实打开页面**做只读探索
> （未发消息、未执行终端命令、未做变更型点击），另对页面 JS bundle 做
> 静态字符串提取。每个结论标注证据等级：**实测**（页面真实交互所见）、
> **静态**（bundle 提取，未逐个实调）、**未证实**（合理推断，待验证）。

## 一句话结论

官方远控页 = 「ZcodeChatStore 手机端 + 终端 + 审查 + 调用轨迹」的官方实现：
React SPA 经官方 relay（`wss://zcode.z.ai/ws`）用**与自研 relay 同族**的
sid/hash 房间协议连到桌面端，消费 **与 CLI 0.16.9 完全一致的 app-server
方法面**。我们探测钉死的 55 个方法 schema 即官方页的能力上限清单。

## 1. 技术栈（静态）

React 19 + Vite 分包（入口 index 6MB）；lucide 图标；katex（公式）；
mermaid/rough.esm（图表手绘风）；shiki `github-dark/light`（代码高亮）；
`diffs.worker`（827KB diff 渲染 worker）；office 文件预览；
`usageStatsUiParts` + `appUsageChartPalette`（用量统计图）；IntlProvider
（729KB，中文 i18n）；`imeComposition`（中文输入法合成专门处理）；
xterm.js（终端，`xterm-helper-textarea` 实锤）。
资产按版本目录发布：`/remote/v4/3.14.0/assets/`（升级即换目录）。

## 2. 通信协议

| 项 | 值 | 证据 |
| --- | --- | --- |
| WS 端点 | `wss://zcode.z.ai/ws`，备用 `wss://zcode.chatglm.site/ws` | 静态 |
| 帧类型 | `auth_init / auth_challenge / auth_response / pair_status_ack / pair_status_query / matched / data` | 静态 |
| 方法注册表 | 与 zcode.cjs `va` 表 **70 个方法完全同名同集**，另有 `startup/storagePathReady`（0.16.9 CLI 注册表里没提取到的新变体，与 storagePath/storagePrepared/storageState 构成存储外置化四件套） | 静态 |

- 帧词汇与 `relay/zcode/server.js` 自研实现逐字对上——我们的 relay 就是
  官方会合协议的复刻（**实测**：自研页面按同协议连自研 relay 已长期在用）。
- 注意：**bundle 含注册表 ≠ 页面每个方法都实调**。它说明客户端桩与
  app-server 同源生成，能力上限一致；具体哪些方法被 UI 消费以页面探索为准。

## 3. 页面结构总览（实测）

```
任务首页（工作区卡片列表 → 任务条目）
  └─ 会话视图
       ├─ 消息流
       ├─ 输入工具条（6 按钮）
       └─ 侧边抽屉（多标签，宽 min(88vw, 28rem)）
浮层：命令面板(Ctrl+K) · 主题切换 · 模式菜单 · 模型菜单 · 上下文容量
```

### 3.1 任务首页

- 顶栏：`ZCode 远程控制` + 「已连接到当前桌面窗口」 + 主题按钮（右上圆形）。
- 提示条：本次连接可查看当前设备上已打开的项目、任务和会话；二维码失效后
  需回桌面端重连。
- 工作区卡片：名称 + 来源标签（**本地**/远程/对话）+ 路径 + 更新时间 +
  任务数 + 展开箭头 + `+`（新建任务）。
- 任务条目：标题 + 相对时间 + 状态徽章（**运行中**=蓝 / **已完成**=绿）。
- 顶栏操作：收起全部工作区 / 整理任务 / 刷新工作区和任务。

### 3.2 会话视图

顶部：返回任务首页 · 工作区分支徽章（如 `wzxClaw · feat/zcode-remote-integration`）
· 标题 · 更多菜单 · 展开侧边面板。右侧悬浮**更改 +N/-N**（git diff 统计，
点开进审查标签）。

**消息流**（实测）：

| 元素 | 细节 |
| --- | --- |
| 思考块 | 折叠（「思考 · 持续了几秒」），可展开 |
| 工具调用 | 时间线 chip：「终端」显示命令原文、「查阅 · N 列表, N 文件」，可展开详情 |
| 正文 | markdown 全套：表格可 复制 Markdown/下载 CSV/预览表格，代码块卡片（语言标签/自动换行/复制代码），katex 公式，mermaid 图 |
| 回合徽章 | 「已工作 1 分 28 秒」 |
| 消息操作 | 复制/赞/踩/**分叉**（fork）；用户消息带时间戳且可**编辑** |
| 文件更改 | 「N 个文件已更改 +7 -4」可展开，带**撤销**按钮 |

**输入工具条**（aria-label 实测枚举）：

| 按钮 | 展开内容 |
| --- | --- |
| 添加上下文 | 附件/引用入口 |
| 切换模式 | **计划模式**（独立 checkbox）＋三档 radio：变更前确认(=build)/自动编辑(=edit)/完全访问(=yolo)，与手机端「UI 四档 vs 服务端五档」映射一致 |
| 后台任务 | 「打开运行中的后台任务：Bash 1 个，工作流 0 个，子智能体 0 个」 |
| 上下文容量 | 进度条（如 7.1万/100万 · 7.1%）＋分类占比：系统工具/消息/系统提示词/技能/其他/MCP 工具 ＋ **平均缓存命中率**（实测 94.3%）。分类投影比 `session/usage` 更细，数据源字段**未证实**（待探针） |
| 选择模型 | 按 provider 分组（BigModel 个人 / Start Plan 免费 / Codex / DeepSeek）＋能力角标（视觉）＋「管理模型」——即 `settings.model.available` 的 UI 投影 |
| 发送 | 空输入时 disabled |

### 3.3 侧边抽屉（多标签）

| 标签 | 内容 | 协议对应（推断） |
| --- | --- | --- |
| 审查 | git 未暂存/已暂存 combobox ＋ 文件列表（路径 + `+N/-M`），点击看 diff | 桌面控制器 git 通道（自研走 x/git 扩展） |
| 终端 | xterm.js 远程 PowerShell，`PS E:\ai\wzxClaw>` 可直接输入 | 真 PTY 通道（自研无此能力，成本最高项） |
| 调用轨迹 | 头部：会话总数（「2 次调用 · 141,829 tok · opus[1m]」）；每回合一条 article：序号/querySource 徽章(主会话)/结束状态(正常结束)/IN·OUT token/耗时/时间戳；可展开 输入/助手消息/**思考过程原文**；工具：搜索调用轨迹/自定义展开/全部收起/打开所在目录/刷新 | 回合级 trace（对 probe-otel.js 探过的 OTel 数据的 UI 化） |

侧栏标签可多开（新增标签菜单：终端/审查），快捷键 Ctrl+B（侧边栏）、Ctrl+J（终端）。

### 3.4 更多菜单（会话视图）

置顶任务 · 重命名任务 · 归档任务 · 标记为未读 │ 复制路径 · 复制任务路径 ·
复制日志路径 · **复制会话 ID** │ **查看调用轨迹** │ 反馈问题。

### 3.5 命令面板（Ctrl+K）

搜索框「搜索操作、任务或文件」＋分类 tab（全部/操作/任务/文件）＋
最近任务 ＋ 建议（新任务 Ctrl+N/打开工作区 Ctrl+O/设置）＋ 面板快捷键集。

## 4. 对 wzxClaw 的借鉴清单（按实现成本升序）

1. **上下文容量浮层**——`session/usage` 现有数据即可做基础版；分类占比与
   缓存命中率字段待探针确认（若 `session/usage` 无细分，查桌面 OTel 流）。
2. **调用轨迹面板**——手机端 SQLite 已有回合数据底子，补回合级 IN/OUT/
   耗时聚合即可；思考原文走 `session/messages`。
3. **审查面板**——git 变更列表/±行数走现有 `x/git` 扩展即可对齐。
4. **消息分叉/编辑**——`session/fork` 已钉过 schema，UI 增量小。
5. **远程终端**——需要 companion 加 PTY 通道（xterm 协议 + Windows conpty），
   与现有 x/* 命令式扩展是量级差异，单独立项。

## 5. 分析方法备忘（复跑指南）

1. 手机视口（390×844）打开配对 URL，等 6s WS 握手。
2. 结构读取：a11y 快照为主；输入工具条按钮用
   `button[aria-label=…]` 定位（快照里这些按钮常显示为无名）。
3. 侧栏抽屉会盖住主区（`data-mobile-side-pane-overlay`），点左侧背景收回。
4. 协议提取：在页面上下文 fetch assets 下的 js，按**反引号字符串**正则提
   `namespace/verb`（minifier 用模板字面量，单双引号提不到）。
5. 已知盲区：命令面板搜索结果的完整操作清单未逐项展开；
   「上下文容量」分类占比的协议字段来源未证实；`查看调用轨迹` 菜单项的
   直接点击事件未成功（经侧栏标签等效到达）。
