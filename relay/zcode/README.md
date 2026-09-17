# ZCode relay + companion（手机控制 ZCode 的桥接层）

手机 wzxClaw App 通过 NAS 中继控制桌面 ZCode。架构与协议细节见 `APP-SERVER.md`
（ZCode Protocol v1 实测记录）。

```
手机 wzxClaw App ──WSS──▶ NAS relay（本目录 server.js，Docker 部署）
（扫码 sid/hash 配对）          │ data 载荷转发（配对后双向）
                              ▼
                    桌面 companion.js（device 角色）
                              │ spawn + stdio NDJSON
                              ▼
                    `zcode app-server`（ZCode Protocol v1）
```

- **relay**（`server.js`）：房间 + HMAC 质询配对；多 probe 请求按 socket 隔离，普通请求只接受数值 ID，路由表有 deadline、容量上限与日志观测。
- **companion**（`companion.js`）：桌面侧 device 角色；QR 配对 URL 自管；
  spawn 本机 `zcode app-server`；`session/requestRuntimePreferences` 反向请求自动代答，
  其余反向请求（权限确认等）转发给手机端应答，超时看护按 method 分档：
  只有实名快速方法白名单走 15s，其余未知/交互方法默认走 120s，避免新方法被
  短档误拒；超时一律代答 `-32022`；模型 token 从
  `~/.zcode/v2/config.json` 读取后仅注入子进程环境变量（不落盘、不打印、不经过 relay）。
- **probe**（`probe.js`）：早期对官方桌面远程控制协议的验证器，保留作 relay 回归测试用。

## 实测状态（2026-09-13）

**全链路已实测通过**（本机 relay + 真 zcode app-server + 模拟手机）：
`session/list`（50 个真实会话）→ `session/create`（glm-5.3）→ `session/send` →
`stream.chunk` 流式 → `turn.terminal success` → `session/stop`。
前置条件：`~/.zcode/cli/config.json` 的 model/provider 配置（形状见 APP-SERVER.md）与
桌面端 BigModel coding-plan 登录。

## 本地命令

```bash
# relay（默认 127.0.0.1:18884；--host 0.0.0.0 供容器/nginx 使用）
node server.js [--port 18884] [--host 127.0.0.1]

# companion（桌面侧，另一终端；注册密钥走环境变量或 0600 文件）
node companion.js --relay ws://127.0.0.1:18884/ws [--cwd <ZCode 工作区>]

# 全量测试（含 relay、companion、CLI 与源码同步契约）
npm test
```

companion 启动后输出配对 URL（`<origin>/pair?sid=...&hash=...`）并渲染二维码。
mid 与 passhash 持久化在 `~/.wzxclaw/zcode-companion/`，sid 由二者确定性派生；
重启、重连和 relay 重部署不换码，手机无需重扫。

## NAS 部署（已完成，2026-09-13）

- 镜像 `wzxclaw-zcode-relay`（`deploy-nas-zcode.sh` 一键重跑更新），宿主
  `127.0.0.1:18884`。
- 公网入口 `wss://zcode.5945.top/ws`（nginx 子域名反代，`/ws` Upgrade 头 +
  Origin 剥离，`/health` 健康检查）。
- companion 连接 `--relay wss://zcode.5945.top/ws`，配对 URL 为
  `https://zcode.5945.top/pair?...`。

### 注册密钥（REGISTRATION_SECRET，防公网注册 DoS）

relay 的注册（`device_register_init`）默认无门槛：公网上任何人都能开连接自助
注册，占满 maxRooms=16/maxDevices=16 后真 companion 永远 CAPACITY。设置注册
共享密钥后，注册帧必须携带 `register_proof = base64url(HMAC-SHA256(secret,
device_mid))`（hex 不认），校验失败一律 AUTH_FAILED；未设置时行为不变，本地
开发/测试零摩擦。

- relay 侧：`createRelay({ registrationSecret })`，CLI/容器经环境变量
  `REGISTRATION_SECRET` 注入（比较用 `timingSafeEqual`，常量时间）。
- 生成建议：`openssl rand -base64 32`。
- NAS 部署：`deploy-nas-zcode.sh` 自动读取 `~/.wzxclaw/zcode-companion/relay-secret`
  （仅含 secret 一行，勿进 git/日志），存在时注入 `-e REGISTRATION_SECRET`；
  文件缺失时打印「未设置注册密钥，relay 将开放注册」并跳过该 -e；文件存在但
  为空时终止部署（避免误部署开放注册的 relay）。
- companion 侧：环境变量 `REGISTRATION_SECRET` 优先，其次读取密钥文件
  `~/.wzxclaw/zcode-companion/relay-secret`（首行、权限统一为 0600，与 NAS
  部署脚本同名同语义）。不提供命令行 secret 参数，避免进入 shell history
  和进程列表；两者均未提供时可连接开放注册 relay。

## Windows 常驻（开机自启）

companion 可以注册为 Windows 计划任务，登录后隐藏窗口后台运行。零产品代码改动，
只有 `scripts/` 下的启动脚本：

1. **安装**：双击或终端运行 `scripts\install-autostart.bat`。它注册计划任务
   `wzxClawZcodeCompanion`（登录时触发 `wscript.exe` 隐藏执行
   `companion-autostart.vbs`，内部再起 node 跑 `scripts\..\companion.js`）。
   注册登录任务需要管理员权限，脚本会自动弹 UAC 自提权重跑一次。
   重复运行幂等：先删旧任务再重建，改完 VBS 重跑即可。
2. **验证**：注销重登，或立即手动触发 `schtasks /run /tn wzxClawZcodeCompanion`，
   然后 `tasklist | findstr node.exe` 看进程、看日志确认已连上 relay。
3. **配对**：日志里最新的 `配对 URL`（`https://zcode.5945.top/pair?...`）复制到
   手机 App 粘贴（或自行生成二维码）完成扫码配对。

- 日志：`%USERPROFILE%\.wzxclaw\zcode-companion\autostart.log`（追加式，VBS 自动
  建目录；清理日志前先结束 companion 进程）。
- 内置参数：relay `wss://zcode.5945.top/ws`，node 固定路径
  `C:\Program Files\nodejs\node.exe`（缺失时回退 PATH）；companion.js 与日志路径
  相对 VBS 自身解析，仓库移动无需改脚本。需要指定 app-server 工作目录时，编辑
  VBS 启动参数追加 `--cwd <目录>`。
- 卸载：运行 `scripts\uninstall-autostart.bat`（仅移除自启，不停已在运行的进程）。
- **安全**：`autostart.log` 含配对 URL（sid + hash，持有者凭据），勿外传、勿进
  聊天/日志截图/git，参见上文安全边界。

## 手机端（wzxClaw_android / Flutter，进行中）

手机端集成在 **Flutter 原版 App**（master 主分支 `wzxClaw_android/`）中，作为与
现有"桌面 wzxClaw IDE 控制"并存的第二个模式：

- 协议层（Dart）：`lib/zcode/zcode_pairing.dart`（配对 URL 解析）+
  `lib/zcode/zcode_relay_client.dart`（probe 角色认证 + ZCode Protocol v1 RPC，
  runtime preferences 自动代答，未知反向请求默认拒绝）。
- 状态层：`lib/zcode/zcode_chat_store.dart`（配对持久化、会话列表、
  流式渲染 = 运行中轮询 `session/events` 的 `text_delta`，按 eventId 去重）。
- UI：复用 Flutter 版现有聊天组件（气泡/Markdown/工具卡片/思考指示），
  新增配对入口（复用 settings 页已有的 mobile_scanner 扫码）。
- 构建：`cd wzxClaw_android && flutter build apk`。

## 配对协议（摘要）

- device 连接 `/ws?mid=...`（头 `X-Device-ID` 同值），`device_register_init`
  {device_mid, pass_hash} → relay 派发新 `device_sid`；relay 设有注册密钥时
  必须同时携带 `register_proof = base64url(HMAC-SHA256(secret, device_mid))`；
- 双方 `auth_init`{role: device|probe, device_sid} → `auth_challenge`{nonce} →
  `auth_response`{proof}，`proof = base64url(HMAC-SHA256(pass_hash 字符串, nonce|role|sid))`；
- `auth_ack` / `pair_status_ack` 携带 pair_status waiting|matched；
- 配对后仅转发 `{type:'data', payload:<ZCode Protocol v1 帧>}`，路由按 socket 归属，
  不信任客户端指定目的地。

安全边界：错误消息通用化；nonce 单次有效；`timingSafeEqual` 比较；1 MiB 帧上限；
未认证/超限/重复角色一律断开；密钥只存内存。配对 URL 本身是持有者凭据，
不要进聊天/日志/git。

## API

`createRelay(options)`：`listen({port, host})` / 幂等 `close()`。
默认选项与上限同旧版（maxSockets=32、authTimeoutMs=10000、roomTtlMs=60000 等）；
另支持 `registrationSecret`（可选字符串，CLI 读 `REGISTRATION_SECRET` 环境变量，
设置后注册必须携带 register_proof，见上文注册密钥节）。
`createCompanion(options)`：`start()` / `stop()`（Promise，等子进程退出）、
`pairingUrl` / `state`；回调 `onPairing(url)`、`onStateChange(state)`、
`logger(event, detail)`；可注入 `zcodeCommand`（测试用假进程）与 `v2ConfigPath`；
`registrationSecret`（可选，设置后注册帧附 register_proof；CLI 从
`REGISTRATION_SECRET` 或 0600 密钥文件解析）。
反向请求超时看护分两档：`requestTimeoutMs`（默认 15000，仅实名快速方法白名单）与
`permissionRequestTimeoutMs`（默认 120000，覆盖其余未知/交互方法），两档超时后
代答 `-32022`。`stateDir` 与 `snapshotPath` 可显式注入；默认均归属
`~/.wzxclaw/zcode-companion/`。

## 大脑网络（v3 P2/P3）：已退役

`brain-adapter.js`（旧 WsEvents 协议 ↔ app-server 帧的节点侧翻译网关）及其
测试、old-relay/fake-brain 夹具、`Dockerfile.brain` 已于 2026-09-17 随
token 房间 relay 支线一并退役删除，恢复需从 git 历史取源码。
现役节点形态 = `companion.js`（哑转发，不翻译）。
