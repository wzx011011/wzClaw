# AGENTS.md — wzxClaw v3「大脑网络」

> 本文件是给编码代理的工作指引。架构蓝图：`.planning/PLAN-brain-network-v3.md`
> 协议实测记录：`relay/zcode/APP-SERVER.md`

## 这是什么

个人 AI 远程控制系统。**引擎标准化为 ZCode app-server**（官方无头运行时），
大脑节点可安装在任意环境，手机/桌面都只是它的前端；节点间经自托管 NAS relay
会合（数据不过第三方云）。

```
手机 App（Flutter，纯遥控器）
   │ WSS（两条链路，见下）
   ▼
NAS relay
   ├─ /relay（旧 token 房间模型）← v3 大脑网络（旧 UI + brain-adapter）
   └─ zcode.5945.top/ws（sid/hash 房间模型）← v2 配对流（现有 APK 兼容期）
   ▼
大脑节点 = brain-adapter / companion ＋ zcode app-server 子进程
   └─ 工具执行发生在节点所在机器（运行时本地性）
```

## 仓库地图（活跃部分）

| 路径 | 职责 |
|---|---|
| `wzxClaw_android/lib/zcode/` | 手机端核心：ZcodeChatStore（每会话状态容器/同步层/反向请求/通知）、ZcodeDesktopRegistry（多桌面注册表）、relay 客户端、权限组件、SQLite 缓存 |
| `wzxClaw_android/lib/services/` | 旧协议栈（v3 恢复，供大脑网络远程页使用） |
| `wzxClaw_android/lib/pages/remote_control_page.dart` | 大脑网络远程控制页（token 房间） |
| `relay/zcode/server.js` | sid/hash 房间 relay（多 probe、注册密钥、半开接管、确定性房间号） |
| `relay/zcode/companion.js` | Windows 常驻节点：拉起 app-server、配对码、单实例锁、自启动 |
| `relay/zcode/brain-adapter.js` | 旧 WsEvents 协议 ↔ app-server 帧适配器（v3 大脑节点核心） |
| `relay/zcode/test/` | 69 项测试（node --test） |
| `wzxClaw_desktop/` | 旧 Electron IDE——**M3 待迁移**：引擎换绑 app-server（尚未开始；原 packages/brain 参考源码已于 2026-09-15 清理删除） |

> 注：`packages/`、`mobile/`、`_nas_deploy/` 及旧 relay 全部遗留（源码
> `relay/server.js`、`relay/lib/`，部署套件 Dockerfile/compose/nginx/test 等）
> 已于 2026-09-15 按用户指示删除，`relay/` 下现仅存 `zcode/`；tracked 删除可
> 通过 `git restore` 恢复，brain-adapter 测试所需的旧 relay 副本迁至
> `relay/zcode/test/fixtures/old-relay/`。NAS 侧旧 relay 容器 `wzxclaw-relay`
> 同日已下线（停容器、删镜像与网络；`/volume1/docker/wzxclaw-relay/` 目录
> 暂留未删）。

## 常用命令

```bash
# relay 侧测试（68 项；涉及子进程/长连接的套件必须 force-exit）
cd relay/zcode && npm test   # = node --test --test-force-exit "test/*.test.js"

# 协议 schema 探针（只读，跑真实链路；改协议后先跑探针再动手）
node relay/zcode/probe-methods.js   # 9 个高级接口 schema
node relay/zcode/probe-models.js    # 模型目录快照结构

# 手机端
cd wzxClaw_android
flutter analyze        # CI 门禁 --no-fatal-infos：info 也算失败，必须 0 issues
flutter test           # 374 项

# 手机端 release APK（2026-09-16 定）：
# 1. 每次出包前 pubspec.yaml 的 patch 版本 +1 并带 +N（如 1.2.5+5 → 1.2.6+6），
#    versionCode 单调递增，手机上能看出是否最新版；
# 2. 产物统一放 NAS `/volume1/share/zcode/`，文件名带版本：
#    wzxClaw-android-release-vX.Y.Z.apk（不带版本的旧文件删掉，避免分不清）
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
- 代码注释中文；测试与实现同目录；Windows 下 node 测试注意路径与进程清理。
- **APK 发布纪律**：编译好的手机端 release APK 一律放 NAS `/volume1/share/zcode/`
  （scp 过去即可），不放旧位置 `/volume1/docker/zcode-relay-build/apk/`；
  每次出包 patch 版本 +1（pubspec 带 +N 保 versionCode 递增），文件名带
  版本号 `wzxClaw-android-release-vX.Y.Z.apk`。

## 外部服务

- NAS relay（v3 大脑网络）：`wss://5945.top/relay/`（token 房间；
  **已于 2026-09-15 下线**——本地源码与 NAS 容器均已删除，恢复需从 git 历史
  取源码并用 `relay/zcode/test/fixtures/old-relay/` 对照）
- NAS relay（v2 配对流）：`wss://zcode.5945.top/ws`（容器 wzxclaw-zcode-relay）
- 模型：智谱编码计划（`builtin:bigmodel-coding-plan`），凭据在 `~/.zcode/`，
  计费随 key/端点走（Flash 免费政策适用范围未实测，见会话记录）
