# AGENTS.md — wzxClaw v3「大脑网络」

> 本文件是给编码代理的工作指引。架构蓝图：`.planning/PLAN-brain-network-v3.md`
> 协议实测记录：`relay/zcode/APP-SERVER.md`

## 这是什么

个人 AI 远程控制系统。**引擎标准化为 ZCode app-server**（官方无头运行时），
大脑节点可安装在任意环境，手机/桌面都只是它的前端；节点间经自托管 NAS relay
会合（数据不过第三方云）。

```
手机 App（Flutter，纯遥控器）
   │ WSS
   ▼
NAS relay
   └─ zcode.5945.top/ws（sid/hash 房间模型，生产；UI 已接 app-server 直连状态栈）
   ▼
大脑节点 = companion ＋ zcode app-server 子进程
   └─ 工具执行发生在节点所在机器（运行时本地性）
```

## 仓库地图（活跃部分）

| 路径 | 职责 |
|---|---|
| `wzxClaw_android/lib/zcode/` | 手机端核心：ZcodeChatStore（每会话状态容器/同步层/反向请求/通知）、ZcodeDesktopRegistry（多桌面注册表）、relay 客户端、权限组件、SQLite 缓存 |
| `wzxClaw_android/lib/services/` | 连接层 + 扩展服务：ConnectionManager（relay 连接/设备列表/供帧桥/zcodeRequest 通道）、GitService、ChatRuntimeService、NodeCatalogService（后三者走 x/* 扩展） |
| `relay/zcode/server.js` | sid/hash 房间 relay（多 probe、注册密钥、半开接管、确定性房间号） |
| `relay/zcode/companion.js` | Windows 常驻节点：拉起 app-server、配对码、单实例锁、自启动 |
| `companion_app/` | Windows 桌面版 companion（Electron）：装好即连 NAS、配对二维码、完整/宠物双形态，`npm run dist` 打包 |
| `relay/zcode/test/` | relay / CLI companion 协议与回归测试（node --test） |
| `wzxClaw_desktop/` | **Legacy** 旧 Electron IDE：仅保留维护与迁移参考，不进入主 CI 或 Release |

> 注：`packages/`、`mobile/`、`_nas_deploy/` 及旧 relay 全部遗留（源码
> `relay/server.js`、`relay/lib/`，部署套件 Dockerfile/compose/nginx/test 等）
> 已于 2026-09-15 按用户指示删除，`relay/` 下现仅存 `zcode/`；tracked 删除可
> 通过 `git restore` 恢复。v3 大脑网络支线（brain-adapter + 测试与
> old-relay/fake-brain 夹具 + Dockerfile.brain + remote_control_page）已于
> 2026-09-17 退役删除，恢复一律从 git 历史取源码。NAS 侧旧 relay 容器
> `wzxclaw-relay` 已于 2026-09-15 下线（停容器、删镜像与网络；
> `/volume1/docker/wzxclaw-relay/` 目录暂留未删）。

## 常用命令

```bash
# relay 侧测试（用例数随契约演进；涉及子进程/长连接的套件必须 force-exit）
cd relay/zcode && npm test   # = node --test --test-force-exit "test/*.test.js"

# 协议 schema 探针（只读，跑真实链路；改协议后先跑探针再动手）
node relay/zcode/probe-methods.js   # 9 个高级接口 schema
node relay/zcode/probe-models.js    # 模型目录快照结构

# 手机端
cd wzxClaw_android
flutter analyze        # CI 门禁 --no-fatal-infos：info 也算失败，必须 0 issues
flutter test           # 用例数随功能演进，不在文档写死

# 手机端 release APK（2026-09-16 定）：
# 1. 每次出包前 pubspec.yaml 的 patch 版本 +1 并带 +N（如 1.2.5+5 → 1.2.6+6），
#    versionCode 单调递增，手机上能看出是否最新版；
# 2. 产物统一放 NAS `/volume1/share/zcode/`，文件名带版本：
#    wzxClaw-android-release-vX.Y.Z.apk（不带版本的旧文件删掉，避免分不清）
# 3. （2026-09-17 教训）被取消过的构建产物不可信——gradle 会在损坏增量上
#    "续"出截断 zip（报成功但手机报解析错误）。取消后必须 flutter clean
#    重建；上架前先 apksigner verify + zip 完整性检查，再 scp + 哈希比对
flutter build apk --release

# companion（PC 常驻节点）
node relay/zcode/companion.js --relay wss://zcode.5945.top/ws --cwd <工作目录>
# 生产用计划任务 wzxClawZcodeCompanion 拉起（勿在代理任务托管里长跑，会被回收）
```

## 设计原则（2026-09-15 审查定稿）

背景：换芯实现曾出现多处「能用但没做对」的临时方案被固化（详见
commit a1af416 整改记录——最严重一处：权限应答形状错误导致点"允许"
实际执行拒绝）。以下规则约束所有新代码：

1. **协议字段以实测为准**：请求/响应/事件形状必须来自 APP-SERVER.md
   的实测记录（含畸形应答实验），不许按直觉猜测字段名或形状；
   新接口先跑探针钉死 schema 再写实现。
2. **一步到位，不留"先用假的"**：硬编码占位值（模式/计数/状态）、
   乐观回显不回填、吞错误继续跑——都算偷懒。宁可显式报"暂不支持"，
   不做假的成功响应。
3. **失败模式方向**：默认值的选择必须偏向「多等/多确认」而非
   「静默拒绝/丢失」——例如反向请求超时默认长档，只有白名单快速
   方法才给短档。
4. **静默丢弃 = 缺陷**：不可识别的事件/帧必须有观测手段（日志/计数），
   零观测的 `return const []` / `catch (_) {}` 不合入。
5. **语义映射要写明词典**：新旧协议枚举/字段不完全对齐时（如权限模式
   UI 四档 vs 服务端五档），映射表显式定义并注释语义近似之处，
   不许假装一一对应。
6. **安全约定自我一致**：声明「密钥不进进程参数/日志」就要全链路
   遵守——CLI 参数、docker -e、stdout 打印任一处违反都算违约；
   凭据文件统一 0600。
7. **回归测试钉住契约**：每个协议语义（应答形状、事件轨迹、超时档位）
   配测试锚定；修 bug 必须先加"能复现该 bug"的测试再修。

## 编码规则（2026-09-18 用户定稿，文件下载功能两轮 review 提炼）

用户明定的两条原则，加三条由此推出的操作规则（每条都对应本仓库真实
被推翻重写或即删的实例）。review 时按此清单逐条过，违反任何一条算缺陷：

- **一步到位，不为快妥协**（用户原则 1）：宁可多花时间直接写最佳实践，
  不接受「先用简单方案顶一下」。被推翻的实例：正则文本预处理模仿
  markdown 解析器（重写为解析层 InlineSyntax）、对 error.message 做
  字符串嗅探代替读协议字段 error.data.reason（改为异常携带 data）、
  setState 外改列表靠调度巧合生效。
- **零兼容包袱**（用户原则 2）：单人使用、全新功能，不为旧版本/旧设备/
  旧数据写迁移或降级分支；能力不具备就显式报「暂不支持」（如
  Android 10 以下保存返回 unsupported），不做降级假成功。
- **占位/空壳即缺陷**（推论）：空 onTap 按钮、只写不读的字段、无人消费
  的返回值、声明未用的依赖，发现即删或补实，不留「以后再接」。
- **契约钉到链路每一环**（推论）：不只测消费端——协议语义中间环节
  （如 relay client 从错误帧提取 data.reason）也要有断言锚定，
  改坏必须有声。
- **单一真相**（推论）：同一事实（如「文件保存在哪」）只允许一个来源；
  半途的结构化字段与硬编码并存、结构化字段加了没人消费，都按缺陷处理。

## 关键约定与教训

- **app-server 协议是非官方逆向的**：改任何协议代码前先跑探针；
  锁定已验证的 CLI 版本；`APP-SERVER.md` 是协议唯一事实源。
- **运行时单归属**：一个会话同时只归一个进程跑。桌面 App 运行中的会话对
  companion 的 app-server 报 -32004（不可读、不可订阅）——这是设计不是 bug。
- **配对凭据纪律**：sid/hash/token/QR 是持有者凭据，不进日志/git/聊天输出。
- **relay 测试必须 `--test-force-exit`**：子进程与长连接会让进程挂住不退出。
- **companion 勿挂在代理任务托管里**：会被回收（曾静默 exit 1）；用计划任务。
- **确定性房间号**：房间 id 由 (pass_hash, mid) 派生、口令落盘
  `~/.wzxclaw/zcode-companion/`——重启/重连不换码，手机配对一次长期有效。
- **设备在线与引擎健康解耦（2026-09-18 定）**：GUI companion 先注册 relay
  上线，runtime 预检只经 `setRuntimeDescriptor` 热注入引擎（未就绪时
  `paired-no-model`，模型目录走导入快照降级）；预检失败/重试绝不重建
  relay 链路（此前 probe 失败被当整机开关，手机对空房间无限断线重连）。
  relay/工作目录配置变化才是重建链路的唯一条件。
- **模型目录权威（2026-09-18 实测）**：app-server 无独立目录方法，
  `settings.model.available` 是可用目录唯一投影；`settings.model.current`
  只是会话当前选中，不是可用性证据，禁止并入目录（详见 APP-SERVER.md）。
- 代码注释中文；测试与实现同目录；Windows 下 node 测试注意路径与进程清理。
- **架构收敛完成（2026-09-17）**：R3 已执行——历史翻译壳模块
  `zcode_protocol_translate` / `ChatStore` / `ws_transport` / `session_sync` 已删除；
  现用 UI 直接消费 `ZcodeChatStore`，由 `ConnectionManager` 与 `lib/zcode/`
  承接 app-server 帧，goal 面板通过直连请求读取 `session/goal`。
- **UI/协议分层表述纪律（2026-09-17 定）**：UI 是稳定层，做好就不变；
  演进只发生在网络与协议层。文档与讨论一律说「UI ＋ 当前接线的协议栈」
  （如：页面接 WsEvents 栈 → 改接 app-server 直连栈），
  **不再用「旧 UI / 新 UI」的说法**——历史文档里的「旧 UI（恢复）」
  指恢复自 U7 之前的那套界面，按本条理解为「现用 UI」即可。
- **APK 发布纪律**：编译好的手机端 release APK 一律放 NAS `/volume1/share/zcode/`
  （scp 过去即可），不放旧位置 `/volume1/docker/zcode-relay-build/apk/`；
  每次出包 patch 版本 +1（pubspec 带 +N 保 versionCode 递增），文件名带
  版本号 `wzxClaw-android-release-vX.Y.Z.apk`。根 `release.yml` 的 `android-v*`
  仅构建并校验候选 artifact：当前 release 使用 debug signing 且 CI 无 NAS 凭据，
  不创建正式 Release；`companion-v*` 独立发布 Companion，绝不发布 Legacy Desktop。

## 外部服务

- NAS relay（v3 大脑网络）：`wss://5945.top/relay/`（token 房间）——
  **整条支线已退役**：NAS 容器与旧 relay 源码 2026-09-15 删除；
  brain-adapter / 夹具 / Dockerfile.brain / remote_control_page 2026-09-17 删除；
  恢复需从 git 历史取源码
- NAS relay（v2 配对流）：`wss://zcode.5945.top/ws`（容器 wzxclaw-zcode-relay）
- 模型：智谱编码计划（`builtin:bigmodel-coding-plan`），凭据在 `~/.zcode/`，
  计费随 key/端点走（Flash 免费政策适用范围未实测，见会话记录）
